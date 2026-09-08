const { pipeline } = require('@xenova/transformers');
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OpenCC = require('opencc-js');
const { lookup } = require('./lookup');

// Whisper transcribes Mandarin as Simplified Chinese by default, but our
// company directory is in Traditional Chinese (Taiwan) - convert before matching.
const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });

// Manual recursive copy - Node's built-in fs.cpSync(..., {recursive:true}) reliably
// segfaults on this platform when copying piper's nested espeak-ng-data/ (355 files),
// so we walk the tree ourselves with plain readdirSync/copyFileSync instead.
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// piper.exe's espeak-ng backend fails ("Illegal byte sequence") when run from a
// path containing non-ASCII characters (e.g. this repo's "分機查詢系統" folder name).
// If we're not in an ASCII-safe location, mirror voice/piper/ once into a stable
// ASCII temp directory and run piper.exe from there instead.
function resolvePiperDir() {
  const localPiperDir = path.join(__dirname, 'piper');
  if (/^[\x00-\x7F]*$/.test(__dirname)) {
    return localPiperDir; // current path is already ASCII-only, no copy needed
  }
  const stableDir = path.join(os.tmpdir(), 'linkwell-phonebot-piper');
  const marker = path.join(stableDir, '.copied-from');
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== localPiperDir) {
    fs.rmSync(stableDir, { recursive: true, force: true });
    copyDirRecursive(localPiperDir, stableDir);
    fs.writeFileSync(marker, localPiperDir, 'utf8');
  }
  return stableDir;
}

const PIPER_DIR = resolvePiperDir();
const PIPER_EXE = path.join(PIPER_DIR, 'piper', 'piper.exe');
const PIPER_VOICE = path.join(PIPER_DIR, 'voices', 'zh_CN-huayan-medium.onnx');

async function loadAudioAsFloat32(wavPath) {
  const rawPath = wavPath + '.f32.raw';
  execSync(`ffmpeg -y -i "${wavPath}" -ar 16000 -ac 1 -f f32le "${rawPath}"`, { stdio: 'pipe' });
  const buf = fs.readFileSync(rawPath);
  const floatArray = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  fs.unlinkSync(rawPath);
  return floatArray;
}

function synthesize(text, outWavPath) {
  const absOut = path.resolve(outWavPath);
  execFileSync(PIPER_EXE, ['--model', PIPER_VOICE, '--output_file', absOut], {
    input: text,
    cwd: path.dirname(PIPER_EXE),
  });
}

function buildAnswerText(result) {
  if (result.status === 'single') {
    return `查到了。${result.name}的分機是${result.ext},部門是${result.dept || '未標示'},地區是${result.loc || '未標示'}。`;
  }
  if (result.status === 'multiple') {
    if (result.sameName) {
      return `查到${result.count}位同名同姓的${result.name},分屬不同部門。第一位是${result.dept || '未標示部門'}的${result.name},分機${result.ext}。請說出部門名稱來確認是哪一位。`;
    }
    return `找到${result.count}筆符合的同仁,請說出更完整的姓名。`;
  }
  return '抱歉,查無此人,請確認姓名是否正確。';
}

async function main() {
  const inputWav = process.argv[2];
  const outputWav = process.argv[3] || 'answer.wav';
  if (!inputWav) {
    console.error('usage: node ask.js <question.wav> [answer.wav]');
    process.exit(1);
  }

  console.error('[1/4] 載入本機Whisper模型 (Xenova/whisper-small)...');
  const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
    quantized: true,
  });

  console.error('[2/4] 語音辨識中(全部在本機執行)...');
  const audio = await loadAudioAsFloat32(inputWav);
  const t0 = Date.now();
  const sttResult = await transcriber(audio, { language: 'chinese', task: 'transcribe' });
  const sttMs = Date.now() - t0;
  const questionTextRaw = sttResult.text.trim();
  const questionText = s2t(questionTextRaw);
  console.error(`      辨識結果(簡體): "${questionTextRaw}"`);
  console.error(`      轉換為繁體後: "${questionText}" (耗時 ${sttMs}ms)`);

  console.error('[3/4] 查詢分機資料庫(本機比對,1206筆資料)...');
  const result = lookup(questionText);
  const answerText = buildAnswerText(result);
  console.error(`      查詢狀態: ${result.status}, 回答內容: "${answerText}"`);

  console.error('[4/4] 語音合成中(本機Piper TTS)...');
  synthesize(answerText, outputWav);
  console.error(`完成!語音回覆已存到: ${outputWav}`);

  console.log(
    JSON.stringify(
      {
        recognized_question: questionText,
        stt_ms: sttMs,
        lookup_status: result.status,
        answer_text: answerText,
        answer_wav: outputWav,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
