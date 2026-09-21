// n8n version of the voice/Dify server - a separate, parallel implementation
// that doesn't touch voice/server.js at all. Reuses voice/core.js, lookup.js,
// piper/, and public/index.html directly via relative require()/paths rather
// than duplicating them, so there's only one copy of the large binary assets
// (Piper models) and one place to fix STT/TTS bugs.
//
// Runs its own SenseVoice sidecar on a different port (SENSEVOICE_PORT) so
// this can run at the same time as voice/server.js without a port clash -
// process.env must be set before requiring core.js, since core.js reads it
// once at module load.
process.env.SENSEVOICE_PORT = process.env.SENSEVOICE_PORT || '8766';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const QRCode = require('../voice/node_modules/qrcode');
const { convertToWavFile, transcribeSenseVoice, synthesize, toSpokenText, s2t } = require('../voice/core');
const { lookup } = require('../voice/lookup');

const PYTHON_EXE = (() => {
  const wingetDefault = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe');
  return fs.existsSync(wingetDefault) ? wingetDefault : 'python';
})();

function startSenseVoiceSidecar() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_EXE, ['-u', path.join(__dirname, '..', 'voice', 'sensevoice_server.py')], {
      cwd: path.join(__dirname, '..', 'voice'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let settled = false;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      console.log(`[sensevoice] ${line}`);
      if (!settled && line.includes('[ready]')) {
        settled = true;
        resolve(proc);
      }
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => console.error(`[sensevoice] ${line}`));
    proc.on('exit', (code) => {
      console.error(`[sensevoice] 行程意外結束 (code ${code})`);
      if (!settled) {
        settled = true;
        reject(new Error('SenseVoice服務啟動失敗'));
      }
    });
  });
}

// Same fuzzy-correction pre-pass as voice/server.js does for Dify - see that
// file's comment for the full reasoning. n8n's workflow, like Dify's, only
// ever does exact-match lookup; the pinyin fuzzy matching happens here.
function correctMishearName(message) {
  const result = lookup(message);
  if (result.fuzzy && (result.status === 'single' || result.sameName)) return result.name;
  return message;
}

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

for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
}

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
if (!N8N_WEBHOOK_URL) {
  throw new Error('n8n-voice/.env 裡沒有設定 N8N_WEBHOOK_URL。');
}

// n8n's workflow is stateless (no Dify-style conversation_id) - the browser's
// per-tab id maps to {stage, pending} here instead, and we send that whole
// bit of state back to n8n on every call for it to act on and update.
const conversationState = new Map();

async function askN8n(message, browserConversationId, defaultEmail) {
  const state = conversationState.get(browserConversationId) || { stage: '', pending: {} };
  const response = await fetch(N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      stage: state.stage,
      pending: state.pending,
      default_email: defaultEmail || '',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || `n8n回應錯誤 (${response.status})`);
  }
  conversationState.set(browserConversationId, { stage: data.stage || '', pending: data.pending || {} });
  return data.reply;
}

const PORT = 3940; // different from voice/server.js's 3939, so both can run together
const HOST = '0.0.0.0';

function currentLanUrl() {
  const ip = findLanIp();
  return ip ? `http://${ip}:${PORT}` : null;
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
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
  console.log('啟動SenseVoice語音辨識服務(第一次啟動要下載模型,可能要等一下)...');
  await startSenseVoiceSidecar();
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
        const inputPath = path.join(os.tmpdir(), `n8n-voice-in-${Date.now()}.${extension}`);
        const wavPath = `${inputPath}.sensevoice.wav`;
        try {
          fs.writeFileSync(inputPath, data);
          convertToWavFile(inputPath, wavPath);
          const rawText = await transcribeSenseVoice(wavPath);
          const text = s2t(rawText.trim());
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
          fs.rmSync(wavPath, { force: true });
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
        const outputPath = path.join(os.tmpdir(), `n8n-voice-speech-${Date.now()}.wav`);
        try {
          await synthesize(toSpokenText(text), outputPath);
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
        const defaultEmail = (payload.default_email || '').trim();
        if (!message) {
          sendJson(res, 400, { detail: '請輸入問題。' });
          return;
        }
        if (!conversationId) {
          sendJson(res, 400, { detail: '缺少session id。' });
          return;
        }
        try {
          const correctedMessage = correctMishearName(message);
          const reply = await askN8n(correctedMessage, conversationId, defaultEmail);
          sendJson(res, 200, { reply });
        } catch (e) {
          console.error(e);
          sendJson(res, 502, { detail: '無法連上查詢服務,請稍後再試。' });
        }
        return;
      }

      if (req.method === 'GET' && req.url === '/lan-url') {
        sendJson(res, 200, { url: currentLanUrl() });
        return;
      }

      if (req.method === 'GET' && req.url.split('?')[0] === '/qrcode.png') {
        const lanUrl = currentLanUrl();
        if (!lanUrl) {
          res.writeHead(404);
          res.end('找不到區網IP');
          return;
        }
        try {
          const pngBuf = await QRCode.toBuffer(lanUrl, { width: 320, margin: 2 });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          res.end(pngBuf);
        } catch (e) {
          console.error(e);
          res.writeHead(500);
          res.end('QR code產生失敗');
        }
        return;
      }

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
    const lanUrl = currentLanUrl();
    console.log(`\n打開瀏覽器到 http://localhost:${PORT} 開始測試`);
    console.log(lanUrl ? `區網其他裝置可連到 ${lanUrl}(或掃描頁面上的QR code)\n` : '找不到區網IP,其他裝置可能無法連線\n');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
