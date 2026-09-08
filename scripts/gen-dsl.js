const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice', 'directory.json'), 'utf8'));
const dataJson = JSON.stringify(data);

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l.length ? pad + l : l))
    .join('\n');
}

const validateEmailCode = `import re


def main(query: str) -> dict:
    email = (query or '').strip()
    pattern = r'^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
    valid = bool(re.match(pattern, email))
    return {
        'email': email,
        'valid': 'true' if valid else 'false',
    }
`;

const sendEmailCode = `import smtplib
from email.mime.text import MIMEText
from email.header import Header


PLACEHOLDER_VALUES = ('', 'none', '-', 'n/a', 'na', '無', '留空', '(留空)')


def clean(v):
    v = (v or '').strip()
    if v.lower() in PLACEHOLDER_VALUES:
        return ''
    return v


def main(to_email: str, name: str, ext: str, dept: str, loc: str,
         smtp_host: str, smtp_port: str, smtp_user: str, smtp_password: str,
         smtp_from: str, smtp_use_ssl: str) -> dict:
    host = clean(smtp_host)
    if not host:
        return {'sent': 'false', 'error': 'SMTP_HOST 尚未設定,請到 Dify 環境變數設定內部郵件伺服器'}
    try:
        port = int(clean(smtp_port) or '587')
    except ValueError:
        port = 587
    smtp_user = clean(smtp_user)
    smtp_password = clean(smtp_password)
    from_addr = clean(smtp_from) or smtp_user
    use_ssl = clean(smtp_use_ssl).lower() == 'true'

    subject = '凌群電腦分機查詢結果'
    body = (
        f"您好,您查詢的同仁 {name} 分機為:{ext}\\n"
        f"部門:{dept}\\n"
        f"地區:{loc}\\n\\n"
        f"(此信由凌群電腦分機查詢小幫手自動寄送)"
    )
    msg = MIMEText(body, 'plain', 'utf-8')
    msg['Subject'] = Header(subject, 'utf-8')
    msg['From'] = from_addr
    msg['To'] = to_email

    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            server = smtplib.SMTP(host, port, timeout=15)
            server.ehlo()
            if server.has_extn('STARTTLS'):
                server.starttls()
                server.ehlo()
        if smtp_user and smtp_password:
            server.login(smtp_user, smtp_password)
        server.sendmail(from_addr, [to_email], msg.as_string())
        server.quit()
        return {'sent': 'true', 'error': ''}
    except Exception as e:
        return {'sent': 'false', 'error': str(e)}
`;

const lookupCode = `import re

DATA = ${dataJson}


def main(query: str) -> dict:
    q = (query or '').strip()
    q_nospace = q.replace(' ', '').replace('\\u3000', '')
    matches = []
    seen = set()
    for r in DATA:
        nm = r['name']
        if nm and (nm in q or nm in q_nospace):
            key = (r['loc'], r['dept'], nm, r['ext'])
            if key in seen:
                continue
            seen.add(key)
            matches.append(r)
    # if the name alone is ambiguous (e.g. two people share it) but the
    # query also names a department/location, use that to narrow it down
    # e.g. "行銷事業群 陳祐萱" or "台北 陳祐萱"
    if len(matches) > 1:
        narrowed = [
            r for r in matches
            if (r['dept'] and r['dept'] in q_nospace) or (r['loc'] and r['loc'] in q_nospace)
        ]
        if len(narrowed) == 1:
            matches = narrowed
    if len(matches) == 0:
        status = 'none'
    elif len(matches) == 1:
        status = 'single'
    else:
        status = 'multiple'
    first = matches[0] if matches else {'loc': '', 'dept': '', 'name': '', 'ext': ''}
    same_name = len(set(m['name'] for m in matches)) <= 1
    summary_lines = []
    for i, m in enumerate(matches[:10], start=1):
        dept = m['dept'] or '未標示部門'
        loc = m['loc'] or '未標示地區'
        summary_lines.append(f"{i}. {m['name']} - 部門:{dept} / 地區:{loc} / 分機:{m['ext']}")
    if len(matches) > 10:
        summary_lines.append(f"...還有 {len(matches) - 10} 筆未列出,請輸入更精確的姓名或部門縮小範圍")
    return {
        'status': status,
        'same_name': 'true' if same_name else 'false',
        'name': first['name'],
        'ext': first['ext'],
        'dept': first['dept'],
        'loc': first['loc'],
        'summary': '\\n'.join(summary_lines),
        'count': len(matches),
    }
`;

