const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { loadWhisperModel, loadAudioAsFloat32, synthesize, toSpokenText, s2t } = require('./core');

// Pick the machine's own LAN-facing IPv4 address, so people on other devices
// on the same office network can scan a QR code to reach this tool. Windows
// also reports Docker/Hyper-V/WSL virtual switches as non-internal interfaces -
// skip those, since other devices on the real network can't reach them.
const VIRTUAL_IFACE_PATTERN = /vEthernet|Virtual|Loopback|Default Switch|docker|WSL/i;
function findLanIp() {
  const interfaces = Object.entries(os.networkInterfaces());
  const real = interfaces.filter(([name]) => !VIRTUAL_IFACE_PATTERN.test(name));
  for (const [, iface] of [...real, ...interfaces]) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// Minimal .env loader (no dotenv dependency) - just DIFY_API_KEY/DIFY_API_BASE.
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
}

const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_API_BASE = process.env.DIFY_API_BASE || 'http://localhost/v1';
if (!DIFY_API_KEY) {
  throw new Error('voice/.env 裡沒有設定 DIFY_API_KEY,請先取得Dify app的API金鑰。');
}

// Dify owns the conversation memory (pending lookup, email step, etc). The browser
// tab generates its own random id per page load; we just need to remember which
// real Dify conversation_id that maps to so multi-turn replies (e.g. "寄到我的
// email") stay in the same conversation.
const difyConversations = new Map();

async function askDify(message, browserConversationId) {
  const difyConversationId = difyConversations.get(browserConversationId) || '';
  const response = await fetch(`${DIFY_API_BASE}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DIFY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: {},
      query: message,
      response_mode: 'blocking',
      conversation_id: difyConversationId,
      user: browserConversationId,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || `Dify回應錯誤 (${response.status})`);
  }
  if (data.conversation_id) {
    difyConversations.set(browserConversationId, data.conversation_id);
  }
  return data.answer;
}

const PORT = 3939;
const HOST = '0.0.0.0'; // bind all interfaces - approved for use over the office LAN (QR-code kiosk access)
const LAN_IP = findLanIp();
const LAN_URL = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
// MediaRecorder's mime type tells ffmpeg what container to expect; ffmpeg can
// usually sniff the real format anyway, but a matching extension avoids edge
// cases with some containers.
const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function main() {
  console.log('載入本機Whisper模型(第一次啟動可能要等一下)...');
  const transcriber = await loadWhisperModel();
  console.log('模型載入完成,啟動伺服器...');

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(INDEX_HTML);
        return;
      }

      if (req.method === 'POST' && req.url === '/audio/transcribe') {
        const mime = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        const extension = AUDIO_EXTENSIONS[mime] || 'webm';
        let data;
        try {
          data = await readBody(req, MAX_AUDIO_BYTES);
        } catch (e) {
          sendJson(res, e.statusCode || 400, { detail: '錄音過大,請縮短錄音後重試。' });
          return;
        }
        if (!data.length) {
          sendJson(res, 400, { detail: '沒有收到錄音,請重新錄製。' });
          return;
        }
        const inputPath = path.join(os.tmpdir(), `voice-in-${Date.now()}.${extension}`);
        try {
          fs.writeFileSync(inputPath, data);
          const audio = await loadAudioAsFloat32(inputPath);
          const sttResult = await transcriber(audio, { language: 'chinese', task: 'transcribe' });
          const text = s2t(sttResult.text.trim());
          if (!text) {
            sendJson(res, 422, { detail: '未辨識到語音,請靠近麥克風重新錄製。' });
            return;
          }
          sendJson(res, 200, { text });
        } catch (e) {
          console.error(e);
          sendJson(res, 502, { detail: '語音辨識失敗,請稍後再試。' });
        } finally {
          fs.rmSync(inputPath, { force: true });
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/audio/speech') {
        let bodyBuf;
        try {
          bodyBuf = await readBody(req, 1024 * 1024);
        } catch (e) {
          sendJson(res, 413, { detail: '文字過長。' });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(bodyBuf.toString('utf8'));
        } catch (e) {
          sendJson(res, 400, { detail: '請求格式錯誤。' });
          return;
        }
        const text = (payload.text || '').trim();
        if (!text) {
          sendJson(res, 400, { detail: '朗讀文字不可空白。' });
          return;
        }
        if (text.length > 600) {
          sendJson(res, 400, { detail: '單次朗讀文字過長。' });
          return;
        }
        const outputPath = path.join(os.tmpdir(), `voice-speech-${Date.now()}.wav`);
        try {
          synthesize(toSpokenText(text), outputPath);
          const audioBuf = fs.readFileSync(outputPath);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
          res.end(audioBuf);
        } catch (e) {
          console.error(e);
          sendJson(res, 502, { detail: '語音合成失敗。' });
        } finally {
          fs.rmSync(outputPath, { force: true });
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/chat') {
        let bodyBuf;
        try {
          bodyBuf = await readBody(req, 1024 * 1024);
        } catch (e) {
          sendJson(res, 413, { detail: '訊息過長。' });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(bodyBuf.toString('utf8'));
        } catch (e) {
          sendJson(res, 400, { detail: '請求格式錯誤。' });
          return;
        }
        const message = (payload.message || '').trim();
        const conversationId = (payload.conversation_id || '').trim();
        if (!message) {
          sendJson(res, 400, { detail: '請輸入問題。' });
          return;
        }
        if (!conversationId) {
          sendJson(res, 400, { detail: '缺少session id。' });
          return;
        }
        try {
          const reply = await askDify(message, conversationId);
          sendJson(res, 200, { reply });
        } catch (e) {
          console.error(e);
          sendJson(res, 502, { detail: '無法連上查詢服務,請稍後再試。' });
        }
        return;
      }

      if (req.method === 'GET' && req.url === '/lan-url') {
        sendJson(res, 200, { url: LAN_URL });
        return;
      }

      if (req.method === 'GET' && req.url.split('?')[0] === '/qrcode.png') {
        if (!LAN_URL) {
          res.writeHead(404);
          res.end('找不到區網IP');
          return;
        }
        try {
          const pngBuf = await QRCode.toBuffer(LAN_URL, { width: 320, margin: 2 });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          res.end(pngBuf);
        } catch (e) {
          console.error(e);
          res.writeHead(500);
          res.end('QR code產生失敗');
        }
        return;
      }

      // static assets under /public, if the page ever references any
      if (req.method === 'GET' && req.url.startsWith('/public/')) {
        const filePath = path.join(PUBLIC_DIR, req.url.replace('/public/', ''));
        if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath)) {
          res.writeHead(200);
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { detail: '伺服器發生錯誤。' });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n打開瀏覽器到 http://localhost:${PORT} 開始測試`);
    console.log(LAN_URL ? `區網其他裝置可連到 ${LAN_URL}(或掃描頁面上的QR code)\n` : '找不到區網IP,其他裝置可能無法連線\n');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
