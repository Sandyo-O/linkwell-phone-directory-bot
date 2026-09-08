const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { loadWhisperModel, answerFromAudioFile } = require('./core');

const PORT = 3939;
const HOST = '127.0.0.1'; // loopback only - this is a local test tool for whoever is at this machine

const PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<title>語音問分機(本機測試)</title>
<style>
  body { font-family: -apple-system, "Microsoft JhengHei", sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 1.4em; }
  button { font-size: 1.1em; padding: 16px 32px; border-radius: 999px; border: none; cursor: pointer; }
  #recBtn { background: #d6336c; color: white; }
  #recBtn.recording { background: #495057; }
  #recBtn:disabled { background: #ced4da; cursor: not-allowed; }
  #status { margin: 16px 0; color: #555; min-height: 1.5em; }
  .box { background: #f8f9fa; border-radius: 12px; padding: 16px; margin-top: 16px; white-space: pre-wrap; }
  .label { font-weight: bold; color: #888; font-size: 0.85em; }
</style>
</head>
<body>
<h1>📞 語音問分機(本機測試工具)</h1>
<p>按住下面的按鈕說話(例如「請問陳建國的分機是多少」),放開後會自動辨識、查詢、念出答案。全部在這台電腦上運算,沒有送到任何雲端。</p>
<button id="recBtn">🎙️ 按住說話</button>
<div id="status"></div>
<div id="result" class="box" style="display:none">
  <div><span class="label">聽到的內容:</span> <span id="recognized"></span></div>
  <div style="margin-top:8px"><span class="label">回覆:</span> <span id="answerText"></span></div>
  <audio id="answerAudio" controls autoplay style="width:100%; margin-top:12px"></audio>
</div>

<script>
const btn = document.getElementById('recBtn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
let mediaRecorder, chunks = [], stream;

async function startRec() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    statusEl.textContent = '無法取得麥克風權限:' + e.message;
    return;
  }
  chunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  btn.classList.add('recording');
  btn.textContent = '🔴 錄音中...放開送出';
  statusEl.textContent = '';
}

function stopRec() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  btn.classList.remove('recording');
  btn.textContent = '🎙️ 按住說話';
}

async function onRecordingStop() {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  if (blob.size < 500) {
    statusEl.textContent = '錄音太短了,再試一次';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = '辨識中,請稍候(通常幾秒鐘)...';
  resultEl.style.display = 'none';
  try {
    const res = await fetch('/ask', { method: 'POST', body: blob });
    if (!res.ok) throw new Error('伺服器錯誤: ' + res.status);
    const data = await res.json();
    document.getElementById('recognized').textContent = data.recognized_question;
    document.getElementById('answerText').textContent = data.answer_text;
    document.getElementById('answerAudio').src = data.answer_audio_url;
    resultEl.style.display = 'block';
    statusEl.textContent = '完成!(辨識耗時 ' + data.stt_ms + 'ms)';
  } catch (e) {
    statusEl.textContent = '發生錯誤:' + e.message;
  } finally {
    btn.disabled = false;
  }
}

btn.addEventListener('mousedown', startRec);
btn.addEventListener('touchstart', (e) => { e.preventDefault(); startRec(); });
btn.addEventListener('mouseup', stopRec);
btn.addEventListener('mouseleave', () => { if (mediaRecorder && mediaRecorder.state === 'recording') stopRec(); });
btn.addEventListener('touchend', stopRec);
</script>
</body>
</html>`;

async function main() {
  console.log('載入本機Whisper模型(第一次啟動可能要等一下)...');
  const transcriber = await loadWhisperModel();
  console.log('模型載入完成,啟動伺服器...');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (req.method === 'POST' && req.url === '/ask') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const inputPath = path.join(os.tmpdir(), `voice-in-${Date.now()}.webm`);
        const outputPath = path.join(os.tmpdir(), `voice-out-${Date.now()}.wav`);
        const debugCopy = path.join(__dirname, 'last-received.webm');
        try {
          const buf = Buffer.concat(chunks);
          fs.writeFileSync(inputPath, buf);
          fs.writeFileSync(debugCopy, buf); // kept for debugging, overwritten each request
          console.log(`[/ask] received ${buf.length} bytes`);
          const result = await answerFromAudioFile(transcriber, inputPath, outputPath);
          console.log(`[/ask] recognized: "${result.recognized_question}"`);
          const audioBuf = fs.readFileSync(outputPath);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ...result,
              answer_audio_url: 'data:audio/wav;base64,' + audioBuf.toString('base64'),
            })
          );
        } catch (e) {
          console.error(e);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String(e) }));
        } finally {
          fs.rmSync(inputPath, { force: true });
          fs.rmSync(outputPath, { force: true });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n打開瀏覽器到 http://localhost:${PORT} 開始用麥克風測試\n`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
