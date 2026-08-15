// femGen 三向对照：文档声称支持但 femGen 可能不认的语法
import { parseFEMS } from './femParser.test.mjs';

const tests = [
  ['module 带参数', 'module CoderSandbox(task_var):\n  flow:\n    [IN] -> [OUT]\n'],
  ['human as 语法', 'action seer @human(@player) as (@预言家):\n  prompt: "hi"\n'],
  ['顶层 flow: 块', 'flow:\n  [START] -> [END]\n'],
  ['中文模块名', 'module 战斗:\n  flow:\n    [IN] -> [OUT]\n'],
  ['中文 action 名', 'action 开场白 @ai(@队长):\n  prompt: "hi"\n'],
];

for (const [name, text] of tests) {
  try {
    parseFEMS(text);
    console.log('OK   ' + name);
  } catch (e) {
    console.log('ERR  ' + name + ': ' + e.message.slice(0, 90));
  }
}
