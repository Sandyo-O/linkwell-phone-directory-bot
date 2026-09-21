// Pushes workflow.json into n8n via its REST API and (re)activates it -
// unlike Dify, which needed a full delete+reimport through the UI every time
// the DSL changed, n8n's API lets this be fully scripted: update the existing
// workflow in place, no manual clicking, no losing env vars/credentials.
//
// Requires N8N_API_KEY in n8n-voice/.env (Settings > n8n API > Create API key
// in the n8n UI) and N8N_WORKFLOW_ID once a workflow exists (this script
// prints the id after the first create - add it to .env to update in place
// on subsequent runs instead of creating a new copy each time).
const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
}

const N8N_BASE = process.env.N8N_BASE_URL || 'http://localhost:5679';
const API_KEY = process.env.N8N_API_KEY;
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID;

if (!API_KEY) {
  console.error('缺少 N8N_API_KEY - 到 n8n 的 Settings > n8n API > Create API key 建立一組,存進 n8n-voice/.env');
  process.exit(1);
}

async function main() {
  const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflow.json'), 'utf8'));

  let response;
  if (WORKFLOW_ID) {
    response = await fetch(`${N8N_BASE}/api/v1/workflows/${WORKFLOW_ID}`, {
      method: 'PUT',
      headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
  } else {
    response = await fetch(`${N8N_BASE}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
  }
  const data = await response.json();
  if (!response.ok) {
    console.error('匯入失敗:', data);
    process.exit(1);
  }
  console.log(`已${WORKFLOW_ID ? '更新' : '建立'} workflow, id=${data.id}`);
  if (!WORKFLOW_ID) {
    console.log(`第一次建立,把這行加進 n8n-voice/.env,之後重跑這個腳本就會更新同一個workflow而不是每次都新增一份:`);
    console.log(`N8N_WORKFLOW_ID=${data.id}`);
  }

  const activateResponse = await fetch(`${N8N_BASE}/api/v1/workflows/${data.id}/activate`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': API_KEY },
  });
  if (!activateResponse.ok) {
    console.error('發布(啟用)失敗:', await activateResponse.json());
    process.exit(1);
  }
  console.log('已啟用(active)。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
