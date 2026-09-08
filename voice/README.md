# 語音問分機 - 地端語音引擎(測試版)

這是「打電話問分機」功能裡,負責「聽懂語音、查資料、講出答案」的核心引擎。全部在你的電腦上運算,**沒有呼叫任何雲端API**:

- **語音辨識(STT)**:Whisper-small模型,透過 `@xenova/transformers`(ONNX Runtime)在本機CPU執行
- **簡繁轉換**:`opencc-js`,因為Whisper預設輸出簡體字,但公司分機資料是繁體
- **查詢比對**:跟Dify工作流程裡同一套邏輯(姓名比對+同名同姓時用部門/地區縮小範圍)
- **語音合成(TTS)**:Piper(zh_CN-huayan-medium 中文女聲),本機執行

## 環境設置(第一次使用,或別人clone這個repo之後)

`voice/piper/` 和 `voice/node_modules/` 沒有放進版本控制(檔案太大),需要重新下載/安裝:

```bash
# 1. 安裝npm套件(Whisper、簡繁轉換等)
cd voice
npm install

# 2. 下載 Piper TTS 執行檔(Windows版)
mkdir -p piper/piper
curl -sSL -o piper_windows_amd64.zip https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip
unzip -o piper_windows_amd64.zip -d piper_tmp
cp -r piper_tmp/piper/* piper/piper/
rm -rf piper_tmp piper_windows_amd64.zip

# 3. 下載中文語音模型
mkdir -p piper/voices
curl -sSL -o piper/voices/zh_CN-huayan-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx
curl -sSL -o piper/voices/zh_CN-huayan-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json
```

Whisper模型(約280MB)會在第一次執行 `node ask.js` 時自動下載並快取在 `node_modules/@xenova/transformers/.cache/` 裡,之後執行就不用再下載。

## 怎麼測試

```bash
node ask.js 你的問題錄音.wav 回答.wav
```

輸入一個包含語音問題的wav檔(任何取樣率都可以,程式會自動用ffmpeg轉成Whisper需要的格式),它會印出辨識結果、查詢結果,並把語音回覆存成你指定的檔名。

### 已測試過的案例

| 測試 | 語音問題 | 結果 |
|---|---|---|
| q1.wav | 請問陳建國的分機是多少 | ✅ 正確辨識、正確查到「陳建國/8649/可取」|
| q2.wav | 陳祐萱的分機是多少 | ⚠️ Whisper誤聽成「陳佑軒」(見下方已知限制) |

## 效能(在這台筆電上實測,Intel Core 7 240H,無獨立GPU)

- 語音辨識:2~3秒(處理2~3秒長度的語音問題)
- 語音合成:0.1~0.4秒
- 單次問答總延遲(不含模型載入):約3~4秒

這個速度對「一次一通電話」的使用情境是可接受的,但因為是純CPU運算,**沒辦法同時處理很多通電話**。如果之後要支援多線同時通話,會需要更好的硬體(尤其是GPU)或改用較小的Whisper模型(base/tiny,速度換取一些準確度)。

## 已知限制:罕見姓名字容易聽錯

Whisper是通用語音辨識模型,沒有特別針對「公司內部姓名」做過訓練。從測試結果看,常見姓名(如「陳建國」)辨識得很準,但比較少見的字(如「祐萱」的「萱」)容易被聽成同音或形似的其他字(誤聽成「佑軒」)。

這是語音辨識先天的限制,純打字輸入(前面做的Dify聊天機器人)不會有這個問題,因為使用者是直接打字輸入正確的姓名。

如果之後要改善,有兩個方向(我還沒做,先列出來,需要的話再做):
1. 換更大的Whisper模型(medium/large-v3),準確度較高但速度變慢
2. 在查詢比對邏輯裡加入「拼音相似度」比對,就算文字聽錯,只要唸起來像,還是能找到對的人(例如聽成「佑軒」但拼音跟「祐萱」接近,就列為候選)

## 一個已修好的技術細節:中文資料夾路徑

這個repo的資料夾名稱「分機查詢系統」含中文字,而Piper TTS用的espeak-ng函式庫在Windows上遇到非ASCII路徑會直接失敗(`Illegal byte sequence`錯誤)。`ask.js` 裡的 `resolvePiperDir()` 會自動偵測這個狀況,把 `piper/` 整個資料夾複製一份到系統暫存目錄(全英數路徑)再從那邊執行,不需要手動處理。

## 還沒做的部分:真正的電話撥打

**這個引擎目前只能處理「一段錄音檔」,還沒有接上真正的電話線路。** 要讓同仁真的「拿起電話撥打分機查詢」,需要把這個引擎接到你們現有的電話總機系統(PBX),這部分我還需要知道:

- 你們現在用的電話總機是什麼廠牌/型號?(例如Panasonic、NEC、Avaya等硬體總機,或Asterisk/FreePBX/3CX等軟體總機)
- 這台總機能不能設定「某個分機號碼」轉接到一個外部程式(通常透過SIP Trunk或廠商提供的API)?

確認這兩點之後,我可以幫你把這個「聽懂語音→查分機→講出答案」的引擎接上真正的電話線路。在那之前,這個資料夾裡的東西可以先用「錄音檔測試」的方式驗證整套邏輯是否符合預期。
