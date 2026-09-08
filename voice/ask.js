const { loadWhisperModel, answerFromAudioFile } = require('./core');

async function main() {
  const inputWav = process.argv[2];
  const outputWav = process.argv[3] || 'answer.wav';
  if (!inputWav) {
    console.error('usage: node ask.js <question.wav> [answer.wav]');
    process.exit(1);
  }

  console.error('[1/4] 載入本機Whisper模型 (Xenova/whisper-small)...');
  const transcriber = await loadWhisperModel();

  console.error('[2/4] 語音辨識中(全部在本機執行)...');
  const result = await answerFromAudioFile(transcriber, inputWav, outputWav);
  console.error(`      辨識結果(簡體): "${result.recognized_raw}"`);
  console.error(`      轉換為繁體後: "${result.recognized_question}" (耗時 ${result.stt_ms}ms)`);

  console.error('[3/4] 查詢分機資料庫(本機比對,1206筆資料)...');
  console.error(`      查詢狀態: ${result.lookup_status}, 回答內容: "${result.answer_text}"`);

  console.error('[4/4] 語音合成完成!');
  console.error(`語音回覆已存到: ${outputWav}`);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
