const { pipeline } = require('@xenova/transformers');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
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

async function loadAudioAsFloat32(inputPath) {
  const rawPath = inputPath + '.f32.raw';
  execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -f f32le "${rawPath}"`, { stdio: 'pipe' });
  const buf = fs.readFileSync(rawPath);
  const floatArray = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  fs.unlinkSync(rawPath);
  return floatArray;
}

// SenseVoice (via the local Python sidecar, sensevoice_server.py) needs an
// actual WAV file on disk, not the raw Float32Array Whisper wants.
function convertToWavFile(inputPath, outWavPath) {
  execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 "${outWavPath}"`, { stdio: 'pipe' });
}

// Configurable so a second server instance (e.g. n8n-voice/server.js) can run
// its own sidecar on a different port without colliding with this one.
const SENSEVOICE_PORT = process.env.SENSEVOICE_PORT || '8765';
async function transcribeSenseVoice(wavPath) {
  const response = await fetch(`http://127.0.0.1:${SENSEVOICE_PORT}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wav_path: path.resolve(wavPath) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`SenseVoice服務回應錯誤 (${response.status})`);
  const data = await response.json();
  return data.text;
}

// Keep one piper process running and feed it one JSON line per request
// (--json-input) instead of spawning a fresh process per call - re-spawning
// piper pays ~0.3-0.5s just to reload the voice model every single time,
// which dominates the cost for short answers. In this mode piper prints the
// output_file path to stdout as each line finishes, in the same order the
// lines were submitted, so a plain FIFO queue is enough to match completions
// back to the right caller - no need to parse the path itself.
let piperProcess = null;
let piperQueue = [];

function startPiperProcess() {
  const proc = spawn(PIPER_EXE, ['--model', PIPER_VOICE, '--json-input'], {
    cwd: path.dirname(PIPER_EXE),
  });
  readline.createInterface({ input: proc.stdout }).on('line', () => {
    const pending = piperQueue.shift();
    if (pending) pending.resolve();
  });
  proc.on('exit', (code) => {
    const failed = piperQueue.splice(0);
    failed.forEach((p) => p.reject(new Error(`piper行程意外結束(code ${code})`)));
    if (piperProcess === proc) piperProcess = null;
  });
  proc.stdin.on('error', () => {}); // avoid crashing on EPIPE if the process died mid-write
  return proc;
}

function synthesize(text, outWavPath) {
  if (!piperProcess) piperProcess = startPiperProcess();
  const absOut = path.resolve(outWavPath);
  return new Promise((resolve, reject) => {
    piperQueue.push({ resolve, reject });
    piperProcess.stdin.write(JSON.stringify({ text, output_file: absOut }) + '\n');
  });
}

// Group candidates by extension first - a shared assistant/secretary often
// covers several departments on one phone line, so listing the same
// extension over and over is redundant. Distinct extensions still get
// listed one by one (those are genuinely different lines/people).
function groupByExtension(matches) {
  const order = [];
  const groups = new Map();
  for (const m of matches) {
    if (!groups.has(m.ext)) {
      groups.set(m.ext, []);
      order.push(m.ext);
    }
    groups.get(m.ext).push(m);
  }
  return order.map((ext) => ({ ext, items: groups.get(ext) }));
}

function speakCandidateList(matches) {
  const groups = groupByExtension(matches);
  return groups
    .map((g, i) => {
      const name = g.items[0].name;
      if (g.items.length === 1) {
        return `第${i + 1}位,${g.items[0].dept || '未標示部門'}的${name},分機${g.ext}`;
      }
      const depts = g.items.map((m) => m.dept || '未標示部門').join('、');
      return `第${i + 1}位,${name}的分機是${g.ext},同時支援:${depts}等${g.items.length}個部門`;
    })
    .join('。');
}

// This is the text shown on screen and returned in the JSON response - keep
// extensions as normal digits ("2037") here. The spoken version (fed to TTS)
// is derived separately by toSpokenText() below, so the two can disagree
// without either one being "wrong" for its own purpose.
function buildAnswerText(result) {
  const fuzzyNote = result.fuzzy ? '(這是用發音猜的,如果沒聽錯的話)' : '';
  if (result.status === 'single') {
    const prefix = result.fuzzy ? `我聽起來像是問${result.name},如果沒聽錯,` : '查到了。';
    return `${prefix}${result.name}的分機是${result.ext},部門是${result.dept || '未標示'},地區是${result.loc || '未標示'}。`;
  }
  if (result.status === 'multiple') {
    const groups = groupByExtension(result.matches);
    if (groups.length === 1) {
      const g = groups[0];
      const depts = g.items.map((m) => m.dept || '未標示部門').join('、');
      const who = result.sameName ? result.name : g.items[0].name;
      return `${who}${fuzzyNote}的分機是${g.ext},同時支援:${depts}等${g.items.length}個部門。`;
    }
    if (result.sameName) {
      return `查到${result.count}位同名同姓的${result.name}${fuzzyNote},分屬不同部門:${speakCandidateList(result.matches)}。請說出部門名稱來確認是哪一位。`;
    }
    return `找到${result.count}筆符合的同仁:${speakCandidateList(result.matches)}。請說出更完整的姓名。`;
  }
  return '抱歉,查無此人,請確認姓名是否正確。';
}

// Turns the display text above into something Piper will actually pronounce
// well:
// - digit runs get spelled out one hanzi per digit ("2037" -> "二零三七"),
//   since Chinese TTS otherwise reads a bare number as one big quantity
//   ("二千零三十七") - wrong for a phone extension, which is read digit by
//   digit
// - "(building)" annotations become a pause instead of literal parentheses,
//   which the phonemizer doesn't handle gracefully
// - a bare space between two Chinese segments (e.g. a joined group+dept
//   string, "市場暨產品行銷事業群 資通技術處") becomes a pause too - left as
//   a plain space, Piper's chunker can end up splitting the audio mid-word
//   at a seemingly random point instead of at that space
// A full stop ("。") gives a noticeably cleaner break than a dunhao/comma at
// these two join points - user A/B/C tested all three on real answers and
// picked the full stop, even though it reads a bit like a run-on sentence.
// - Dify's answers are also formatted as separate lines ("姓名:...\n分機:...\n...")
//   for on-screen readability. The CJK-space rule above already turns most of
//   those newlines into the same pause (its \s matches \n too), but not the
//   ones next to a digit or punctuation mark ("...2037\n部門..." or
//   "查到了!\n\n姓名...") since those aren't between two Chinese characters -
//   catch whatever newlines are left over explicitly.
const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function toSpokenText(text) {
  return text
    .replace(/\(([^)]*)\)/g, '。$1')
    .replace(/([一-鿿])\s+([一-鿿])/g, '$1。$2')
    .replace(/\n+/g, '。')
    .replace(/。{2,}/g, '。')
    .replace(/\d+/g, (run) => run.split('').map((d) => CHINESE_DIGITS[Number(d)]).join(''));
}

let transcriberPromise = null;
function loadWhisperModel() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
      quantized: true,
    });
  }
  return transcriberPromise;
}

// Full pipeline: audio file in, spoken+text answer out. `transcriber` should
// come from loadWhisperModel() - callers that serve many requests (server.js)
// load it once and reuse it instead of paying the load cost every time.
async function answerFromAudioFile(transcriber, inputPath, outWavPath) {
  const audio = await loadAudioAsFloat32(inputPath);
  const t0 = Date.now();
  const sttResult = await transcriber(audio, { language: 'chinese', task: 'transcribe' });
  const sttMs = Date.now() - t0;
  const questionTextRaw = sttResult.text.trim();
  const questionText = s2t(questionTextRaw);

  const result = lookup(questionText);
  const answerText = buildAnswerText(result);
  await synthesize(toSpokenText(answerText), outWavPath);

  return {
    recognized_raw: questionTextRaw,
    recognized_question: questionText,
    stt_ms: sttMs,
    lookup_status: result.status,
    fuzzy: result.fuzzy,
    answer_text: answerText,
    answer_wav: outWavPath,
  };
}

module.exports = {
  s2t,
  loadAudioAsFloat32,
  convertToWavFile,
  transcribeSenseVoice,
  synthesize,
  buildAnswerText,
  toSpokenText,
  loadWhisperModel,
  answerFromAudioFile,
};
