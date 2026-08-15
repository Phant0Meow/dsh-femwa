// goblin-v2 完整链路自动验证：create-session → SSE → 自动处理 human 输入 → 直到 flow_done/flow_error
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3081';
const FEMS = fs.readFileSync('D:/myFiles/dsh/dsh-femwa/python/goblin-v2.fems', 'utf8');
const MAX_MS = 600000;

async function main() {
  const res = await fetch(`${BASE}/dsh-femwa/create-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fems: FEMS }),
  });
  const created = await res.json();
  console.log('create-session:', JSON.stringify(created));
  if (!created.ok) { console.log('!! FAIL create-session'); return; }

  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/dsh-femwa/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const summary = [];
  let humanCount = 0;
  let retryCount = 0;
  const deadline = Date.now() + MAX_MS;

  function log(ev, data) {
    const d = data ?? {};
    if (['flow_start', 'step', 'human_wait', 'human_done', 'flow_done', 'flow_error', 'ai_retry', 'human_input_error', 'module_enter', 'module_exit'].includes(ev)) {
      let line = `[${ev}]`;
      if (ev === 'step') line += ` ${d.current_node}`;
      if (ev === 'human_wait') line += ` node=${d.node_name} out_vars=${JSON.stringify(d.out_vars)}`;
      if (ev === 'flow_error') line += ` ${String(d.error).slice(0, 200)}`;
      if (ev === 'ai_retry') { line += ` attempt=${d.attempt} errors=${JSON.stringify(d.errors)}`; retryCount++; }
      console.log(line);
    }
    summary.push(ev);
  }

  async function sendHuman(waitKey, chatText, variables) {
    const r = await fetch(`${BASE}/dsh-femwa/human-input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wait_key: waitKey, chat_text: chatText, variables }),
    });
    console.log(`  -> human-input ${r.status}`);
  }

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      const data = JSON.parse(line.slice(5));
      const ev = data.type;
      log(ev, data.data ?? {});
      const d = data.data ?? {};

      if (ev === 'human_wait') {
        humanCount++;
        const node = d.node_name || '';
        if (node === '[ASK]') {
          await sendHuman(d.wait_key, '接受', { player_choice: '接受' });
        } else if (node === '[HU_ATK]') {
          await sendHuman(d.wait_key, '我用魔法攻击！', { 'damage_report.@hero': '15' });
        } else if (node === '[LP]') {
          await sendHuman(d.wait_key, '我拿到了哥布林护符！', {});
        } else {
          console.log(`  !! 未知 human 节点: ${node}，提交空输入`);
          await sendHuman(d.wait_key, '好', {});
        }
      }
      if (['flow_done', 'flow_error', 'bridge_run_ended'].includes(ev)) {
        ctrl.abort();
        console.log(`\n=== 结束: ${ev} ===`);
        console.log('human 输入次数:', humanCount);
        console.log('AI 重试次数:', retryCount);
        const types = summary;
        console.log('关键事件序列:', types.join(' -> '));
        return;
      }
    }
  }
  console.log('\n!! 超时');
  ctrl.abort();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
