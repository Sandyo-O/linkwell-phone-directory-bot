const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'directory.json'), 'utf8'));

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
    name: first.name,
    ext: first.ext,
    dept: first.dept,
    loc: first.loc,
    summary: summaryLines.join('\n'),
    count: matches.length,
  };
}

module.exports = { lookup, DATA };
