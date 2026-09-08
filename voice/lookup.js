const fs = require('fs');
const path = require('path');
const pinyinLib = require('pinyin');
const toPinyinFn = pinyinLib.default || pinyinLib;
const STYLE_NORMAL = pinyinLib.STYLE_NORMAL || 0;

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'directory.json'), 'utf8'));

function toPinyin(s) {
  try {
    return toPinyinFn(s, { style: STYLE_NORMAL })
      .map((a) => a[0])
      .join('')
      .toLowerCase();
  } catch (e) {
    return '';
  }
}

// Precompute pinyin once for every unique name in the directory, used as a
// fallback when voice recognition mis-hears a rare name character but gets
// the sound roughly right (e.g. "史印辰" heard as "是硬沉"). Restricted to
// real 2-4 character CJK personal names - short labels like "CDO" or "TEL"
// (room/dept codes that ended up in the name field) have pinyin so short
// they'd trivially "match" almost anything.
const CJK_NAME = /^[一-鿿]{2,4}$/;
const uniqueNames = [...new Set(DATA.map((r) => r.name).filter((n) => n && CJK_NAME.test(n)))];
const namePinyin = new Map(uniqueNames.map((n) => [n, toPinyin(n)]));

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Find names whose pinyin closely matches some substring of the query's pinyin.
// Rather than a flat distance cutoff (which pulls in too many loose false
// positives), keep only names tied for the best (lowest) distance found -
// a small margin allows for a couple of genuinely close spellings.
function fuzzyPinyinMatch(query) {
  const queryPinyin = toPinyin(query);
  if (!queryPinyin) return [];
  const distances = new Map();
  for (const name of uniqueNames) {
    const namePy = namePinyin.get(name);
    if (!namePy) continue;
    // 2-character names have short pinyin (~4-6 letters) that can accidentally
    // resemble a random fragment of any sentence, so require an exact match;
    // longer names get a little edit-distance tolerance for mis-heard syllables.
    const hardCap = namePy.length <= 6 ? 0 : namePy.length <= 9 ? 1 : 2;
    let best = Infinity;
    for (let i = 0; i < queryPinyin.length; i++) {
      for (let len = namePy.length - hardCap; len <= namePy.length + hardCap; len++) {
        if (len <= 0 || i + len > queryPinyin.length) continue;
        const window = queryPinyin.slice(i, i + len);
        const dist = levenshtein(namePy, window);
        if (dist < best) best = dist;
      }
    }
    if (best <= hardCap) distances.set(name, best);
  }
  if (distances.size === 0) return [];
  const minDist = Math.min(...distances.values());
  // Once a very close match is found (distance 0-1), don't loosen further -
  // that margin is only useful for genuinely ambiguous, looser matches.
  const margin = minDist >= 2 ? 1 : 0;
  const found = new Set([...distances.entries()].filter(([, d]) => d <= minDist + margin).map(([n]) => n));
  return DATA.filter((r) => found.has(r.name));
}

function lookup(query) {
  const q = (query || '').trim();
  const qNoSpace = q.replace(/ /g, '').replace(/　/g, '');
  const seen = new Set();
  let matches = [];
  for (const r of DATA) {
    const nm = r.name;
    if (nm && (q.includes(nm) || qNoSpace.includes(nm))) {
      const key = `${r.loc}|${r.dept}|${nm}|${r.ext}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(r);
    }
  }

  let fuzzy = false;
  if (matches.length === 0) {
    const fuzzyMatches = fuzzyPinyinMatch(qNoSpace);
    for (const r of fuzzyMatches) {
      const key = `${r.loc}|${r.dept}|${r.name}|${r.ext}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(r);
    }
    if (matches.length > 0) fuzzy = true;
  }

  if (matches.length > 1) {
    const narrowed = matches.filter(
      (r) => (r.dept && qNoSpace.includes(r.dept)) || (r.loc && qNoSpace.includes(r.loc))
    );
    if (narrowed.length === 1) matches = narrowed;
  }
  let status;
  if (matches.length === 0) status = 'none';
  else if (matches.length === 1) status = 'single';
  else status = 'multiple';

  const first = matches[0] || { loc: '', dept: '', name: '', ext: '' };
  const sameName = new Set(matches.map((m) => m.name)).size <= 1;
  const summaryLines = matches.slice(0, 10).map((m, i) => {
    const dept = m.dept || '未標示部門';
    const loc = m.loc || '未標示地區';
    return `${i + 1}. ${m.name} - 部門:${dept} / 地區:${loc} / 分機:${m.ext}`;
  });
  if (matches.length > 10) {
    summaryLines.push(`...還有 ${matches.length - 10} 筆未列出,請輸入更精確的姓名或部門縮小範圍`);
  }
  return {
    status,
    sameName,
    fuzzy,
    name: first.name,
    ext: first.ext,
    dept: first.dept,
    loc: first.loc,
    summary: summaryLines.join('\n'),
    count: matches.length,
  };
}

module.exports = { lookup, DATA };
