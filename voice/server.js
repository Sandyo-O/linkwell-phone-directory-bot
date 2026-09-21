const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const QRCode = require('qrcode');
const { convertToWavFile, transcribeSenseVoice, synthesize, toSpokenText, s2t } = require('./core');
const { lookup } = require('./lookup');

// SenseVoice needs Python (funasr) - runs as a persistent sidecar process so
// the model only loads once, not per request. See sensevoice_server.py for
// why: it's ~15x faster than the Whisper model this replaced, at the same
// accuracy on real employee names (tested side-by-side before switching).
const PYTHON_EXE = (() => {
  const wingetDefault = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe');
  return fs.existsSync(wingetDefault) ? wingetDefault : 'python';
})();

function startSenseVoiceSidecar() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_EXE, ['-u', path.join(__dirname, 'sensevoice_server.py')], {
      cwd: __dirname,
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

// Dify's own lookup only does exact substring matching on the name - it
// doesn't have the pinyin fuzzy-matching data/logic this project already
// built for voice input (Whisper mis-hearing a rare character but getting
// the sound roughly right, e.g. "史印辰" heard as "是硬沉"), and porting the
// whole pinyin dataset into Dify's restricted Python sandbox isn't practical.
// So: run the query through the local fuzzy matcher first: only when the
// exact match finds nothing AND the fuzzy match confidently lands on exactly
// one person, swap the query for that person's real name before asking Dify
// - otherwise (already an exact match, no match at all, or an ambiguous
// fuzzy match) pass the message through unchanged, so this never interferes
// with non-name replies like "要"/"不用"/an email address.
function correctMishearName(message) {
  const result = lookup(message);
  // status 'multiple' + sameName just means several department entries for
  // the ONE person the fuzzy match found (Dify's own multi-department
  // handling takes it from there) - only leave the message uncorrected when
  // the fuzzy match is genuinely ambiguous between two different people.
  if (result.fuzzy && (result.status === 'single' || result.sameName)) return result.name;
  return message;
}

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

async function askDify(message, browserConversationId, defaultEmail) {
  const difyConversationId = difyConversations.get(browserConversationId) || '';
  const response = await fetch(`${DIFY_API_BASE}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DIFY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // default_email only actually gets used by the workflow when the user
      // says "yes, send it" without including an address - harmless to send
      // on every turn.
      inputs: { default_email: defaultEmail || '' },
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

// Re-detect on every call rather than caching once at startup - laptops
// change networks (different Wi-Fi, hotspot on/off) far more often than this
// server gets restarted, and a stale cached IP just silently serves a QR
// code/URL that no longer points at this machine.
function currentLanUrl() {
  const ip = findLanIp();
  return ip ? `http://${ip}:${PORT}` : null;
}

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
        const inputPath = path.join(os.tmpdir(), `voice-in-${Date.now()}.${extension}`);
        const wavPath = `${inputPath}.sensevoice.wav`;
        try {
          const t0 = Date.now();
          fs.writeFileSync(inputPath, data);
          convertToWavFile(inputPath, wavPath);
          const t1 = Date.now();
          const rawText = await transcribeSenseVoice(wavPath);
          const t2 = Date.now();
          const text = s2t(rawText.trim());
          console.log(`[timing] transcribe: ffmpeg=${t1 - t0}ms sensevoice=${t2 - t1}ms total=${t2 - t0}ms audioBytes=${data.length}`);
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
        const outputPath = path.join(os.tmpdir(), `voice-speech-${Date.now()}.wav`);
        try {
          const t0 = Date.now();
          await synthesize(toSpokenText(text), outputPath);
          const t1 = Date.now();
          const audioBuf = fs.readFileSync(outputPath);
          console.log(`[timing] speech: piper=${t1 - t0}ms textLen=${text.length}`);
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
          const t0 = Date.now();
          const correctedMessage = correctMishearName(message);
          const t1 = Date.now();
          const reply = await askDify(correctedMessage, conversationId, defaultEmail);
          const t2 = Date.now();
          console.log(`[timing] chat: fuzzyCheck=${t1 - t0}ms dify=${t2 - t1}ms`);
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
    const lanUrl = currentLanUrl();
    console.log(`\n打開瀏覽器到 http://localhost:${PORT} 開始測試`);
    console.log(lanUrl ? `區網其他裝置可連到 ${lanUrl}(或掃描頁面上的QR code,換網路後重新點一次會自動更新)\n` : '找不到區網IP,其他裝置可能無法連線\n');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
