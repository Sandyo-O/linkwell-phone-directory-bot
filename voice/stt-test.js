const { pipeline } = require('@xenova/transformers');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function loadAudioAsFloat32(wavPath) {
  // Use ffmpeg to decode to 16kHz mono 32-bit float raw PCM
  const rawPath = wavPath + '.f32.raw';
  execSync(`ffmpeg -y -i "${wavPath}" -ar 16000 -ac 1 -f f32le "${rawPath}"`, { stdio: 'pipe' });
  const buf = fs.readFileSync(rawPath);
  const floatArray = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  fs.unlinkSync(rawPath);
  return floatArray;
}

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath) {
    console.error('usage: node stt-test.js <path-to-wav>');
    process.exit(1);
  }
  console.error('Loading Whisper model (Xenova/whisper-small, first run downloads it)...');
  const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
    quantized: true,
  });
  console.error('Decoding audio...');
  const audio = await loadAudioAsFloat32(wavPath);
  console.error('Transcribing...');
  const t0 = Date.now();
  const result = await transcriber(audio, { language: 'chinese', task: 'transcribe' });
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ text: result.text, ms }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
