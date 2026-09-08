const fs = require('fs');
const path = require('path');

function colToIndex(col) {
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}

function parseSharedStrings(xml) {
  const strings = [];
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRegex.exec(xml)) !== null) {
    const inner = m[1];
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let tm;
    while ((tm = tRegex.exec(inner)) !== null) text += tm[1];
    text = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    strings.push(text);
  }
  return strings;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRegex = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRegex.exec(xml)) !== null) {
    const rowNum = parseInt(rm[1], 10);
    const rowContent = rm[2];
    // Self-closing cells (`<c .../>`, i.e. empty) MUST be matched before the
    // open/close alternative - with the open/close pattern tried first, its
    // greedy `[^>]*` attrs group would swallow the "/" of a self-closing tag,
    // then its lazy `([\s\S]*?)` would scan forward past that tag entirely
    // looking for the next literal "</c>", silently merging it with whatever
    // real cell came next and shifting every following column in the row by
    // one. That's a real bug we hit: an empty cell followed by a populated
    // one caused the populated one's value to be misfiled under the empty
    // cell's column, corrupting department attribution for names that came
    // right after a blank spacer cell.
    const cRegex = /<c ([^>]*?)\/>|<c ([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    const cells = {};
    while ((cm = cRegex.exec(rowContent)) !== null) {
      const attrs = cm[1] !== undefined ? cm[1] : cm[2];
      const inner = cm[3] || '';
      const rAttr = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!rAttr) continue;
      const col = rAttr[1];
      const tAttr = /t="([^"]*)"/.exec(attrs);
      const type = tAttr ? tAttr[1] : null;
      let value = '';
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const isMatch = /<is>([\s\S]*?)<\/is>/.exec(inner);
      if (type === 's' && vMatch) {
        value = sharedStrings[parseInt(vMatch[1], 10)] || '';
      } else if (isMatch) {
        const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(isMatch[1]);
        value = tm ? tm[1] : '';
      } else if (vMatch) {
        value = vMatch[1];
      }
      cells[col] = value;
    }
    rows[rowNum] = cells;
  }
  return rows;
}

function parseMerges(xml) {
  const mergeMatch = xml.match(/<mergeCells[^>]*>([\s\S]*?)<\/mergeCells>/);
  if (!mergeMatch) return [];
  return [...mergeMatch[1].matchAll(/ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)].map((m) => ({
    c1: colToIndex(m[1]),
    r1: parseInt(m[2], 10),
    c2: colToIndex(m[3]),
    r2: parseInt(m[4], 10),
  }));
}

const DEPT_SUFFIXES = ['部', '處', '室', '中心', '群', '廳', '組', '樓', '層'];
const DEPT_KEYWORDS = ['會議室', '接待', '事業群', '事業部', '事業一部', '事業二部'];

function classify(text) {
  const t = (text || '').trim();
  if (!t) return 'empty';
  if (/^[＊*]?\d+$/.test(t)) {
    const digits = t.replace(/[＊*]/g, '');
    if (digits.length === 4) return 'ext';
    return 'counter';
  }
  // pure symbols/parens etc treat as note
  if (/^[（(].*[）)]$/.test(t)) return 'note';
  const isDept = DEPT_SUFFIXES.some((s) => t.endsWith(s)) || DEPT_KEYWORDS.some((k) => t.includes(k));
  if (isDept) return 'dept';
  // Chinese name heuristic: mostly CJK chars, length 2-6 (allow spaces / ＊ prefix)
  const stripped = t.replace(/[＊*]/g, '').replace(/\s/g, '');
  if (/^[\u4e00-\u9fff]{2,6}$/.test(stripped)) return 'name';
  if (/\d/.test(t)) return 'noise';
  return 'other';
}

