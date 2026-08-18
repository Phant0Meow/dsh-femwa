// 全局注释剥离专项测试：内存版 stripComments / stripLineComments
import fs from 'node:fs';
import { stripComments, stripLineComments, parseFEMS, extractHashSketch } from './femParser.test.mjs';

let pass = 0, fail = 0;
function check(name, actual, expect) {
  if (actual === expect) { console.log(`✅ PASS ${name}`); pass++; }
  else { console.log(`❌ FAIL ${name}:\n  期望: ${JSON.stringify(expect)}\n  实际: ${JSON.stringify(actual)}`); fail++; }
}

// ── 行级剥离 ──
check('行内 # 注释', stripLineComments('player_choice = ""  # 这是注释'), 'player_choice = ""  ');
check('行内 // 注释', stripLineComments('name = "x" // comment'), 'name = "x" ');
check('整行 # 注释', stripLineComments('# ---------- 1. 元信息 ----------'), '');
check('整行 // 注释', stripLineComments('// comment line'), '');
check('引号内 # 保留', stripLineComments('name = "a#b"'), 'name = "a#b"');
check('引号内 // 保留', stripLineComments('msg = "http://x"'), 'msg = "http://x"');
check('引号后 # 截断', stripLineComments('name = "a" # tail'), 'name = "a" ');
check('单引号内 # 保留', stripLineComments("msg = 'a#b'"), "msg = 'a#b'");
check('魔法注释按普通注释剥离（特性已废弃）', stripLineComments('# for loop -> [ASK] while true'), '');
check('无注释原样', stripLineComments('  scope: [@a, @b]'), '  scope: [@a, @b]');
check('保留行首缩进', stripLineComments('    out: x += 1  # 注释'), '    out: x += 1  ');

// ── 整篇剥离（prompt 块豁免）──
const sample = `# 顶层注释
meta:
    name = "哥布林 # 名字"   # 行内注释
    version = 1.0
    system_safety = |
        禁止 # 血腥。
        这里 // 也是内容。
    output_style = "a#b"

action opening @ai(@guildmaster):
    prompt: |
        说到 # 话题和 // 斜杠都在。
        http://example.com 保留。
    scope: [@guildmaster, @player]   // 尾部注释
mainflow:
    [START] -> [END]
`;
const stripped = stripComments(sample.split('\n'));
check('顶层注释行清空', stripped[0], '');
check('行内注释清除但引号内保留', stripped[2], '    name = "哥布林 # 名字"   ');
check('prompt 块内 # 保留', stripped[5], '        禁止 # 血腥。');
check('prompt 块内 // 保留', stripped[6], '        这里 // 也是内容。');
check('引号内 # 保留(meta)', stripped[7], '    output_style = "a#b"');
check('prompt 多行 # 保留', stripped[11], '        说到 # 话题和 // 斜杠都在。');
check('prompt 多行 URL 保留', stripped[12], '        http://example.com 保留。');
check('scope 行尾 // 清除', stripped[13], '    scope: [@guildmaster, @player]   ');
check('flow 行原样', stripped[15], '    [START] -> [END]');

// ── 完整解析验证（剥离后能正常编译）──
const script = `# 带注释的完整剧本
meta:
    name = "test # comments"
    session = new

vars:
    @m = ""      # 循环变量
    members = [@a, @b]

actors:
    ai @a = soul:1
    ai @b = soul:2

action mark @assign:
    out: count += 1

mainflow:
    # for loop -> [ASK] while true  （魔法注释回边）
    [START] -> for @m in members:
        -> [C]:mark ->
    -> [END]
`;
try {
  const r = parseFEMS(script);
  check('带注释完整剧本解析', `actors=${r.actors.length} actions=${r.actions.length}`, 'actors=2 actions=1');
} catch (e) {
  check('带注释完整剧本解析', '抛错: ' + e.message, 'actors=2 actions=1');
}

// ── 原文不可变验证 ──
const original = '# 注释\nmeta:\n    name = "x#y"\n';
stripComments(original.split('\n'));
check('原文不被修改', original, '# 注释\nmeta:\n    name = "x#y"\n');

// ═══ #sketch 注释块还原（编译第零步）═══

// 单元：extractHashSketch 还原行为
const skRaw = [
  'mainflow:',
  '    [START] -> [A] ->',
  '#sketch:',
  '#  [A] = 100, 50',
  '#  [B] = 200, 0',
  '',
  '    -> [END]',
];
const skRestored = extractHashSketch(skRaw).join('\n');
check(
  'extractHashSketch 还原 #sketch 块',
  skRestored,
  'mainflow:\n    [START] -> [A] ->\nsketch:\n  [A] = 100, 50\n  [B] = 200, 0\n\n    -> [END]'
);
check(
  'extractHashSketch 不动普通行',
  extractHashSketch(['# 普通注释', 'meta:', '    name = "x"']).join('\n'),
  '# 普通注释\nmeta:\n    name = "x"'
);

// 集成：顶层 #sketch 注释块 → mainflow.layout
const skScript = `meta:
    name = "sketch-test"
mainflow:
    [START] -> [A] -> [END]
#sketch:
#  [A] = 100, 50
#  [B] = 200, 0
`;
{
  const r = parseFEMS(skScript);
  check('顶层 #sketch 块解析出 layout', JSON.stringify(r.mainflow.layout), JSON.stringify({ '[A]': { dx: 100, dy: 50 }, '[B]': { dx: 200, dy: 0 } }));
}

// 集成：模块内 #sketch 注释块（生成端格式：# 在行首 + 原缩进）→ 模块 layout
const skModule = `meta:
    name = "mod-sketch"
module 子流程:
    flow:
        [IN] -> [M1] -> [OUT]
#    sketch:
#      [M1] = 30, 40
mainflow:
    [START] -> &子流程 -> [END]
`;
{
  const r = parseFEMS(skModule);
  const mod = r.modules.find((m) => m.name === '子流程');
  check('模块内 #sketch 块解析出 layout', JSON.stringify(mod && mod.layout), JSON.stringify({ '[M1]': { dx: 30, dy: 40 } }));
}

// 集成：块内手写 # 注释（剥一个 # 后残余）被正常去注释，不污染 layout
const skInnerComment = `meta:
    name = "sketch-comment"
mainflow:
    [START] -> [A] -> [END]
#sketch:
#  [A] = 1, 2
#  # 这是块内手写注释
`;
{
  const r = parseFEMS(skInnerComment);
  check('块内手写注释不污染 layout', JSON.stringify(r.mainflow.layout), JSON.stringify({ '[A]': { dx: 1, dy: 2 } }));
}

// 集成：无 sketch 时 layout 为空对象
{
  const r = parseFEMS('meta:\n    name = "no-sketch"\nmainflow:\n    [START] -> [END]\n');
  check('无 sketch 块时 layout 为空', JSON.stringify(r.mainflow.layout), '{}');
}

console.log(`\n===== 结果: ${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
