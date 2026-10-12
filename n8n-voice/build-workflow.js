// Generates the n8n workflow JSON for the extension-lookup + email flow,
// from the same voice/directory.json the Dify version uses. Mirrors
// scripts/gen-dsl.js's role for the Dify DSL - re-run this whenever the
// directory data changes, then re-import via import-workflow.js.
//
// Fuzzy pinyin name-correction (for garbled voice input) intentionally
// stays out of this workflow, same as it stays out of Dify's: it already
// lives in voice/server.js's correctMishearName(), which runs on whatever
// text the browser sends *before* it reaches here - this workflow only
// ever sees already-corrected text, so it only needs plain exact-match
// lookup, no pinyin library (n8n's sandboxed Code node can't load one
// anyway without extra image customization).
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
for (const line of fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const SMTP_CREDENTIAL_ID = process.env.N8N_SMTP_CREDENTIAL_ID;
const SMTP_FROM = process.env.N8N_SMTP_FROM;
if (!SMTP_CREDENTIAL_ID || !SMTP_FROM) throw new Error('n8n-voice/.env 需要 N8N_SMTP_CREDENTIAL_ID 和 N8N_SMTP_FROM');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice', 'directory.json'), 'utf8'));

const mainLogicCode = `const DATA = ${JSON.stringify(DATA)};

function lookup(query) {
  // 臺/台 are the same word in this data (and speech recognition emits 臺) - compare on one form
  const norm = (t) => (t || '').replace(/臺/g, '台');
  const q = norm((query || '').trim());
  const qNoSpace = q.replace(/ /g, '').replace(/\\u3000/g, '');
  const seen = new Set();
  let matches = [];
  for (const r of DATA) {
    const nm = r.name;
    const nmN = norm(nm);
    if (nm && (q.includes(nmN) || qNoSpace.includes(nmN))) {
      const key = r.loc + '|' + r.dept + '|' + nm + '|' + r.ext;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(r);
    }
  }
  if (matches.length > 1) {
    const cityOf = (loc) => norm(loc).split('(')[0];
    const narrowed = matches.filter((r) => (r.dept && qNoSpace.includes(norm(r.dept))) || (r.loc && (qNoSpace.includes(norm(r.loc)) || qNoSpace.includes(cityOf(r.loc)))));
    if (narrowed.length >= 1) matches = narrowed;
  }
  let status;
  if (matches.length === 0) status = 'none';
  else if (matches.length === 1) status = 'single';
  else status = 'multiple';
  const first = matches[0] || { loc: '', dept: '', name: '', ext: '' };
  const sameName = new Set(matches.map((m) => m.name)).size <= 1;
  const summaryLines = matches.slice(0, 10).map((m, i) => (i + 1) + '. ' + m.name + ' - 部門:' + (m.dept || '未標示部門') + ' / 地區:' + (m.loc || '未標示地區') + ' / 分機:' + m.ext);
  if (matches.length > 10) summaryLines.push('...還有 ' + (matches.length - 10) + ' 筆未列出,請輸入更精確的姓名或部門縮小範圍');
  return { status, sameName, name: first.name, ext: first.ext, dept: first.dept, loc: first.loc, summary: summaryLines.join('\\n'), count: matches.length, rows: matches };
}

function splitLoc(loc) {
  const m = /^(.*?)\\((.*)\\)$/.exec(loc || '');
  if (m) return [m[1], m[2]];
  return [loc || '', ''];
}

function buildFoundAnswer(r) {
  const parts = splitLoc(r.loc);
  const city = parts[0];
  const building = parts[1];
  const buildingLine = building ? ('地點:' + building + '\\n') : '';
  return '以下是「' + r.name + '」的員工資訊:\\n\\n姓名:' + r.name + '\\n分機:' + r.ext + '\\n地區:' + city + '\\n' + buildingLine + '部門:' + (r.dept || '未標示') + '\\n\\n請問要把這個分機寄到您的email嗎?要的話請回覆「要」或直接輸入您的email地址,不用的話請回覆「不用」。';
}

const DECLINE_WORDS = ['不用', '不寄', '不需要', '算了', '不要', '取消', 'no', '不用了'];
const CONFIRM_WORDS = ['要', '好', '是', '對', 'ok', 'yes', '寄', '麻煩', '可以', '嗯'];

const body = ($input.first().json.body) || {};
const message = (body.message || '').trim();
const stage = body.stage || '';
const pending = body.pending || {};
const defaultEmail = (body.default_email || '').trim();

let result;

if (stage === 'await_email') {
  const text = message;
  const lowered = text.toLowerCase();
  const emailMatch = /[^@\\s]+@[^@\\s]+\\.[^@\\s]+/.exec(text);
  if (emailMatch) {
    result = { sendEmail: 'true', emailTo: emailMatch[0], reply: '', stage: '', pending: {} };
  } else if (DECLINE_WORDS.some((w) => text.includes(w) || lowered.includes(w))) {
    result = { sendEmail: 'false', reply: '好的,那這次就不寄email了。\\n\\n還想查其他同仁的分機嗎?直接輸入姓名即可。', stage: '', pending: {} };
  } else if (CONFIRM_WORDS.some((w) => text.includes(w) || lowered.includes(w))) {
    if (defaultEmail) {
      result = { sendEmail: 'true', emailTo: defaultEmail, reply: '', stage: '', pending: {} };
    } else {
      result = { sendEmail: 'false', reply: '好的,請問您的email地址是?', stage: 'await_email', pending };
    }
  } else {
    result = { sendEmail: 'false', reply: '不好意思,沒有聽懂。要寄的話請輸入您的email地址(例如:name@example.com),不寄的話請回覆「不用」。', stage: 'await_email', pending };
  }
} else {
  let r = lookup(message);
  // Follow-up to a "which department?" list: the person typed only a
  // department/location, no name, so retry with the name we asked about.
  if (r.status === 'none' && stage === 'await_disambig' && pending.name) {
    r = lookup(pending.name + message);
  }
  // Same name AND same extension on every row is one person holding
  // several titles, not a real ambiguity - merge instead of asking.
  const onePerson = r.status === 'multiple' && r.sameName && new Set(r.rows.map((m) => m.ext)).size === 1;
  if (r.status === 'single' || onePerson) {
    const depts = Array.from(new Set(r.rows.map((m) => m.dept).filter(Boolean)));
    const locs = Array.from(new Set(r.rows.map((m) => m.loc)));
    const merged = { name: r.name, ext: r.ext, dept: depts.join('、'), loc: locs.join('、') };
    result = { sendEmail: 'false', reply: buildFoundAnswer(merged), stage: 'await_email', pending: merged };
  } else if (r.status === 'multiple') {
    const reply = r.sameName
      ? ('查到' + r.count + '位同名同姓的' + r.name + ',分機不同,分屬不同部門:\\n' + r.summary + '\\n請說出或輸入部門/地區名稱來確認是哪一位。')
      : ('找到' + r.count + '筆符合的同仁:\\n' + r.summary + '\\n請輸入更完整的姓名。');
    result = { sendEmail: 'false', reply, stage: r.sameName ? 'await_disambig' : '', pending: r.sameName ? { name: r.name } : {} };
  } else {
    result = { sendEmail: 'false', reply: '抱歉,查無此人,請確認姓名是否正確。', stage: '', pending: {} };
  }
}

return [{ json: Object.assign({}, result, { pendingForEmail: pending }) }];
`;

const finalizeCode = `const sendResult = $input.first().json;\nconst original = $('Main Logic').first().json;\nconst p = original.pendingForEmail || {};\nlet reply;\nif (!sendResult.error) {\n  reply = '好的,已經把「' + p.name + '」的分機(' + p.ext + ')寄到 ' + original.emailTo + ' 囉!\\n\\n還想查其他同仁的分機嗎?直接輸入姓名即可。';\n} else {\n  const detail = typeof sendResult.error === 'string' ? sendResult.error : (sendResult.error.message || '未知錯誤');\n  reply = '抱歉,信件寄送失敗了(' + detail + ')。常見原因是Gmail應用程式密碼失效或設錯,請檢查n8n裡的「Gmail SMTP」認證。\\n\\n還想再查其他同仁的分機嗎?直接輸入姓名即可。';\n}\nreturn [{ json: { reply, stage: '', pending: {} } }];\n`;

const workflow = {
  name: '分機查詢小幫手(n8n版)',
  nodes: [
    {
      id: 'webhook1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      parameters: { httpMethod: 'POST', path: 'ext-lookup', responseMode: 'responseNode', options: {} },
    },
    {
      id: 'mainlogic1',
      name: 'Main Logic',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [260, 0],
      parameters: { jsCode: mainLogicCode },
    },
    {
      id: 'ifsend1',
      name: 'Should Send Email',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [520, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, typeValidation: 'strict' },
          conditions: [
            {
              id: 'c1',
              leftValue: '={{ $json.sendEmail }}',
              rightValue: 'true',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    },
    {
      id: 'sendmail1',
      name: 'Send Email (Gmail SMTP)',
      type: 'n8n-nodes-base.emailSend',
      typeVersion: 2.1,
      position: [780, -100],
      onError: 'continueRegularOutput',
      credentials: { smtp: { id: SMTP_CREDENTIAL_ID, name: 'Gmail SMTP' } },
      parameters: {
        fromEmail: SMTP_FROM,
        toEmail: '={{ $json.emailTo }}',
        subject: '凌群電腦分機查詢結果',
        emailFormat: 'html',
        html: '={{ "<p>您好,您查詢的同仁 <b>" + $json.pendingForEmail.name + "</b> 分機為:<b>" + $json.pendingForEmail.ext + "</b></p><p>部門:" + ($json.pendingForEmail.dept || "未標示") + "</p><p>地區:" + ($json.pendingForEmail.loc || "未標示") + "</p>" }}',
        options: {},
      },
    },
    {
      id: 'finalize1',
      name: 'Finalize After Send',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1040, -100],
      parameters: { jsCode: finalizeCode },
    },
    {
      id: 'respondsent1',
      name: 'Respond After Send',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [1300, -100],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    },
    {
      id: 'respondnoemail1',
      name: 'Respond No Email',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [780, 100],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Main Logic', type: 'main', index: 0 }]] },
    'Main Logic': { main: [[{ node: 'Should Send Email', type: 'main', index: 0 }]] },
    'Should Send Email': {
      main: [
        [{ node: 'Send Email (Gmail SMTP)', type: 'main', index: 0 }],
        [{ node: 'Respond No Email', type: 'main', index: 0 }],
      ],
    },
    'Send Email (Gmail SMTP)': { main: [[{ node: 'Finalize After Send', type: 'main', index: 0 }]] },
    'Finalize After Send': { main: [[{ node: 'Respond After Send', type: 'main', index: 0 }]] },
  },
  settings: {},
};

const outPath = path.join(__dirname, 'workflow.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log(`wrote ${outPath}`);
