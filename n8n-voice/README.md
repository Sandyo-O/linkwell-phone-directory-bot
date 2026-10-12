# 分機查詢 - n8n版(跟Dify版本、純前端版並存)

這是第三套獨立實作,跟 `voice/`(Dify版)、`webapp/`(純前端版)完全獨立,互不影響。功能範圍**跟Dify版本一樣完整**:查分機、語音問答、問要不要寄email、寄信。只有「查詢+email決策」這個大腦換成n8n,語音辨識(SenseVoice)、語音合成(Piper)、拼音模糊比對都直接重用 `voice/` 資料夾裡現成的東西,沒有另外複製一份。

## 跟Dify版本的差異

| | Dify版 | n8n版 |
|---|---|---|
| 自架平台 | Dify(Docker,含Postgres/Redis/Weaviate/sandbox等一大堆容器) | n8n(單一Docker容器,輕量很多) |
| 查詢/決策邏輯寫在哪 | Python code node,跑在有網路隔離的sandbox容器裡 | 一般JavaScript code node,沒有Dify sandbox那種網路隔離限制 |
| 對話狀態(問到哪一步了) | Dify自己用conversation_variables記住 | n8n工作流程本身無狀態,由 `n8n-voice/server.js` 記住每個瀏覽器分頁的{stage, pending},每次呼叫都整包傳給n8n |
| 更新流程邏輯後怎麼套用 | 舊版必須整個app刪除重新Import DSL(會清掉環境變數、API金鑰要重拿) | 直接用 `node import-workflow.js` 透過API更新同一個workflow,不會弄丟任何設定,也不用重新拿API金鑰 |
| 寄信 | Resend HTTP API(免費方案只能寄給帳號本人) | Gmail SMTP(用您自己的Gmail+應用程式密碼,可寄給任何人,每天上限約500封);也可以改接公司內部SMTP |

語音辨識、語音合成的架構、限制、地端與否,都跟Dify版完全一樣(同一份程式碼),請參考 `voice/README.md`。

## 架構

```
瀏覽器(index.html,跟Dify版幾乎一樣的介面)
  ↓ /chat, /audio/transcribe, /audio/speech
n8n-voice/server.js (port 3940,跟Dify版的3939不同,可以同時開兩個測試)
  ├─ SenseVoice sidecar (port 8766,跟Dify版的8765不同,避免衝突)
  ├─ Piper (跟Dify版共用 voice/piper/)
  └─ 呼叫 n8n webhook (帶著 message + 目前的 stage/pending 狀態)
       ↓
     n8n (Docker容器,port 5679)
       └─ workflow: Webhook → Main Logic(查詢+分類決策)→ 要寄信嗎?
            ├─ 要 → 透過 Gmail SMTP 寄信 → 組回覆
            └─ 不用 → 直接回覆
```

## 環境設置

### 1. 啟動n8n

```bash
docker run -d --name n8n-voice -p 5679:5678 \
  -v n8n_voice_data:/home/node/.n8n \
  -e N8N_SECURE_COOKIE=false \
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  n8nio/n8n
```


打開 `http://localhost:5679`,第一次會要求設定一個本機管理帳號(存在n8n自己的資料庫裡,不是第三方服務,不用擔心)。

### 2. 建立寄信用的SMTP認證、API Key,並匯入workflow

寄信用Gmail SMTP:到 https://myaccount.google.com/apppasswords(需先開啟兩步驟驗證)建立一組16碼「應用程式密碼」,然後在n8n建立一筆類型為 SMTP 的認證(host=smtp.gmail.com、port=465、SSL開啟、user=您的Gmail、password=應用程式密碼)——可以用n8n畫面(Credentials)或API(POST /api/v1/credentials)建立,**密碼只存在n8n自己的加密資料庫裡,不要寫進repo**。把該認證的id與寄件信箱存進 .env:

```
N8N_SMTP_CREDENTIAL_ID=認證id
N8N_SMTP_FROM=您的Gmail
```


1. n8n畫面裡:Settings → n8n API → Create API key,複製金鑰
2. 建立/編輯 `n8n-voice/.env`:
   ```
   N8N_WEBHOOK_URL=http://localhost:5679/webhook/ext-lookup
   N8N_API_KEY=剛剛複製的金鑰
   ```
3. 執行:
   ```bash
   cd n8n-voice
   node build-workflow.js    # 從 voice/directory.json 產生 workflow.json
   node import-workflow.js   # 匯入並發布(啟用)workflow
   ```
4. `import-workflow.js` 第一次執行完,會印出一行 `N8N_WORKFLOW_ID=xxx`,把它加進 `.env` 裡——之後修改 `build-workflow.js` 重新產生+匯入時,就會**直接更新同一個workflow**,不會每次都新增一份。

### 3. 安裝npm套件、啟動伺服器

`n8n-voice` 本身不需要自己的 `node_modules`(`qrcode`、`core.js`、`lookup.js` 都是直接引用 `../voice/` 裡現成的),只要 `voice/` 資料夾已經照它自己的README裝好(`npm install`、Piper、Python環境),直接執行:

```bash
cd n8n-voice
node server.js
```

或雙擊 `啟動語音測試.bat`。打開 `http://localhost:3940`。

## 之後要更新分機資料

跟其他兩版一樣,更新 `voice/directory.json` 後:

```bash
cd n8n-voice
node build-workflow.js
node import-workflow.js
```

不需要重開n8n容器、不需要重新設定API Key,幾秒鐘就套用完成——這是比Dify版方便的地方(Dify版每次都要整個app刪除重新匯入)。

## 重要取捨

語音辨識/合成跟Dify版完全一樣(同一份SenseVoice/Piper);寄信改走Gmail SMTP(資料會經過Google伺服器,一樣不是全地端),請參考 `voice/README.md` 和 `使用說明.md`。n8n本身沒有引入新的資安/隱私取捨,純粹是換一個自架平台。
