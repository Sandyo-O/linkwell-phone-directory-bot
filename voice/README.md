# 語音問分機 - 地端語音引擎(測試版)

這是「打電話問分機」功能裡,負責「聽懂語音、查資料、講出答案」的核心引擎。全部在你的電腦上運算,**沒有呼叫任何雲端API**:

- **語音辨識(STT)**:SenseVoice-small模型(阿里巴巴FunASR),透過一個常駐的Python小型服務(`sensevoice_server.py`)在本機CPU執行,`server.js`啟動時會自動幫你啟動這個服務。原本用Whisper-small(`@xenova/transformers`),測試發現SenseVoice在真實姓名上準確度打平,但速度快了約10~15倍,所以換掉了(細節見下面「效能」)
- **簡繁轉換**:`opencc-js`,因為SenseVoice/Whisper預設輸出簡體字,但公司分機資料是繁體
- **查詢比對**:跟Dify工作流程裡同一套邏輯(姓名比對+同名同姓時用部門/地區縮小範圍),另外加了**拼音模糊比對**當備援:如果Whisper把姓名的字聽錯,但唸起來的音接近資料庫裡的姓名,還是抓得到人(例如「史印辰」被聽成「是硬沉」,拼音幾乎一樣,還是能查到);查到後會誠實告訴你「我聽起來像是問XX,如果沒聽錯...」,不會裝作聽得很準
- **語音合成(TTS)**:Piper(zh_CN-huayan-medium 中文女聲),本機執行

## 環境設置(第一次使用,或別人clone這個repo之後)

`voice/piper/` 和 `voice/node_modules/` 沒有放進版本控制(檔案太大),需要重新下載/安裝:

```bash
# 1. 安裝npm套件(簡繁轉換、拼音比對等)
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

# 4. 安裝Python(語音辨識SenseVoice需要),裝好後裝Python套件
#    Windows可以用winget: winget install Python.Python.3.11
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
```

SenseVoice模型(約900MB)會在第一次啟動 `node server.js` 時自動下載並快取在 `~/.cache/modelscope/` 裡,之後執行就不用再下載。`server.js` 啟動時會自動把 `sensevoice_server.py` 當成子行程一起啟動,不需要手動另外執行。

## 怎麼測試

```bash
node ask.js 你的問題錄音.wav 回答.wav
```

輸入一個包含語音問題的wav檔(任何取樣率都可以,程式會自動用ffmpeg轉成Whisper需要的格式),它會印出辨識結果、查詢結果,並把語音回覆存成你指定的檔名。

### 已測試過的案例

| 測試 | 語音問題 | 結果 |
|---|---|---|
| q1.wav | 請問陳建國的分機是多少 | ✅ SenseVoice正確辨識、正確查到「陳建國/8649/可取」|
| q2.wav | 陳祐萱的分機是多少 | ✅ SenseVoice誤聽成「陳又萱」,拼音模糊比對抓回「陳祐萱」|
| (使用者實測) | 史印辰的分機號碼 | ✅ (Whisper時期的測試)誤聽成「是硬沉」,拼音模糊比對正確抓到「史印辰/4533/台中」|

換成SenseVoice前,拿同一批錄音檔跟Whisper-small、Whisper-base側面比較過:base雖然快一倍,但在「陳建國」這個測試上把名字聽成兩個完全不同的人(拼音模糊比對也救不回來),所以沒有選base;SenseVoice則是準確度打平small、速度大幅超越,才正式换掉。

## 效能(在這台筆電上實測,Intel Core 7 240H,無獨立GPU)

- 語音辨識(SenseVoice):約0.1~0.2秒(模型只在伺服器啟動時載入一次,之後每次問答都是熱的)
- 語音合成(Piper,常駐行程模式):約1.5秒
- 單次問答總延遲(不含模型載入,含跟Dify的網路來回):約2秒左右

換成SenseVoice、Piper改常駐行程之前,分別是Whisper-small約2~3秒、Piper每次重啟約2秒,總延遲約4~5秒。純CPU運算,**還是沒辦法同時處理很多通電話**,但單次問答的體感已經快很多。

## 已知限制:罕見姓名字容易聽錯(已用拼音模糊比對緩解)

不管是Whisper還是SenseVoice,都是通用語音辨識模型,沒有特別針對「公司內部姓名」做過訓練。從測試結果看,常見姓名(如「陳建國」)辨識得很準,但比較少見的字(如「祐萱」的「萱」、「印辰」)容易被聽成同音或形似的其他字。

**現在的做法**:`lookup.js` 在文字完全比對不到人的時候,會退而求其次比對拼音——把辨識結果轉成拼音,跟資料庫裡每個姓名的拼音算「編輯距離」,唸起來夠接近的話就當作候選人。這樣就算STT把字聽錯,只要音沒差太多,還是抓得到對的人。`server.js` 會用這個修正過的姓名去問Dify,而不是原始(可能聽錯的)文字。純打字模式下機器人原本會誠實說「我聽起來像是問XX,如果沒聽錯...」,現在Dify那邊拿到的已經是修正後的正確姓名,所以是直接查到、不會特別提示這是猜的——這是目前的取捨,如果你更希望使用者也知道「這是拼音猜的」,可以再讓我加回這個提示。

為了避免亂猜(例如隨便一句話裡剛好有幾個字拼音很像「機房」這種2個字的短名字/地點),做了幾個防呆:
- 只對「拿掉標點後只剩2~4個中文字」的名字做拼音比對,排除「CDO」「TEL」這類混進資料裡的英文縮寫
- 2個字的短名字要求拼音完全一樣才算,3~4個字的名字才允許1~2個字母的誤差
- 找到很接近的答案(誤差0~1)就不再放寬去抓其他普通接近的候選人,避免真正對的人被一堆不相關的人稀釋掉

這個機制純打字輸入(前面做的Dify聊天機器人)不需要,因為使用者是直接打字輸入正確的姓名,不會有「聽錯字」的問題。

如果之後準確度還是不夠,可以評估funasr其他模型(SenseVoice-large等),但要注意越大的模型通常越慢——目前SenseVoice-small在準確度和速度上算是不錯的平衡點。

## 一個已修好的技術細節:中文資料夾路徑

這個repo的資料夾名稱「分機查詢系統」含中文字,而Piper TTS用的espeak-ng函式庫在Windows上遇到非ASCII路徑會直接失敗(`Illegal byte sequence`錯誤)。`ask.js` 裡的 `resolvePiperDir()` 會自動偵測這個狀況,把 `piper/` 整個資料夾複製一份到系統暫存目錄(全英數路徑)再從那邊執行,不需要手動處理。

## 還沒做的部分:真正的電話撥打

**這個引擎目前只能處理「一段錄音檔」,還沒有接上真正的電話線路。** 要讓同仁真的「拿起電話撥打分機查詢」,需要把這個引擎接到你們現有的電話總機系統(PBX),這部分我還需要知道:

- 你們現在用的電話總機是什麼廠牌/型號?(例如Panasonic、NEC、Avaya等硬體總機,或Asterisk/FreePBX/3CX等軟體總機)
- 這台總機能不能設定「某個分機號碼」轉接到一個外部程式(通常透過SIP Trunk或廠商提供的API)?

確認這兩點之後,我可以幫你把這個「聽懂語音→查分機→講出答案」的引擎接上真正的電話線路。在那之前,這個資料夾裡的東西可以先用「錄音檔測試」的方式驗證整套邏輯是否符合預期。
