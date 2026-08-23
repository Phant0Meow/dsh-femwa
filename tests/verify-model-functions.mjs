// 函数级验证：从构建产物 lib/index.js 提取 resolveMainModel + resolveSourceModel
// （与 3081 运行的是同一份 bundle），用 mock 主会话/默认模型断言行为。
import fs from 'node:fs';

const lib = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

function extract(name) {
  const start = lib.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in lib/index.js`);
  // 从函数头扫到配平的大括号
  let depth = 0, i = lib.indexOf('{', start);
  for (; i < lib.length; i++) {
    if (lib[i] === '{') depth++;
    else if (lib[i] === '}') { depth--; if (depth === 0) break; }
  }
  return lib.slice(start, i + 1);
}

const resolveMainModel = new Function(`return (${extract('resolveMainModel')})`)();
const resolveSourceModel = new Function(`return (${extract('resolveSourceModel')})`)();

const cfg = { dshProvider: 'deepseek-official', model: 'deepseek-v4-flash' };
const resolved = cfg;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`✓ ${name}: ${JSON.stringify(actual)}`); }
  else { fail++; console.log(`✗ ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`); }
}

// ── resolveMainModel ──
// 1) 主会话有最近请求头（flash，UI 会话内切换过）→ 用它
check('mainModel: 请求头 flash',
  resolveMainModel({ session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } }, { currentSelection: () => ({ provider: 'p', model: 'm' }) }),
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' });

// 2) 请求头 pro → 跟随 pro（会话内切到 pro 时子代理也必须 pro）
check('mainModel: 请求头 pro（会话内切换）',
  resolveMainModel({ session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'off' } }) } }, { currentSelection: () => ({ provider: 'p', model: 'm' }) }),
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' });

// 3) 无请求头 → 兜底用户保存的默认
check('mainModel: 无请求头 → 保存默认',
  resolveMainModel({ session: {} }, { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' }) }),
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' });

// 4) 请求头字段残缺 → 跳过 → 兜底保存默认
check('mainModel: 请求头残缺 → 兜底',
  resolveMainModel({ session: { requestHeader: () => ({ config: { provider: '', model: 'x' } }) } }, { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }),
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' });

// 5) 全无 → undefined（调用方回退配置）
check('mainModel: 全无 → undefined',
  resolveMainModel({ session: {} }, undefined),
  undefined);

// ── resolveSourceModel ──
// 6) 空 source + mainModel=flash → flash
check('source空: 跟随主模型 flash',
  resolveSourceModel(resolved, '', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });

// 7) 空 source + mainModel=pro → pro（主模型切 pro，子代理必须跟）
check('source空: 跟随主模型 pro',
  resolveSourceModel(resolved, '', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
  { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } });

// 8) 空 source + 无 mainModel → 配置兜底
check('source空: 无 mainModel → 配置兜底',
  resolveSourceModel(resolved, '', undefined),
  { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });

// 9) 显式 provider/model 双写 → 原样（不受主模型影响）
check('source: provider/model 双写',
  resolveSourceModel(resolved, 'deepseek-official/deepseek-v4-pro', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } });

// 10) 裸 id → 默认 provider + id
check('source: 裸 id',
  resolveSourceModel(resolved, 'deepseek-v4-pro', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } });

// 11) source 带空白 → trim 后仍正确
check('source: trim',
  resolveSourceModel(resolved, '  deepseek-v4-pro  ', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } });

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
