// 全局注释剥离专项测试：内存版 stripComments / stripLineComments
import fs from 'node:fs';
import { stripComments, stripLineComments, parseFEMS } from './femParser.test.mjs';

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
check('魔法注释保留', stripLineComments('# for loop -> [ASK] while true'), '# for loop -> [ASK] while true');
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

console.log(`\n===== 结果: ${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
