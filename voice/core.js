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

async function loadAudioAsFloat32(inputPath) {
  const rawPath = inputPath + '.f32.raw';
  execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -f f32le "${rawPath}"`, { stdio: 'pipe' });
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

// Piper (like most Chinese TTS) reads a bare digit string as one big number
// ("2037" -> 二千零三十七), which is exactly wrong for a phone extension -
// people read extensions digit by digit ("二 零 三 七"). Spelling each digit
// out as its own character sidesteps the number-grouping entirely, since
// Chinese TTS naturally reads each hanzi as one syllable.
const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function spellDigits(numStr) {
  return String(numStr)
    .split('')
    .map((ch) => (ch >= '0' && ch <= '9' ? CHINESE_DIGITS[Number(ch)] : ch))
    .join('');
}

function speakCandidateList(matches) {
  const groups = groupByExtension(matches);
  return groups
    .map((g, i) => {
      const name = g.items[0].name;
      const spokenExt = spellDigits(g.ext);
      if (g.items.length === 1) {
        return `第${i + 1}位,${g.items[0].dept || '未標示部門'}的${name},分機${spokenExt}`;
      }
      const depts = g.items.map((m) => m.dept || '未標示部門').join('、');
      return `第${i + 1}位,${name}的分機是${spokenExt},同時支援:${depts}等${g.items.length}個部門`;
    })
    .join('。');
}

function buildAnswerText(result) {
  const fuzzyNote = result.fuzzy ? '(這是用發音猜的,如果沒聽錯的話)' : '';
  if (result.status === 'single') {
    const prefix = result.fuzzy ? `我聽起來像是問${result.name},如果沒聽錯,` : '查到了。';
    return `${prefix}${result.name}的分機是${spellDigits(result.ext)},部門是${result.dept || '未標示'},地區是${result.loc || '未標示'}。`;
  }
  if (result.status === 'multiple') {
    const groups = groupByExtension(result.matches);
    if (groups.length === 1) {
      const g = groups[0];
      const depts = g.items.map((m) => m.dept || '未標示部門').join('、');
      const who = result.sameName ? result.name : g.items[0].name;
      return `${who}${fuzzyNote}的分機是${spellDigits(g.ext)},同時支援:${depts}等${g.items.length}個部門。`;
    }
    if (result.sameName) {
      return `查到${result.count}位同名同姓的${result.name}${fuzzyNote},分屬不同部門:${speakCandidateList(result.matches)}。請說出部門名稱來確認是哪一位。`;
    }
    return `找到${result.count}筆符合的同仁:${speakCandidateList(result.matches)}。請說出更完整的姓名。`;
  }
  return '抱歉,查無此人,請確認姓名是否正確。';
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
  synthesize(answerText, outWavPath);

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
  synthesize,
  buildAnswerText,
  loadWhisperModel,
  answerFromAudioFile,
};
