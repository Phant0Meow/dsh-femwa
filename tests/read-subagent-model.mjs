// 解析 3081 子代理会话的 request/header 模型（验证脚本配套）
import fs from 'node:fs';
import zlib from 'node:zlib';

const ROOT = 'D:/myFiles/dsh/dsh-home/sessions/--D-myFiles-dsh-dsh-meow--';
const ids = process.argv.slice(2);
for (const id of ids) {
  const p = `${ROOT}/${id}/session.jsonl.zstd`;
  if (!fs.existsSync(p)) { console.log(id, 'NOT FOUND'); continue; }
  const t = zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8');
  const ms = [...t.matchAll(/"type":"request\/header"[\s\S]*?"config":\s*\{([\s\S]*?)\}/g)];
  console.log(id, 'header count:', ms.length);
  for (const m of ms) {
    const cfg = m[1];
    const prov = cfg.match(/"provider":"([^"]+)"/)?.[1];
    const model = cfg.match(/"model":"([^"]+)"/)?.[1];
    const eff = cfg.match(/"reasoningEffort":"([^"]+)"/)?.[1];
    console.log('  config:', JSON.stringify({ provider: prov, model, reasoningEffort: eff }));
  }
  if (ms.length === 0) {
    const all = [...t.matchAll(/"model":"([^"]+)"/g)].map(x => x[1]);
    console.log('  any model refs:', JSON.stringify([...new Set(all)].slice(0, 8)));
  }
}