function yamlBlockScalar(fieldName, code, baseIndent) {
  // Renders "fieldName: |-" followed by the code indented, for a mapping value.
  const pad = ' '.repeat(baseIndent);
  const codePad = ' '.repeat(baseIndent + 2);
  const lines = code.replace(/\n$/, '').split('\n');
  return `${pad}${fieldName}: |-\n` + lines.map((l) => (l.length ? codePad + l : codePad.replace(/\s+$/, ''))).join('\n');
}

const yaml = `app:
  description: 凌群電腦內部同仁分機查詢小幫手 - 輸入姓名查分機,並可寄到指定email
  icon: "\\U0001F4DE"
  icon_background: '#E4FBCC'
  mode: advanced-chat
  name: 分機查詢小幫手
  use_icon_as_answer_icon: false
dependencies: []
kind: app
version: 0.3.1
workflow:
  conversation_variables:
  - description: 目前流程狀態,await_email 代表正在等待使用者輸入email
    id: 4f6a2b10-1a2b-4c3d-9e10-000000000001
    name: stage
    selector: [conversation, stage]
    value: ''
    value_type: string
  - description: 上一輪查到的同仁姓名
    id: 4f6a2b10-1a2b-4c3d-9e10-000000000002
    name: pending_name
    selector: [conversation, pending_name]
    value: ''
    value_type: string
  - description: 上一輪查到的分機號碼
    id: 4f6a2b10-1a2b-4c3d-9e10-000000000003
    name: pending_ext
    selector: [conversation, pending_ext]
    value: ''
    value_type: string
  - description: 上一輪查到的部門
    id: 4f6a2b10-1a2b-4c3d-9e10-000000000004
    name: pending_dept
    selector: [conversation, pending_dept]
    value: ''
    value_type: string
  - description: 上一輪查到的地區
    id: 4f6a2b10-1a2b-4c3d-9e10-000000000005
    name: pending_loc
    selector: [conversation, pending_loc]
    value: ''
    value_type: string
  environment_variables: []
  features:
    file_upload: {}
    opening_statement: |-
      您好!我是凌群電腦內部同仁分機查詢小幫手。

      請直接輸入想查詢的同仁姓名(例如:王小明),我找到分機後會問您的email,再把分機寄給您。
    retriever_resource:
      enabled: false
    sensitive_word_avoidance:
      enabled: false
    speech_to_text:
      enabled: false
    suggested_questions: []
    suggested_questions_after_answer:
      enabled: false
    text_to_speech:
      enabled: false
      language: ''
      voice: ''
  graph:
    edges:
    - id: start-if_stage
      source: start
      sourceHandle: source
      target: if_stage
      targetHandle: target
    - id: if_stage-true-validate_email
      source: if_stage
      sourceHandle: 'true'
      target: validate_email
      targetHandle: target
    - id: if_stage-false-lookup
      source: if_stage
      sourceHandle: 'false'
      target: lookup
      targetHandle: target
    - id: validate_email-if_valid_email
      source: validate_email
      sourceHandle: source
      target: if_valid_email
      targetHandle: target
    - id: if_valid_email-true-send_email
      source: if_valid_email
      sourceHandle: 'true'
      target: send_email
      targetHandle: target
    - id: if_valid_email-false-answer_invalid_email
      source: if_valid_email
      sourceHandle: 'false'
      target: answer_invalid_email
      targetHandle: target
    - id: send_email-if_sent
      source: send_email
      sourceHandle: source
      target: if_sent
      targetHandle: target
    - id: if_sent-true-answer_sent
      source: if_sent
      sourceHandle: 'true'
      target: answer_sent
      targetHandle: target
    - id: if_sent-false-answer_send_failed
      source: if_sent
      sourceHandle: 'false'
      target: answer_send_failed
      targetHandle: target
    - id: answer_sent-reset_state
      source: answer_sent
      sourceHandle: source
      target: reset_state
      targetHandle: target
    - id: answer_send_failed-reset_state
      source: answer_send_failed
      sourceHandle: source
      target: reset_state
      targetHandle: target
    - id: lookup-if_found
      source: lookup
      sourceHandle: source
      target: if_found
      targetHandle: target
    - id: if_found-true-set_pending
      source: if_found
      sourceHandle: 'true'
      target: set_pending
      targetHandle: target
    - id: if_found-false-if_multiple
      source: if_found
      sourceHandle: 'false'
      target: if_multiple
      targetHandle: target
    - id: set_pending-answer_found
      source: set_pending
      sourceHandle: source
      target: answer_found
      targetHandle: target
    - id: if_multiple-true-answer_multiple
      source: if_multiple
      sourceHandle: 'true'
      target: if_same_name
      targetHandle: target
    - id: if_multiple-false-answer_not_found
      source: if_multiple
      sourceHandle: 'false'
      target: answer_not_found
      targetHandle: target
    - id: if_same_name-true-answer_multiple_same
      source: if_same_name
      sourceHandle: 'true'
      target: answer_multiple_same
      targetHandle: target
    - id: if_same_name-false-answer_multiple
      source: if_same_name
      sourceHandle: 'false'
      target: answer_multiple
      targetHandle: target
    nodes:
    - id: start
      type: custom
      position: {x: 0, y: 400}
      data: {desc: '', title: Start, type: start, variables: []}
    - id: if_stage
      type: custom
      position: {x: 260, y: 400}
      data:
        desc: 判斷這句話是「查姓名」還是「回覆email」
        title: 判斷目前流程狀態
        type: if-else
        cases:
        - case_id: 'true'
          id: 'true'
          logical_operator: and
          conditions:
          - id: cond-stage-await
            comparison_operator: 'is'
            varType: string
            value: await_email
            variable_selector: [conversation, stage]
    - id: validate_email
      type: custom
      position: {x: 520, y: 300}
      data:
        desc: 檢查使用者輸入的是不是合法email格式
        title: 驗證Email格式
        type: code
        code_language: python3
${yamlBlockScalar('code', validateEmailCode, 8)}
        variables:
        - variable: query
          value_selector: [sys, query]
        outputs:
          email: {type: string, children: null}
          valid: {type: string, children: null}
    - id: if_valid_email
      type: custom
      position: {x: 780, y: 300}
      data:
        desc: ''
        title: Email格式正確嗎?
        type: if-else
        cases:
        - case_id: 'true'
          id: 'true'
          logical_operator: and
          conditions:
          - id: cond-email-valid
            comparison_operator: 'is'
            varType: string
            value: 'true'
            variable_selector: [validate_email, valid]
    - id: send_email
      type: custom
      position: {x: 1040, y: 200}
      data:
        desc: 呼叫Resend API寄信(需先在「環境變數」設定 RESEND_API_KEY)。這條路徑會經過Dify api服務本身對外的網路,不受sandbox隔離限制,所以能真正寄到外部信箱,但也代表資料會經過Resend這個第三方雲端服務,不是全地端方案。
        title: 寄送Email(Resend,雲端測試用)
        type: http-request
        method: POST
        url: https://api.resend.com/emails
        authorization: {type: no-auth}
        headers: |-
          Content-Type: application/json
          Authorization: Bearer {{#env.RESEND_API_KEY#}}
        params: ''
        body:
          type: json
          data: |-
            {
              "from": "onboarding@resend.dev",
              "to": ["{{#validate_email.email#}}"],
              "subject": "凌群電腦分機查詢結果",
              "html": "<p>您好,您查詢的同仁 <b>{{#conversation.pending_name#}}</b> 分機為:<b>{{#conversation.pending_ext#}}</b></p><p>部門:{{#conversation.pending_dept#}}</p><p>地區:{{#conversation.pending_loc#}}</p>"
            }
        timeout: {connect: 10, read: 30, write: 30}
        retry_config:
          enabled: false
          max_retries: 1
          retry_interval: 1000
          exponential_backoff: {enabled: false, multiplier: 2, max_interval: 10000}
    - id: if_sent
      type: custom
      position: {x: 1300, y: 200}
      data:
        desc: ''
        title: 有寄成功嗎?
        type: if-else
        cases:
        - case_id: 'true'
          id: 'true'
          logical_operator: and
          conditions:
          - id: cond-sent-true
            comparison_operator: '='
            varType: number
            value: '200'
            variable_selector: [send_email, status_code]
    - id: answer_sent
      type: custom
      position: {x: 1560, y: 140}
      data:
        desc: ''
        title: 回覆已寄送
        type: answer
        variables: []
        answer: |-
          好的,已經把「{{#conversation.pending_name#}}」的分機({{#conversation.pending_ext#}})寄到 {{#validate_email.email#}} 囉!

          還想查其他同仁的分機嗎?直接輸入姓名即可。
    - id: answer_send_failed
      type: custom
      position: {x: 1560, y: 260}
      data:
        desc: ''
        title: 回覆寄送失敗
        type: answer
        variables: []
        answer: |-
          抱歉,信件寄送失敗了(狀態碼:{{#send_email.status_code#}},回應內容:{{#send_email.body#}})。

          常見原因是Resend API Key沒設定或設錯、或收件信箱不是你註冊Resend時用的信箱(免費方案的限制),請檢查「環境變數」裡的 RESEND_API_KEY。

          還想再查其他同仁的分機嗎?直接輸入姓名即可。
    - id: reset_state
      type: custom
      position: {x: 1560, y: 200}
      data:
        desc: 清空暫存狀態,回到可查詢下一位同仁
        title: 重設狀態
        type: assigner
        version: '2'
        items:
        - variable_selector: [conversation, stage]
          input_type: constant
          operation: over-write
          write_mode: over-write
          value: ''
        - variable_selector: [conversation, pending_name]
          input_type: constant
          operation: over-write
          write_mode: over-write
          value: ''
        - variable_selector: [conversation, pending_ext]
          input_type: constant
          operation: over-write
          write_mode: over-write
          value: ''
        - variable_selector: [conversation, pending_dept]
          input_type: constant
          operation: over-write
          write_mode: over-write
          value: ''
        - variable_selector: [conversation, pending_loc]
          input_type: constant
          operation: over-write
          write_mode: over-write
          value: ''
    - id: answer_invalid_email
      type: custom
      position: {x: 1040, y: 460}
      data:
        desc: ''
        title: 回覆Email格式錯誤
        type: answer
        variables: []
        answer: 這個看起來不是有效的email格式,請重新輸入你的email地址(例如:name@example.com)。
    - id: lookup
      type: custom
      position: {x: 520, y: 560}
      data:
        desc: 從凌群電腦9個地區的分機資料庫中比對姓名
        title: 查詢分機資料庫
        type: code
        code_language: python3
${yamlBlockScalar('code', lookupCode, 8)}
        variables:
        - variable: query
          value_selector: [sys, query]
        outputs:
          status: {type: string, children: null}
          same_name: {type: string, children: null}
          name: {type: string, children: null}
          ext: {type: string, children: null}
          dept: {type: string, children: null}
          loc: {type: string, children: null}
          summary: {type: string, children: null}
          count: {type: number, children: null}
    - id: if_found
      type: custom
      position: {x: 780, y: 560}
      data:
        desc: ''
        title: 有找到唯一一筆嗎?
        type: if-else
        cases:
        - case_id: 'true'
          id: 'true'
          logical_operator: and
          conditions:
          - id: cond-status-single
            comparison_operator: 'is'
            varType: string
            value: single
            variable_selector: [lookup, status]
    - id: set_pending
      type: custom
      position: {x: 1040, y: 660}
      data:
        desc: 記住這輪查到的人,等下一句回覆email時使用
        title: 記住查詢結果
        type: assigner
        version: '2'
        items:
        - variable_selector: [conversation, pending_name]
          input_type: variable
          operation: over-write
          write_mode: over-write
          value: [lookup, name]
        - variable_selector: [conversation, pending_ext]
          input_type: variable
          operation: over-write
          write_mode: over-write
          value: [lookup, ext]
        - variable_selector: [conversation, pending_dept]
          input_type: variable
          operation: over-write
          write_mode: over-write
          value: [lookup, dept]
        - variable_selector: [conversation, pending_loc]
          input_type: variable
          operation: over-write
          write_mode: over-write
          value: [lookup, loc]
        - variable_selector: [conversation, stage]
          input_type: constant
          operation: over-write
          write_mode: over-write
          value: await_email
    - id: answer_found
      type: custom
      position: {x: 1300, y: 660}
      data:
        desc: ''
        title: 回覆查詢結果並問Email
        type: answer
        variables: []
        answer: |-
          查到了!

          姓名:{{#lookup.name#}}
          分機:{{#lookup.ext#}}
          部門:{{#lookup.dept#}}
          地區:{{#lookup.loc#}}

          請問要把這個分機寄到你的email嗎?請直接輸入你的email地址。
    - id: if_multiple
      type: custom
      position: {x: 1040, y: 820}
      data:
        desc: ''
        title: 有多筆符合嗎?
        type: if-else
        cases:
        - case_id: 'true'
          id: 'true'
          logical_operator: and
          conditions:
          - id: cond-status-multiple
            comparison_operator: 'is'
            varType: string
            value: multiple
            variable_selector: [lookup, status]
    - id: if_same_name
      type: custom
      position: {x: 1300, y: 720}
      data:
        desc: 判斷是不是「同名同姓、分屬不同部門」的狀況
        title: 是同名同姓嗎?
        type: if-else
        cases:
        - case_id: 'true'
          id: 'true'
          logical_operator: and
          conditions:
          - id: cond-same-name
            comparison_operator: 'is'
            varType: string
            value: 'true'
            variable_selector: [lookup, same_name]
    - id: answer_multiple_same
      type: custom
      position: {x: 1560, y: 680}
      data:
        desc: ''
        title: 回覆同名同姓多筆
        type: answer
        variables: []
        answer: |-
          查到 {{#lookup.count#}} 位同名同姓的「{{#lookup.name#}}」,分屬不同部門,請問是指哪一位?

          {{#lookup.summary#}}

          請重新輸入完整姓名並加上部門或地區(例如:「行銷事業群 陳祐萱」),幫我確認是哪一位。
    - id: answer_multiple
      type: custom
      position: {x: 1560, y: 800}
      data:
        desc: ''
        title: 回覆多筆符合
        type: answer
        variables: []
        answer: |-
          找到 {{#lookup.count#}} 筆符合的同仁,請問是指哪一位?

          {{#lookup.summary#}}

          請重新輸入更完整的姓名。
    - id: answer_not_found
      type: custom
      position: {x: 1300, y: 900}
      data:
        desc: ''
        title: 回覆查無此人
        type: answer
        variables: []
        answer: 抱歉,查無此人,請確認姓名是否正確(直接輸入姓名即可,例如:王小明)。
`;

const outPath = path.join(__dirname, '..', '分機查詢小幫手.yml');
fs.writeFileSync(outPath, yaml, 'utf8');
console.log('wrote', outPath, 'bytes:', Buffer.byteLength(yaml, 'utf8'));
