// Dev-time build step: reads the same directory.json the Dify version uses,
// precomputes each unique name's pinyin (so the browser doesn't need a
// pinyin conversion step for the database side, only for the live query
// text), and writes a single data.js the page loads via a plain <script>
// tag - keeps this a fully static app with no build/bundle step to run it.
const fs = require('fs');
const path = require('path');
const pinyinLib = require('../voice/node_modules/pinyin');
const toPinyinFn = pinyinLib.default || pinyinLib;

function toPinyin(s) {
  try {
    return toPinyinFn(s, { style: 0 }).map((a) => a[0]).join('').toLowerCase();
  } catch (e) {
    return '';
  }
}

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice', 'directory.json'), 'utf8'));
const CJK_NAME = /^[一-鿿]{2,4}$/;
const pinyinCache = new Map();
for (const r of DATA) {
  if (r.name && CJK_NAME.test(r.name) && !pinyinCache.has(r.name)) {
    pinyinCache.set(r.name, toPinyin(r.name));
  }
}

const out = {
  records: DATA,
  namePinyin: Object.fromEntries(pinyinCache),
};

const outPath = path.join(__dirname, 'data.js');
fs.writeFileSync(outPath, `window.PHONE_DIRECTORY = ${JSON.stringify(out)};\n`, 'utf8');
console.log(`wrote ${outPath} - ${DATA.length} records, ${pinyinCache.size} names with precomputed pinyin`);
