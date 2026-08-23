// 3081 实测 v2：子代理模型选择（2026-08-19 改动验证）
// 剧本 A：actor 无 source → 子代理应跟随主模型（当前默认 deepseek-v4-flash）
// 剧本 B：actor source:deepseek-official/deepseek-v4-pro → 子代理应精确用 pro
// 捕获法：SSE 收到 ai_request 后立即轮询会话目录，抢在归档删除前读出子代理
//         session.jsonl.zstd 的 request/header（对照实验法沿用 2026-08-18）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = 'http://127.0.0.1:3081';
const SESSIONS_ROOT = 'D:/myFiles/dsh/dsh-home/sessions';
const WS = '--D-myFiles-dsh-dsh-meow--';
const CAPTURE_DIR = 'D:/myFiles/dsh/dsh-femwa/tests/.subagent-captures';

const SCRIPT_NO_SOURCE = `meta:
  name = verify-model-follow
  session = new

actors:
  ai @tester

action reply @ai(@tester):
  prompt: 只回复两个字：收到。不要调用任何工具。
  scope: [@tester]

mainflow:
  [START] -> reply -> [END]
`;

const SCRIPT_PRO = SCRIPT_NO_SOURCE.replace(
  '  ai @tester\n',
  '  ai @tester = source:deepseek-official/deepseek-v4-pro\n',
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readZstd(file) {
  const buf = zlib.zstdDecompressSync(fs.readFileSync(file));
  return buf.toString('utf8');
}

function modelFromLog(text) {
  const headers = [...text.matchAll(/"type":"request\/header"[\s\S]*?"config":\s*\{([\s\S]*?)\}/g)];
  if (headers.length > 0) {
    const out = [];
    for (const m of headers) {
      const cfg = m[1];
      const prov = cfg.match(/"provider":"([^"]+)"/)?.[1];
      const model = cfg.match(/"model":"([^"]+)"/)?.[1];
      out.push(`${prov}/${model}`);
    }
    return [...new Set(out)];
  }
  const refs = [...text.matchAll(/"model":"([^"]+)"/g)].map(x => x[1]);
  return [...new Set(refs)];
}

/** 扫描会话目录，捕获新的子代理会话（uuid 目录且 meta.origin=subagent）。 */
async function captureSubagent(knowIds, label, deadline) {
  const wsDir = path.join(SESSIONS_ROOT, WS);
  const known = new Set(knowIds);
  while (Date.now() < deadline) {
    let entries = [];
    try { entries = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { /* dir busy */ }
    for (const ent of entries) {
      if (!ent.isDirectory() || known.has(ent.name)) continue;
      if (!/^[0-9a-f]{8}-/.test(ent.name)) continue; // uuid 形态
      known.add(ent.name);
      const log = path.join(wsDir, ent.name, 'session.jsonl.zstd');
      if (!fs.existsSync(log)) continue;
      let text = null;
      for (let i = 0; i < 30; i++) { // 最多等 1.5s 让文件写完
        try { text = readZstd(log); break; } catch { await sleep(50); }
      }
      if (text === null) { console.log(`[capture] ${ent.name}: 文件未读完，跳过`); continue; }
      const isSub = text.includes('"origin":"subagent"') || text.includes('"origin": "subagent"');
      const models = modelFromLog(text);
      if (isSub && models.length > 0) {
        console.log(`[capture] ${label} 子代理 ${ent.name} models=${JSON.stringify(models)}`);
        fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        fs.copyFileSync(log, path.join(CAPTURE_DIR, `${label}-${ent.name}.jsonl.zstd`));
        return { id: ent.name, models };
      }
      console.log(`[capture] ${ent.name} isSub=${isSub} models=${JSON.stringify(models)}`);
    }
    await sleep(50);
  }
  return null;
}

async function runScript(name, fems, captureDeadline) {
  console.log(`\n========== ${name} ==========`);
  const res = await fetch(`${BASE}/dsh-femwa/create-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fems }),
  });
  const created = await res.json();
  if (!created.ok) { console.log('!! create-session failed:', JSON.stringify(created)); return null; }
  const sessionId = created.sessionId;
  console.log('create-session:', sessionId);

  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/dsh-femwa/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminal = null;
  let captured = null;
  const known = new Set(fs.readdirSync(path.join(SESSIONS_ROOT, WS), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name));

  while (Date.now() < captureDeadline) {
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
      const d = data.data ?? {};
      console.log(`[event] ${ev} ${JSON.stringify(d).slice(0, 140)}`);
      if (ev === 'ai_request' && captured === null) {
        captured = captureSubagent(known, name.includes('A') ? 'A' : 'B', captureDeadline);
      }
      if (['flow_done', 'flow_error', 'flow_stopped', 'bridge_run_ended'].includes(ev)) {
        terminal = ev;
        ctrl.abort();
        break;
      }
    }
    if (terminal) break;
  }
  if (captured !== null) captured = await captured;
  if (!terminal && captured === null) { console.log('!! 超时'); ctrl.abort(); }
  return { sessionId, terminal, captured };
}

async function main() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const t0 = Date.now();
  const a = await runScript('剧本A（无 source，应跟随主模型）', SCRIPT_NO_SOURCE, t0 + 180000);
  const b = await runScript('剧本B（source pro，应精确用 pro）', SCRIPT_PRO, Date.now() + 180000);
  console.log('\n===== 结果 =====');
  console.log('剧本A（无 source）:', a?.captured ? JSON.stringify(a.captured.models) : '未捕获');
  console.log('剧本B（source pro）:', b?.captured ? JSON.stringify(b.captured.models) : '未捕获');
}

main().catch(e => { console.error('!! 脚本失败:', e); process.exit(1); });
