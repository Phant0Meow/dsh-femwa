// 复现 goblin-demo.fems 在 3081 完整链路下的 human 节点输入问题。
// 路径：create-session -> SSE 等 human_wait -> 模拟前端赋值框提交 -> 观察事件流。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3081';
const FEMS = fs.readFileSync('D:/myFiles/dsh/dsh-femwa/python/goblin-demo.fems', 'utf8');

async function main() {
  // 1) 创建会话并触发 run
  const res = await fetch(`${BASE}/dsh-femwa/create-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fems: FEMS }),
  });
  const created = await res.json();
  console.log('create-session:', JSON.stringify(created));
  if (!created.ok) { console.log('!! create-session failed'); return; }
  const sessionId = created.sessionId;

  // 2) 连 SSE，等 human_wait
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/dsh-femwa/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  let humanWait = null;
  const deadline = Date.now() + 180000; // 3 分钟

  function pushEvent(ev, data) {
    events.push(ev);
    console.log(`[event] ${ev} ${JSON.stringify(data).slice(0, 200)}`);
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
      pushEvent(ev, data.data ?? {});
      if (ev === 'human_wait') {
        humanWait = data.data;
        break;
      }
      if (['flow_done', 'flow_error', 'flow_stopped', 'bridge_run_ended'].includes(ev)) {
        ctrl.abort();
        console.log('\n=== 终止事件已到，未进入 human_wait ===');
        return;
      }
    }
    if (humanWait) break;
  }

  if (!humanWait) {
    console.log('\n!! 超时未见 human_wait');
    ctrl.abort();
    return;
  }

  console.log(`\n=== human_wait @ ${humanWait.node_name} wait_key=${humanWait.wait_key}`);
  console.log('out_vars =', JSON.stringify(humanWait.out_vars));
  console.log('prompt   =', humanWait.prompt);

  // 3a) 模拟「只填赋值框，不填聊天框」——用户遇到的场景
  console.log('\n--- 尝试 A：只填变量 player_choice="接受"，chat_text 为空 ---');
  const rA = await fetch(`${BASE}/dsh-femwa/human-input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wait_key: humanWait.wait_key,
      chat_text: '',
      variables: { player_choice: '接受' },
    }),
  });
  console.log('响应:', rA.status, await rA.text());

  // 等几秒看引擎有没有动静
  await new Promise(r => setTimeout(r, 5000));
  const evSince = events.slice();
  console.log(`（5 秒内新增事件 ${events.length - evSince.length} 条）`);

  // 3b) 对照：chat_text + 变量
  console.log('\n--- 尝试 B：chat_text="接受" + variables={player_choice:"接受"} ---');
  const rB = await fetch(`${BASE}/dsh-femwa/human-input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wait_key: humanWait.wait_key,
      chat_text: '接受',
      variables: { player_choice: '接受' },
    }),
  });
  console.log('响应:', rB.status, await rB.text());

  // 4) 继续收事件直到终止
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
      pushEvent(data.type, data.data ?? {});
      if (['flow_done', 'flow_error', 'flow_stopped', 'bridge_run_ended'].includes(data.type)) {
        ctrl.abort();
        console.log('\n=== 复现结束 ===');
        return;
      }
    }
  }
  console.log('\n!! 超时');
  ctrl.abort();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
