// femParser 变量声明校验单元测试（零 token、零浏览器）
// 运行前先生成测试 bundle（.gitignore 已排除）：
//   node node_modules/esbuild/bin/esbuild femGen/src/femParser.jsx --bundle --format=esm --outfile=tests/femParser.test.mjs --log-level=error
import fs from 'node:fs';
import { parseFEMS } from './femParser.test.mjs';

const PY = 'D:/myFiles/dsh/dsh-femwa/python';
const read = (f) => fs.readFileSync(`${PY}/${f}`, 'utf8');
const readAny = (f) => fs.readFileSync(f, 'utf8');

const cases = [
  // [文件名, 期望: 'ok' | 期望错误信息包含的子串]
  ['goblin-demo.fems', 'ok'],                       // 修复版：@hero 已声明、字面量带引号
  ['goblin-mini.fems', 'ok'],
  ['goblin-v2.fems', 'ok'],                         // 带顶层 # 注释 + module par 完整演示剧本
  ['test-if-fork-join.fems', 'ok'],                 // 现有语法测试不误报
  ['test-for-if.fems', 'ok'],
  ['test-par.fems', 'ok'],
  ['test-minimal.fems', 'ok'],
  ['test-human.fems', 'ok'],
  ['test-ai.fems', 'ok'],
  ['test-tool.fems', 'ok'],
  ['test-database-meta.fems', 'ok'],
  ['for-repro-declare.fems', '未声明的变量 "ai"'],   // @hero 已声明但裸词 ai 无引号 → 应报错
];

// 真实项目剧本（防误报）：狼人杀 + 用户项目
const realScripts = [
  'D:/myFiles/dsh/dsh-femwa/user_data/projects/狼人杀/狼人杀.fems',
  'D:/myFiles/dsh/dsh-femwa/user_data/projects/debug神器/debug神器.fems',
  'D:/myFiles/dsh/dsh-femwa/user_data/projects/fiat/luxfiat.fems',
];

// 变体：goblin 未修版（@hero 未声明 + 裸词）
const bad1 = read('goblin-demo.fems').replace('  @hero = ""\n', '');
// 变体：只去掉引号（@hero 已声明但裸词 ai）
const bad2 = read('goblin-demo.fems')
  .replace('== "ai"', '== ai')
  .replace('== "human"', '== human');

let pass = 0, fail = 0;
for (const [fname, expect] of cases) {
  try {
    parseFEMS(read(fname));
    if (expect === 'ok') { console.log(`✅ PASS ${fname}`); pass++; }
    else { console.log(`❌ FAIL ${fname}: 期望报错（${expect}）但通过了`); fail++; }
  } catch (e) {
    if (expect === 'ok') { console.log(`❌ FAIL ${fname}: 意外报错: ${e.message}`); fail++; }
    else if (e.message.includes(expect)) { console.log(`✅ PASS ${fname}: 报错符合预期: ${e.message.slice(0, 90)}`); pass++; }
    else { console.log(`❌ FAIL ${fname}: 报错不符预期.\n  期望含: ${expect}\n  实际: ${e.message}`); fail++; }
  }
}

// 手工变体
const variants = [
  ['bad1(@hero未声明)', bad1, '未在 vars: 中声明'],
  ['bad2(裸词ai未加引号)', bad2, '未声明的变量 "ai"'],
];
for (const [name, text, expectMsg] of variants) {
  try {
    parseFEMS(text);
    console.log(`❌ FAIL ${name}: 期望报错（${expectMsg}）但通过了`);
    fail++;
  } catch (e) {
    if (e.message.includes(expectMsg)) { console.log(`✅ PASS ${name}: 报错符合预期: ${e.message.slice(0, 110)}`); pass++; }
    else { console.log(`❌ FAIL ${name}: 报错不符.\n  期望含: ${expectMsg}\n  实际: ${e.message}`); fail++; }
  }
}

// 真实项目剧本
for (const path of realScripts) {
  const name = path.split('/').pop();
  try {
    parseFEMS(readAny(path));
    console.log(`✅ PASS ${name}（真实剧本）`);
    pass++;
  } catch (e) {
    console.log(`❌ FAIL ${name}: 真实剧本报错: ${e.message.slice(0, 150)}`);
    fail++;
  }
}

console.log(`\n===== 结果: ${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
