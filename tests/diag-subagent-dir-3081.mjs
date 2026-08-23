// 诊断：子代理会话目录在哪个 workspace、存活多久
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = 'http://127.0.0.1:3081';
const ROOT = 'D:/myFiles/dsh/dsh-home/sessions';

const SCRIPT = `meta:
  name = diag-subagent-dir
  session = new

actors:
  ai @tester

action reply @ai(@tester):
  prompt: 只回复两个字：收到。不要调用任何工具。
  scope: [@tester]

mainflow:
  [START] -> reply -> [END]
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const res = await fetch(`${BASE}/dsh-femwa/create-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fems: SCRIPT }),
  });
  const created = await res.json();
  console.log('create-session:', JSON.stringify(created));

  // 全 workspace 轮询（150ms 间隔，8 分钟）
  const deadline = Date.now() + 480000;
  let last = new Map(); // id -> {firstSeen, lastSeen}
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/dsh-femwa/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;

  const scan = () => {
    try {
      for (const ws of fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory())) {
        const wsDir = path.join(ROOT, ws.name);
        let names;
        try { names = fs.readdirSync(wsDir); } catch { continue; }
        for (const n of names) {
          if (!last.has(n)) {
            last.set(n, { ws: ws.name, firstSeen: Date.now() });
            const log = path.join(wsDir, n, 'session.jsonl.zstd');
            let head = '';
            if (fs.existsSync(log)) {
              try {
                const t = zlib.zstdDecompressSync(fs.readFileSync(log)).toString('utf8');
                head = t.split('\n')[0]?.slice(0, 160) ?? '';
                const m = t.match(/"origin":"([^"]+)"/);
                head += m ? ` | origin=${m[1]}` : '';
              } catch { head = '(zstd 未写完)'; }
            }
            console.log(`[new-dir] ${ws.name}/${n} at +${Date.now() - t0}ms head=${head}`);
          } else {
            const rec = last.get(n);
            const log = path.join(ROOT, rec.ws, n, 'session.jsonl.zstd');
            if (fs.existsSync(log) && Date.now() - rec.lastSeen > 2000) {
              rec.lastSeen = Date.now();
            }
          }
        }
      }
    } catch (e) { console.log('[scan error]', String(e)); }
  };
  const t0 = Date.now();
  const scanTimer = setInterval(scan, 150);

  while (Date.now() < deadline) {
    const { done: sseDone, value } = await reader.read();
    if (sseDone) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      const data = JSON.parse(line.slice(5));
      console.log(`[event] +${Date.now() - t0}ms ${data.type} ${JSON.stringify(data.data ?? {}).slice(0, 120)}`);
      if (['flow_done', 'flow_error', 'flow_stopped'].includes(data.type)) { done = true; }
    }
    if (done) break;
  }
  clearInterval(scanTimer);
  ctrl.abort();
  await sleep(3000);
  console.log('\n--- 最终存活目录检查（等 3s 后）---');
  scan();
  console.log('\n=== 诊断结束 ===');
}

main().catch(e => { console.error('!! 失败:', e); process.exit(1); });
