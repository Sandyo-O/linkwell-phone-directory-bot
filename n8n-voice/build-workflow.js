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

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice', 'directory.json'), 'utf8'));

const mainLogicCode = `const DATA = ${JSON.stringify(DATA)};

function lookup(query) {
  const q = (query || '').trim();
  const qNoSpace = q.replace(/ /g, '').replace(/\\u3000/g, '');
  const seen = new Set();
  let matches = [];
  for (const r of DATA) {
    const nm = r.name;
    if (nm && (q.includes(nm) || qNoSpace.includes(nm))) {
      const key = r.loc + '|' + r.dept + '|' + nm + '|' + r.ext;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(r);
    }
  }
  if (matches.length > 1) {
    const narrowed = matches.filter((r) => (r.dept && qNoSpace.includes(r.dept)) || (r.loc && qNoSpace.includes(r.loc)));
    if (narrowed.length === 1) matches = narrowed;
  }
  let status;
  if (matches.length === 0) status = 'none';
  else if (matches.length === 1) status = 'single';
  else status = 'multiple';
  const first = matches[0] || { loc: '', dept: '', name: '', ext: '' };
  const sameName = new Set(matches.map((m) => m.name)).size <= 1;
  const summaryLines = matches.slice(0, 10).map((m, i) => (i + 1) + '. ' + m.name + ' - 部門:' + (m.dept || '未標示部門') + ' / 地區:' + (m.loc || '未標示地區') + ' / 分機:' + m.ext);
  if (matches.length > 10) summaryLines.push('...還有 ' + (matches.length - 10) + ' 筆未列出,請輸入更精確的姓名或部門縮小範圍');
  return { status, sameName, name: first.name, ext: first.ext, dept: first.dept, loc: first.loc, summary: summaryLines.join('\\n'), count: matches.length };
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
  const r = lookup(message);
  if (r.status === 'single') {
    result = { sendEmail: 'false', reply: buildFoundAnswer(r), stage: 'await_email', pending: { name: r.name, ext: r.ext, dept: r.dept, loc: r.loc } };
  } else if (r.status === 'multiple') {
    const reply = r.sameName
      ? ('查到' + r.count + '位同名同姓的' + r.name + ',分屬不同部門:\\n' + r.summary + '\\n請說出或輸入部門/地區名稱來確認是哪一位。')
      : ('找到' + r.count + '筆符合的同仁:\\n' + r.summary + '\\n請輸入更完整的姓名。');
    result = { sendEmail: 'false', reply, stage: '', pending: {} };
  } else {
    result = { sendEmail: 'false', reply: '抱歉,查無此人,請確認姓名是否正確。', stage: '', pending: {} };
  }
}

return [{ json: Object.assign({}, result, { pendingForEmail: pending }) }];
`;

const finalizeCode = `const httpResult = $input.first().json;
const original = $('Main Logic').first().json;
const p = original.pendingForEmail || {};
let reply;
if (httpResult.statusCode === 200) {
  reply = '好的,已經把「' + p.name + '」的分機(' + p.ext + ')寄到 ' + original.emailTo + ' 囉!\\n\\n還想查其他同仁的分機嗎?直接輸入姓名即可。';
} else {
  reply = '抱歉,信件寄送失敗了(狀態碼:' + httpResult.statusCode + ')。常見原因是Resend API Key沒設定或設錯、或收件信箱不是你註冊Resend時用的信箱(免費方案的限制)。\\n\\n還想再查其他同仁的分機嗎?直接輸入姓名即可。';
}
return [{ json: { reply, stage: '', pending: {} } }];
`;

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
      id: 'resend1',
      name: 'Send via Resend',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [780, -100],
      parameters: {
        method: 'POST',
        url: 'https://api.resend.com/emails',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '=Bearer {{ $env.RESEND_API_KEY }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          '={{ JSON.stringify({ from: "onboarding@resend.dev", to: [$json.emailTo], subject: "凌群電腦分機查詢結果", html: "<p>您好,您查詢的同仁 <b>" + $json.pendingForEmail.name + "</b> 分機為:<b>" + $json.pendingForEmail.ext + "</b></p><p>部門:" + ($json.pendingForEmail.dept || "未標示") + "</p><p>地區:" + ($json.pendingForEmail.loc || "未標示") + "</p>" }) }}',
        options: { response: { response: { fullResponse: true, neverError: true } } },
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
        [{ node: 'Send via Resend', type: 'main', index: 0 }],
        [{ node: 'Respond No Email', type: 'main', index: 0 }],
      ],
    },
    'Send via Resend': { main: [[{ node: 'Finalize After Send', type: 'main', index: 0 }]] },
    'Finalize After Send': { main: [[{ node: 'Respond After Send', type: 'main', index: 0 }]] },
  },
  settings: {},
};

const outPath = path.join(__dirname, 'workflow.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log(`wrote ${outPath}`);