function extractFile(extractedDir, location) {
  const ssPath = path.join(extractedDir, 'xl', 'sharedStrings.xml');
  const sheetPath = path.join(extractedDir, 'xl', 'worksheets', 'sheet1.xml');
  const ss = fs.existsSync(ssPath) ? parseSharedStrings(fs.readFileSync(ssPath, 'utf8')) : [];
  const sheetXml = fs.readFileSync(sheetPath, 'utf8');
  const rows = parseSheet(sheetXml, ss);
  const merges = parseMerges(sheetXml);

  // Build header labels from row1/row2 merges (division/floor context)
  const headerLabel = (rowNum, colIdx) => {
    for (const mg of merges) {
      if (mg.r1 === rowNum && mg.r2 === rowNum && colIdx >= mg.c1 && colIdx <= mg.c2) {
        return { c1: mg.c1, c2: mg.c2 };
      }
    }
    return null;
  };

  const results = [];
  const lastDeptByGroup = {};
  const rowKeys = Object.keys(rows).map(Number).sort((a, b) => a - b);

  for (const rn of rowKeys) {
    if (rn <= 2) continue; // header rows handled separately
    const rowObj = rows[rn];
    if (!rowObj) continue;
    const entries = Object.entries(rowObj)
      .map(([col, val]) => ({ col, idx: colToIndex(col), val: (val || '').toString() }))
      .filter((e) => e.val.trim() !== '')
      .sort((a, b) => a.idx - b.idx)
      .map((e) => ({ ...e, kind: classify(e.val) }));

    const consumedAsName = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (consumedAsName.has(i)) continue; // already paired to an ext as someone's name; don't reinterpret as a dept header
      const group = Math.floor(e.idx / 3);
      if (e.kind === 'dept') {
        lastDeptByGroup[group] = e.val.trim();
      }
      if (e.kind === 'ext') {
        // find next entry (any kind) to the right
        const nxt = entries[i + 1];
        let name = '';
        let noteDept = '';
        if (nxt) {
          if (nxt.kind === 'name') {
            name = nxt.val.trim();
          } else if (nxt.kind === 'dept') {
            name = nxt.val.trim(); // department general line
            noteDept = nxt.val.trim();
          } else if (nxt.kind === 'other') {
            name = nxt.val.trim();
          }
          if (name) consumedAsName.add(i + 1);
        }
        if (!name) continue; // ext with nothing meaningful next to it, skip
        let dept = lastDeptByGroup[group] || noteDept || '';
        if (dept === name) dept = '';
        results.push({
          location,
          department: dept,
          name,
          extension: e.val.replace(/[＊*]/g, '').trim(),
          flagged: /[＊*]/.test(e.val) || /[＊*]/.test(name),
        });
      }
    }
  }
  return results;
}

const baseDir = process.argv[2];
const dirs = fs.readdirSync(baseDir).filter((f) => fs.statSync(path.join(baseDir, f)).isDirectory());
let all = [];
for (const d of dirs) {
  const m = d.match(/分機表[（(](.+?)11507[）)]/);
  const location = m ? m[1] : d;
  const recs = extractFile(path.join(baseDir, d), location);
  console.error(`${d} -> ${recs.length} records`);
  all = all.concat(recs);
}

// de-duplicate exact duplicate rows
const seen = new Set();
const dedup = [];
for (const r of all) {
  const key = `${r.location}|${r.department}|${r.name}|${r.extension}`;
  if (seen.has(key)) continue;
  seen.add(key);
  dedup.push(r);
}

console.error(`TOTAL: ${all.length}, DEDUP: ${dedup.length}`);

const csvEscape = (s) => `"${(s || '').toString().replace(/"/g, '""')}"`;
const header = ['地區', '部門', '姓名', '分機', '備註'];
const lines = [header.join(',')];
for (const r of dedup) {
  lines.push(
    [
      csvEscape(r.location),
      csvEscape(r.department),
      csvEscape(r.name.replace(/[＊*]/g, '')),
      csvEscape(r.extension),
      csvEscape(r.flagged ? '＊標記' : ''),
    ].join(',')
  );
}
fs.writeFileSync(path.join(baseDir, '..', 'consolidated.csv'), '\uFEFF' + lines.join('\n'), 'utf8');
console.error('Wrote consolidated.csv');
