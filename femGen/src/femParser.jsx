// ═══════════════════════════════════════════════════════════════
// ═══ femParser.jsx ═══
// ═══════════════════════════════════════════════════════════════

import { TYPES, SPECIAL_COLORS, actionId } from './common';

function normalizeSymbols(str, context = 'global') {
  let s = str;
  // ═══ 全角符号标准化（注释剥离已由全局 stripComments 完成，此处不再处理注释）═══
  if (context !== 'prompt') {
    s = s
      .replace(/：/g, ':')
      .replace(/，/g, ',')
      .replace(/“/g, '"')
      .replace(/”/g, '"')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/【/g, '[')
      .replace(/】/g, ']')
      .replace(/｜/g, '|');
  }
  // flow 区域额外：-- 替换为 ->
  if (context === 'flow') {
    s = s.replace(/--/g, '->');
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════
// ═══ 全局注释剥离（编译第一步）═══
// ═══════════════════════════════════════════════════════════════
// 除 prompt 文本块内部与字符串引号内部外，所有 `#` 与 `//` 连同其后内容
// 清空到行尾。行首缩进保留（块结构依赖缩进）。

// 引号感知的行级注释剥离
function stripLineComments(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < line.length) {
        out += line[i + 1];
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#') {
      break;
    }
    if (c === '/' && line[i + 1] === '/') break;
    out += c;
  }
  return out;
}

// 找出所有多行文本块 [start, end) 行区间：
//   prompt: | / showprompt: |（action）以及 key = |（meta：system_safety 等）
function findPromptRanges(lines) {
  const ranges = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // 允许行尾带注释（全局剥离后该行会先被清成 prompt: |，此处宽松匹配）
    const isMultiStart =
      /^(?:prompt|showprompt):\s*[|｜]\s*(?:#.*)?$/.test(trimmed) ||
      /^@?[\w\u4e00-\u9fff]+\s*=\s*[|｜]\s*(?:#.*)?$/.test(trimmed);
    if (isMultiStart) {
      const fieldIndent = lines[i].length - lines[i].trimStart().length;
      let j = i + 1;
      while (j < lines.length) {
        const t2 = lines[j].trim();
        if (!t2) { j++; continue; }            // 空行算 prompt 内容
        const ind2 = lines[j].length - lines[j].trimStart().length;
        if (ind2 <= fieldIndent) break;        // 缩进回到字段层 → 块结束
        j++;
      }
      ranges.push([i + 1, j]);
      i = j;
      continue;
    }
    i++;
  }
  return ranges;
}

// ═══════════════════════════════════════════════════════════════
// ═══ #sketch 注释块还原（编译第零步，必须先于 stripComments）═══
// ═══════════════════════════════════════════════════════════════
// 生成端把 sketch 块写成注释（每行行首加 #）；这里检测 #sketch 标志，
// 把整个块取出、每行剥掉行首一个 #（# 后的空格即原缩进），还原为
// 普通 sketch: 块，再走正常链路解析。块内残余 #（手写注释）交由
// stripComments 正常去掉。
function extractHashSketch(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (/^#\s*sketch\s*:/.test(raw)) {
      out.push(raw.replace(/^#/, ''));       // 标志行剥一个 # → sketch:
      i++;
      while (i < lines.length && /^#/.test(lines[i])) {
        out.push(lines[i].replace(/^#/, '')); // 块内容行同样剥一个 #
        i++;
      }
    } else {
      out.push(raw);
      i++;
    }
  }
  return out;
}

// 全局注释剥离：parseFEMS 的第一步
function stripComments(lines) {
  const ranges = findPromptRanges(lines);
  return lines.map((raw, i) => {
    for (const [s, e] of ranges) {
      if (i >= s && i < e) return raw;          // prompt 文本块：原样保留
    }
    return stripLineComments(raw);
  });
}

function parseFEMS(text) {
  // 编译第零步：#sketch 注释块还原（必须先于全局去注释）
  // 编译第一步：内存版全局去注释（# 和 // 到行尾；prompt 块与引号内豁免）
  // 只处理内存副本，用户原文/窗口文本不受影响
  const lines = stripComments(extractHashSketch(text.split('\n')));
  const blocks = splitTopBlocks(lines);

  const result = {
    meta: {
      name: '',
      version: '1.0',
      owner: '',
      database: '',
      session: '',
      system_safety: '',
      output_style: '',
    },
    code: [],
    context: [],
    memory: [],
    vars: [],
    actors: [],
    actions: [],
    modules: [],
    mainflow: { nodeDecls: [], edges: [] },
  };

  let mainflowSketch = null; // 容错：顶层 sketch: 块（与 mainflow 同级）

  for (const block of blocks) {
    const h = block.header;
    if (h === 'meta:') {
      result.meta = parseMetaBlock(block.contentLines);
    } else if (h === 'code:') {
      result.code = parseCodeBlock(block.contentLines);
    } else if (h === 'vars:') {
      result.vars = parseVarsBlock(block.contentLines);
    } else if (h === 'actors:') {
      result.actors = parseActorsBlock(block.contentLines);
    } else if (h.startsWith('memory ')) {
      result.memory.push(
        parseMemoryOrContextBlock(h, block.contentLines, 'memory')
      );
    } else if (h.startsWith('context ')) {
      result.context.push(
        parseMemoryOrContextBlock(h, block.contentLines, 'context')
      );
    } else if (h.startsWith('action ')) {
      result.actions.push(parseActionBlock(h, block.contentLines));
    } else if (h.startsWith('module ')) {
      result.modules.push(parseModuleBlock(h, block.contentLines));
    } else if (h === 'sketch:') {
      // 暂存顶层草图，待 mainflow 解析后合并
      mainflowSketch = parseLayoutBlock(block.contentLines);
    } else if (h === 'mainflow:' || h === 'flow:') {
      // flow: 与 mainflow: 等价（编译器 build_blocks 均归为 flow 块）
      result.mainflow = parseMainflowBlock(block.contentLines);
      // 如果有与 mainflow 同级的 sketch 块，合并布局（外部覆盖内部）
      if (mainflowSketch) {
        result.mainflow.layout = { ...result.mainflow.layout, ...mainflowSketch };
        mainflowSketch = null;
      }
    } else {
      throw new Error(
        `未识别的顶层块: "${h}"。期望: meta:, code:, vars:, actors:, context:, memory:, action ..., module ..., mainflow:`
      );
    }
  }

  // 如果 sketch 在 mainflow 之前就已经读到，但 mainflow 始终未出现，则丢弃（不报错）
  // 如果 mainflow 已解析但之后还有 sketch 块，同样合并
  if (mainflowSketch && result.mainflow) {
    result.mainflow.layout = { ...result.mainflow.layout, ...mainflowSketch };
  }

  // 展平嵌套模块，为每个模块生成层级 path（从 mainflow 起）
  const topModules = result.modules;
  result.modules = [];
  function flattenModules(mods, parentPath) {
    for (const m of mods) {
      const path = [...parentPath, m.name];
      m.path = path;
      result.modules.push(m);
      if (m.subModules) {
        flattenModules(m.subModules, path);
        delete m.subModules; // 清理临时字段
      }
    }
  }
  flattenModules(topModules, ['mainflow']);

  // ═══ 变量声明校验：编译器原则，未声明必须报错，不静默兜底 ═══
  validateDeclarations(result);

  return result;
}

// ── 变量声明校验 ────────────────────────────────────────────
// 规则（与引擎一致）：
//   1. for 循环变量必须已在 vars: 声明（如 @hero = ""）
//   2. 条件表达式里的裸标识符必须是已声明变量 / actor / 循环变量，
//      字符串字面量必须带引号（== "ai" 而非 == ai）
const _RESERVED_WORDS = new Set([
  'and', 'or', 'not', 'in', 'is',
  'True', 'False', 'None', 'true', 'false', 'TRUE', 'FALSE',
]);

function _extractCondIdentifiers(cond) {
  // 剥离字符串字面量（带引号的文本不算标识符）
  const noStr = cond.replace(/"[^"]*"|'[^']*'/g, '""');
  return noStr.match(/@?[\w\u4e00-\u9fff]+(?:\.[\w\u4e00-\u9fff]+)*/g) || [];
}

function _mainIdent(ident) {
  const dot = ident.indexOf('.');
  return dot >= 0 ? ident.slice(0, dot) : ident;
}

function validateDeclarations(result) {
  const topVars = new Set((result.vars || []).map((v) => v.name));
  const actors = new Set((result.actors || []).map((a) => a.name));
  const moduleVars = new Map();
  for (const m of result.modules || []) {
    moduleVars.set(m.name, new Set((m.vars || []).map((v) => v.name)));
  }

  function validateFlow(nodeDecls, edges, ctxName, moduleName) {
    const scopeVars = new Set(topVars);
    if (moduleName && moduleVars.has(moduleName)) {
      for (const n of moduleVars.get(moduleName)) scopeVars.add(n);
    }
    const loopVars = new Set();

    // 1) for 循环变量与迭代器声明检查
    for (const d of nodeDecls || []) {
      if (d.specialType === 'FOR' && d.forCondition) {
        const m = d.forCondition.match(/^(@?[\w\u4e00-\u9fff]+)\s+in\s+(.+)$/);
        if (!m) {
          throw new Error(
            `for 条件格式错误: "${d.forCondition}"（${ctxName}）。期望: for @var in list`
          );
        }
        const loopVar = m[1];
        if (!scopeVars.has(loopVar)) {
          throw new Error(
            `for 循环变量 "${loopVar}" 未在 vars: 中声明（${ctxName}，for 条件: "${d.forCondition}"）。` +
            `所有循环变量必须在 vars: 中预先声明，例如: ${loopVar} = ""`
          );
        }
        loopVars.add(loopVar);
        const iterable = m[2].trim();
        if (/^@?[\w\u4e00-\u9fff]+$/.test(iterable) && !scopeVars.has(iterable)) {
          throw new Error(
            `for 迭代器 "${iterable}" 未在 vars: 中声明（${ctxName}，for 条件: "${d.forCondition}"）`
          );
        }
      }
    }

    // 2) 条件表达式里的裸标识符检查
    const known = new Set([...scopeVars, ...actors, ...loopVars]);
    for (const e of edges || []) {
      if (!e.cond) continue;
      for (const ident of _extractCondIdentifiers(e.cond)) {
        if (_RESERVED_WORDS.has(ident)) continue;
        const main = _mainIdent(ident);
        if (/^\d+(\.\d+)?$/.test(main)) continue; // 数字字面量
        if (main.startsWith('@')) {
          if (!actors.has(main) && !scopeVars.has(main) && !loopVars.has(main)) {
            throw new Error(
              `条件 "${e.cond}" 引用了未声明的 actor/变量 "${main}"（${ctxName}，边 ${e.srcLabel} -> ${e.tgtLabel}）`
            );
          }
        } else if (!known.has(main)) {
          throw new Error(
            `条件 "${e.cond}" 引用了未声明的变量 "${main}"（${ctxName}，边 ${e.srcLabel} -> ${e.tgtLabel}）。` +
            `字符串字面量请加引号，如 == "ai"；所有变量须在 vars: 中声明`
          );
        }
      }
    }

    // 3) 回流检测：回到「多条无条件出边」的节点会导致分支数爆炸——
    //    每次回到这里往下运行都会从一变成多分支。条件出边（if 分流）
    //    回流是安全的（只走为真的分支），不检测；for/par/fork/join 网关
    //    的多出边是迭代/并发语义，跳过；重复边去重（par 出口链可能重复）。
    const seenEdges = new Set();
    const uniqEdges = (edges || []).filter((e) => {
      const key = `${e.srcLabel}\u0000${e.tgtLabel}\u0000${e.cond || ''}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      return true;
    });
    const hasIn = new Set(
      uniqEdges
        .filter((e) => e.srcLabel !== '[START]' && e.srcLabel !== '[IN]')
        .map((e) => e.tgtLabel)
    );
    const gatewayNames = new Set(
      (nodeDecls || [])
        .filter((d) => d.specialType === 'FOR' || d.specialType === 'PAR' || d.specialType === 'FORK' || d.specialType === 'JOIN')
        .map((d) => d.label)
    );
    const unconditionalOuts = new Map();
    for (const e of uniqEdges) {
      if (!e.cond) {
        const list = unconditionalOuts.get(e.srcLabel) || [];
        list.push(e.tgtLabel);
        unconditionalOuts.set(e.srcLabel, list);
      }
    }
    for (const [src, tgts] of unconditionalOuts) {
      if (gatewayNames.has(src)) continue;
      if (tgts.length >= 2 && hasIn.has(src)) {
        throw new Error(
          `${ctxName}: 节点 [${src}] 有多个出边，不能回到这种节点。` +
          `原因是，每次回到这里往下运行都会从一变成多分支，分支数会爆炸。` +
          `建议在本节点之后的分支中加空节点，让他们回到空节点。`
        );
      }
    }
  }

  validateFlow(result.mainflow.nodeDecls, result.mainflow.edges, 'mainflow', null);
  for (const m of result.modules || []) {
    validateFlow(m.nodeDecls, m.edges, `module ${m.name}`, m.name);
  }
}

function splitTopBlocks(lines) {
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // 空白行：如果当前正在某个块内，保留它
    if (!trimmed) {
      if (current) {
        current.contentLines.push({
          indent,
          text: '',
          lineNum: i,
          raw: line,
        });
      }
      continue;
    }

    if (indent === 0) {
      // 顶层注释行（# 或 //）不构成块，直接跳过
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }
      if (current) blocks.push(current);
      current = {
        header: normalizeSymbols(trimmed),
        headerLineNum: i,
        contentLines: [],
      };
    } else if (current) {
      current.contentLines.push({
        indent,
        text: trimmed,
        lineNum: i,
        raw: line,
      });
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function parseMetaBlock(cls) {
  const meta = {};  // 不再预设空字段，全部由用户定义
  let i = 0;
  while (i < cls.length) {
    const cl = cls[i];
    // 跳过空行与整行注释
    const _t = cl.text.trim();
    if (!_t || _t.startsWith('#')) {
      i++;
      continue;
    }
    const line = normalizeSymbols(cl.text);

    // 检查是否为多行字符串定义： key = |
    const multiMatch = line.match(/^([\w\u4e00-\u9fff]+)\s*=\s*\|$/);
    if (multiMatch) {
      const key = multiMatch[1];
      i++;
      const valueLines = [];
      while (i < cls.length && cls[i].indent > cl.indent) {
        valueLines.push(cls[i].text);
        i++;
      }
      const value = valueLines.join('\n');
      // 与编译器一致：任意 key 都收（不限于 system_safety/output_style）
      meta[key] = value;
      continue;
    }

    // 普通单行键值对
    const m = line.match(/^([\w\u4e00-\u9fff]+)\s*=\s*(.+)$/);
    if (!m)
      throw new Error(
        `第 ${cl.lineNum + 1} 行: meta 字段格式错误: "${
          cl.text
        }"。期望: key = value 或 key = |`
      );
    const [, key, val] = m;
    let v = val.trim();

    // ═══ 新增：去除首尾配对引号 & 尝试转为数字 ═══
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }

    // 规范化常用字段，其他字段直接以原始键名存储
    switch (key) {
      case 'id':
        meta.id = v;
        break;
      case 'name':
        meta.name = v;
        break;
      case 'version':
        meta.version = v;
        break;
      case 'owner':
        meta.owner = String(v).replace(/^\[|\]$/g, '');
        break;
      case 'database':
        meta.database = v;
        break;
      case 'session':
        meta.session = v;
        break;
      case 'system_safety':
        meta.system_safety = typeof v === 'string' ? v.replace(/^"|"$/g, '') : v;
        break;
      case 'output_style':
        meta.output_style = typeof v === 'string' ? v.replace(/^"|"$/g, '') : v;
        break;
      case 'max_steps':
        meta.max_steps = Number(v);
        break;
      case 'delay':
        meta.delay = Number(v);
        break;
      default:
        // 与编译器一致：未知字段保留原始键名，不报错
        meta[key] = v;
        break;
    }
    i++;
  }

  // ⚡ 删除所有默认值设置，直接返回解析到的字段
  return meta;
}

function parseLayoutBlock(cls) {
  const layout = {};
  for (const cl of cls) {
    const line = normalizeSymbols(cl.text);
    const m = line.match(/^(\[.+?\])\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) {
      layout[m[1]] = { dx: Math.round(parseFloat(m[2])), dy: Math.round(parseFloat(m[3])) };
    }
  }
  return layout;
}

function parseVarsBlock(cls) {
  const vars = [];
  let i = 0;
  while (i < cls.length) {
    const cl = cls[i];
    const _t = cl.text.trim();
    if (!_t || _t.startsWith('#')) { i++; continue; }   // 跳过空行与注释
    const line = normalizeSymbols(cl.text);

    // 多行值：key = |（与编译器 _eval_kv_block 一致）
    const multiMatch = line.match(/^(@?[\w\u4e00-\u9fff]+)\s*=\s*\|$/);
    if (multiMatch) {
      const key = multiMatch[1];
      i++;
      const valueLines = [];
      while (i < cls.length && cls[i].indent > cl.indent) {
        valueLines.push(cls[i].text);
        i++;
      }
      vars.push({ name: key, defaultValue: valueLines.join('\n') });
      continue;
    }

    const m = line.match(/^(@?[\w\u4e00-\u9fff]+)\s*=\s*(.*)$/);
    if (!m)
      throw new Error(
        `第 ${cl.lineNum + 1} 行: vars 字段格式错误: "${
          cl.text
        }"。期望: varname = "value"`
      );
    vars.push({ name: m[1], defaultValue: m[2].trim() });
    i++;
  }
  return vars;
}

function parseCodeBlock(cls) {
  const code = [];
  for (const cl of cls) {
    const _t = cl.text.trim();
    if (!_t || _t.startsWith('#')) continue;   // 跳过空行与注释
    const line = normalizeSymbols(cl.text);
    const m = line.match(/^(@?[\w\u4e00-\u9fff]+)\s*=\s*(.*)$/);
    if (!m)
      throw new Error(
        `第 ${cl.lineNum + 1} 行: code 字段格式错误: "${
          cl.text
        }"。期望: name = value`
      );
    let val = m[2].trim();
    // 如果格式为 file:"xxx"，只取内部路径
    const fm = val.match(/^file:"(.*)"$/);
    if (fm) val = fm[1];
    code.push({ name: m[1], value: val });
  }
  return code;
}

function parseActorsBlock(cls) {
  const actors = [];
  let i = 0;
  while (i < cls.length) {
    const cl = cls[i];
    const _t = cl.text.trim();
    if (!_t || _t.startsWith('#')) { i++; continue; }   // 跳过空行与注释
    const line = normalizeSymbols(cl.text);

    // blueprint 块（与编译器一致）：blueprint name: + 缩进属性 source/tools
    const bpMatch = line.match(/^blueprint\s+(@?[\w\u4e00-\u9fff]+)\s*:\s*$/);
    if (bpMatch) {
      const bpName = bpMatch[1];
      let source = null;
      let tools = null;
      i++;
      while (i < cls.length && cls[i].indent > cl.indent) {
        const al = normalizeSymbols(cls[i].text).trim();
        if (al.startsWith('source:')) {
          source = al.slice(7).trim();
        } else if (al.startsWith('tools')) {
          const toolsStr = al.replace(/^tools\s*[:=]\s*/, '').trim();
          if (toolsStr.startsWith('[') && toolsStr.endsWith(']')) {
            tools = toolsStr.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
          } else if (toolsStr === 'true' || toolsStr === 'false') {
            tools = toolsStr === 'true';
          } else {
            throw new Error(`第 ${cl.lineNum + 1} 行: tools 格式错误，应为 tools = [tool1, tool2] 或 tools: true/false`);
          }
        }
        i++;
      }
      actors.push({ type: 'blueprint', name: bpName, soul: '', source: source ?? '', tools: tools ?? [] });
      continue;
    }

    const prefixMatch = line.match(
      /^(ai|human)\s+(@?[\w\u4e00-\u9fff]+)\s*=\s*(.*)$/
    );
    // 裸 actor：`ai|human @名`（无 `=`、无属性）→ soul/source 缺省。
    // 与 Python 编译器 FEM_parser.py eval_actors 的裸 actor 分支对齐（soul 非必须，
    // 无 soul 角色 = 无角色设定的裸执行者）。
    const bareMatch = !prefixMatch ? line.match(/^(ai|human)\s+(@?[\w\u4e00-\u9fff]+)\s*$/) : null;
    if (bareMatch) {
      actors.push({ type: bareMatch[1], name: bareMatch[2], soul: '', source: '', tools: [] });
      i++;
      continue;
    }
    if (!prefixMatch)
      throw new Error(
        `第 ${cl.lineNum + 1} 行: actors 格式错误: "${
          cl.text
        }"。期望: ai|human @name = soul:X, source:Y, tools:[...]，或裸写法 ai|human @name`
      );
    const type = prefixMatch[1];
    const name = prefixMatch[2];
    const rest = prefixMatch[3];

    // 初始化字段（全部 null 表示未设置，最终再给默认值）
    let soul = null;
    let source = null;
    let tools = null;

    // 分割属性部分：逗号或空格分隔均可，但 tools 中有逗号，所以用逗号分割再处理
    const parts = rest.split(',').map(p => p.trim()).filter(Boolean);
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (part.startsWith('soul:')) {
        const val = part.slice(5).trim();
        if (!val) throw new Error(`第 ${cl.lineNum + 1} 行: soul 字段缺少值，例如 soul:1`);
        soul = val;
      } else if (part.startsWith('source:')) {
        const val = part.slice(7).trim();
        if (!val) throw new Error(`第 ${cl.lineNum + 1} 行: source 字段缺少值，例如 source:01A`);
        source = val;
      } else if (part.startsWith('tools')) {
        // 允许 tools = [...] / tools:[...] / tools: true|false（布尔=全部/禁用）
        let toolsStr = part.replace(/^tools\s*[:=]\s*/, '').trim();
        // tools 列表内部含逗号会被上面的 split 切碎成多段：拼接后续段直到方括号闭合
        while (!toolsStr.endsWith(']') && pi + 1 < parts.length) {
          pi += 1;
          toolsStr += ',' + parts[pi];
        }
        if (toolsStr.startsWith('[') && toolsStr.endsWith(']')) {
          toolsStr = toolsStr.slice(1, -1);
          tools = toolsStr.split(',').map(s => s.trim()).filter(Boolean);
        } else if (toolsStr === 'true' || toolsStr === 'false') {
          tools = toolsStr === 'true';
        } else {
          throw new Error(`第 ${cl.lineNum + 1} 行: tools 格式错误，应为 tools = [tool1, tool2] 或 tools: true/false`);
        }
      } else {
        // 其他字段直接报错
        throw new Error(
          `第 ${cl.lineNum + 1} 行: 不支持的字段 "${part}"。合法字段: soul, source, tools`
        );
      }
    }

    // 最后赋予默认值（不兜底修改原值）。soul 缺省 = 空串（裸 actor 语义：
    // soul 非必须，序列化时对空 soul 保持沉默，绝不伪造数字 soul）。
    if (soul === null) soul = '';
    if (source === null) source = '';
    if (tools === null) tools = [];

    actors.push({ type, name, soul, source, tools });
    i++;
  }
  return actors;
}

function parseMemoryOrContextBlock(header, cls, blockType) {
  // 解析 memory name(fileRef): 或 context name(fileRef):
  const hm = header.match(
    new RegExp(`^${blockType}\\s+([\\w\\u4e00-\\u9fff]+)\\((.+?)\\):$`)
  );
  if (!hm)
    throw new Error(
      `${blockType} 声明格式错误: "${header}"。期望: ${blockType} name(fileRef):`
    );
  const block = {
    name: hm[1],
    fileRef: hm[2],
    in: '',
    out: '',
  };
  for (const cl of cls) {
    const _t = cl.text.trim();
    if (!_t || _t.startsWith('#')) continue;   // 跳过空行与注释
    const line = normalizeSymbols(cl.text);
    if (line.startsWith('in:')) {
      const after = line.slice(3).trim();
      block.in =
        after ||
        cls
          .filter((l) => l.indent > cl.indent)
          .map((l) => normalizeSymbols(l.text))
          .join('\n');
    } else if (line.startsWith('out:')) {
      const after = line.slice(4).trim();
      block.out =
        after ||
        cls
          .filter((l) => l.indent > cl.indent)
          .map((l) => normalizeSymbols(l.text))
          .join(', ');
    }
  }
  return block;
}

function parseActionBlock(header, cls) {
  // 先标准化 header
  const normalizedHeader = normalizeSymbols(header);
  const hm = normalizedHeader.match(
    /^action\s+([\w\u4e00-\u9fff]+)\s+(@[\w\u4e00-\u9fff]+)(?:\((@?[\w\u4e00-\u9fff.]+)\))?(?:\s+as\s*\((@?[\w\u4e00-\u9fff.]+)\))?\s*:\s*$/
  );
  if (!hm)
    throw new Error(
      `Action 声明格式错误: "${header}"。期望: action name @type(@actor):`
    );
  const action = {
    name: hm[1],
    executorType: hm[2].replace('@', ''),
    executorActor: hm[3] || '',
    asActor: hm[4] || '',
    prompt: '',
    resolve: '',
    scope: '',
    outVars: '',
    inMappings: '',
    memory: '',
    context: '',
    max_retries: 0,
    fallback: '',
    interrupt: '',
  };

  let i = 0;
  while (i < cls.length) {
    const cl = cls[i];

    // ★ 非 prompt 上下文：跳过空白行
    const isPromptContext =
      cl.text.startsWith('prompt:') ||
      cl.text.startsWith('showprompt:') ||
      (i > 0 &&
        (cls[i - 1].text === 'prompt: |' || cls[i - 1].text === 'showprompt: |') &&
        cl.indent > cls[i - 1].indent);

    if (!isPromptContext && (!cl.text.trim() || cl.text.trim().startsWith('#'))) {
      i++;
      continue;
    }

    const line = isPromptContext ? cl.text : normalizeSymbols(cl.text);
    if (line === 'prompt: |') {
      i++;
      const pl = [];
      while (i < cls.length && cls[i].indent > cl.indent) {
        pl.push(cls[i].text);
        i++;
      }
        action.prompt = pl.join('\n');
        continue;
      }
      if (line.startsWith('prompt:') && !line.endsWith('|')) {
        const after = line.slice(7).trim();
        action.prompt = after;
        i++;
        continue;
      }
      if (line === 'showprompt: |') {
        i++;
        const spl = [];
        while (i < cls.length && cls[i].indent > cl.indent) {
          spl.push(cls[i].text);
          i++;
        }
        action.showprompt = spl.join('\n');
        continue;
      }
      if (line.startsWith('showprompt:')) {
        const after = line.slice(11).trim();
        action.showprompt = after;
        i++;
        continue;
      }
      if (line.startsWith('in:')) {
      const after = line.slice(3).trim();
      if (after) {
        action.inMappings = after;
        i++; // 单行模式必须推进索引，否则死循环
      } else {
        i++;
        const il = [];
        let guard = 0;
        while (i < cls.length && cls[i].indent > cl.indent) {
          if (++guard > 500)
            throw new Error(`第 ${cl.lineNum + 1} 行: in 字段解析陷入死循环`);
          il.push(normalizeSymbols(cls[i].text));
          i++;
        }
        action.inMappings = il.join('\n');
      }
      continue;
    }
    if (line.startsWith('out:')) {
      const after = line.slice(4).trim();
      if (after) {
        action.outVars = after;
        i++; // 单行模式必须推进索引
        // 单行 out 后的缩进续行也并入（out: x += 1 后接缩进的 y = {}）
        const ol = [];
        while (i < cls.length && cls[i].indent > cl.indent) {
          const t2 = normalizeSymbols(cls[i].text).trim();
          if (t2 && !t2.startsWith('#')) ol.push(t2);
          i++;
        }
        if (ol.length > 0) action.outVars = after + '\n' + ol.join('\n');
      } else {
        i++;
        const ol = [];
        while (i < cls.length && cls[i].indent > cl.indent) {
          ol.push(normalizeSymbols(cls[i].text));
          i++;
        }
action.outVars = ol.join('\n');
      }
      continue;
    }
    if (line.startsWith('scope:')) {
      action.scope = line.slice(6).trim();
      i++;
      continue;
    }
    if (line.startsWith('memory:')) {
      action.memory = line.slice(7).trim();
      i++;
      continue;
    }
    if (line.startsWith('context:')) {
      action.context = line.slice(8).trim();
      i++;
      continue;
    }
    if (line.startsWith('resolve:')) {
      action.resolve = line.slice(8).trim();
      i++;
      continue;
    }
    if (line.startsWith('max_retries:')) {
      action.max_retries = Number(line.slice(12).trim());
      i++;
      continue;
    }
    if (line.startsWith('fallback:')) {
      action.fallback = line.slice(9).trim();
      i++;
      continue;
    }
    if (line.startsWith('interrupt:')) {
      action.interrupt = line.slice(10).trim();
      i++;
      continue;
    }
    throw new Error(
      `第 ${cl.lineNum + 1} 行: 未识别的 action 子字段: "${
        cl.text
      }"。合法: prompt:, in:, out:, scope:, memory:, context:, resolve:, max_retries:, fallback:, interrupt:`
    );
  }
  return action;
}

function parseModuleBlock(header, cls) {
  const hm = header.match(/^module\s+([\w\u4e00-\u9fff]+)(?:\s*\(([^)]*)\))?\s*:?\s*$/);
  if (!hm)
    throw new Error(`Module 声明格式错误: "${header}"。期望: module Name:`);
  const mod = {
    name: hm[1],
    params: hm[2] ? hm[2].split(',').map((s) => s.trim()).filter(Boolean) : [],
    meta: {},
    code: [],
    vars: [],
    actions: [],
    nodeDecls: [],
    edges: [],
  };

  // 子块按最小缩进切分（兼容 2 空格 / 4 空格等任意统一缩进）
  const subBlocks = [];
  let cur = null;
  const nonEmpty = cls.filter((cl) => cl.text.trim());
  const baseIndent = nonEmpty.length > 0
    ? Math.min(...nonEmpty.map((cl) => cl.indent))
    : 0;
  for (const cl of cls) {
    // 跳过空行，防止生成空 header 的子块
    if (!cl.text.trim()) continue;

    if (cl.indent === baseIndent) {
      if (cur) subBlocks.push(cur);
      const headerText = cl.text.trim();
      if (headerText.startsWith('//') || headerText.startsWith('#')) {
        cur = null;
      } else {
        cur = { header: cl.text, contentLines: [] };
      }
    } else if (cur && cl.indent > baseIndent) {
      cur.contentLines.push({ ...cl, indent: cl.indent - baseIndent });
    }
  }
  if (cur) subBlocks.push(cur);

  for (const sb of subBlocks) {
    const hdr = normalizeSymbols(sb.header);
    if (hdr === 'vars:') {
      mod.vars = parseVarsBlock(sb.contentLines);
    } else if (hdr === 'meta:') {
      mod.meta = parseMetaBlock(sb.contentLines);
    } else if (hdr === 'code:') {
      mod.code = parseCodeBlock(sb.contentLines);
    } else if (hdr.startsWith('action ')) {
      mod.actions.push(
        parseActionBlock(normalizeSymbols(sb.header), sb.contentLines)
      );
    } else if (hdr === 'flow:') {
      const { nodeDecls, edges } = parseFlowSection(sb.contentLines);
      mod.nodeDecls = nodeDecls;
      mod.edges = edges;
    } else if (hdr === 'sketch:') {
      mod.layout = parseLayoutBlock(sb.contentLines);
    } else if (hdr.startsWith('module ')) {
      // 递归解析嵌套子模块
      const subMod = parseModuleBlock(hdr, sb.contentLines);
      if (!mod.subModules) mod.subModules = [];
      mod.subModules.push(subMod);
    } else {
      throw new Error(
        `Module 内未识别的子块: "${sb.header}"。合法: vars:, meta:, code:, action ..., module ..., flow:`
      );
    }
  }
  return mod;
}

function parseMainflowBlock(cls) {
  // 计算最小缩进（跳过空行和注释）
  const nonCommentLines = cls.filter(l => {
    const t = normalizeSymbols(l.text).trim();
    return t && !t.startsWith('//') && !t.startsWith('#');
  });
  if (nonCommentLines.length === 0) {
    return { nodeDecls: [], edges: [], layout: {} };
  }
  const baseIndent = Math.min(...nonCommentLines.map(l => l.indent));

  // 按 baseIndent 分组（mainflow 内部子块）
  const groups = [];
  let currentGroup = null;
  for (const cl of cls) {
    if (cl.indent === baseIndent) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { header: cl, lines: [] };
    } else if (currentGroup && cl.indent > baseIndent) {
      currentGroup.lines.push(cl);
    }
    // 缩进小于 baseIndent 的异常行忽略
  }
  if (currentGroup) groups.push(currentGroup);

  let flowLines = [];
  let layout = {};

  for (const group of groups) {
    const headerText = normalizeSymbols(group.header.text);
    if (headerText === 'sketch:') {
      // 收集 sketch 块内的坐标行
      layout = parseLayoutBlock(group.lines);
    } else {
      // 其他行（节点声明、连线）原样放入 flowLines
      flowLines.push(group.header);
      flowLines.push(...group.lines);
    }
  }

  // 如果没有分组（所有行缩进相同），则直接作为 flow 行
  if (groups.length === 0) {
    flowLines = cls;
  }

  const result = parseFlowSection(flowLines);
  result.layout = layout;
  return result;
}

function parseFlowSection(flowLines, existingLabels) {

    console.log('parseFlowSection 被调用，flowLines:');

  const nodeDecls = [];
  const edges = [];
  let currentNode = null;
  const usedLabels = new Set(existingLabels || []);

  const addEdge = (edge) => {
    const newCond = (edge.cond || '').trim();
    console.log(`[DEBUG] addEdge: src="${edge.srcLabel}" -> tgt="${edge.tgtLabel}", cond="${newCond}", isBack=${edge.isBack}`);

    const existing = edges.filter(
      (e) => e.srcLabel === edge.srcLabel && e.tgtLabel === edge.tgtLabel
    );
    console.log(`[DEBUG] 已有同src→tgt边数: ${existing.length}, 现有cond列表: [${existing.map(e => JSON.stringify((e.cond||'').trim())).join(', ')}]`);

    // Case 0: 该 src→tgt 无任何已有边 → 直接加入
    if (existing.length === 0) {
      console.log(`[addEdge] 无冲突, 直接加入`);
      edges.push(edge);
      return;
    }

    // 查找完全相同的 cond
    const exactMatch = existing.find((e) => (e.cond || '').trim() === newCond);
    if (exactMatch) {
      console.log(`[addEdge] 完全相同 cond "${newCond}" 已存在, 跳过新边`);
      return;
    }

    const newIsConditional = newCond !== '';
    const hasAnyConditional = existing.some((e) => (e.cond || '').trim() !== '');
    const allUnconditional = existing.every((e) => (e.cond || '').trim() === '');
    console.log(`[DEBUG] newIsConditional=${newIsConditional}, hasAnyConditional=${hasAnyConditional}, allUnconditional=${allUnconditional}`);

    // 规则2a: 新边无条件，已有中存在有条件边 → 丢弃新边（保留已有的条件边）
    if (!newIsConditional && hasAnyConditional) {
      const keptCond = existing.find(e => (e.cond || '').trim() !== '').cond;
      console.log(`[addEdge] 规则2: 新边无条件，已有条件边 "${(keptCond||'').trim()}" → 丢弃新边`);
      return;
    }

    // 规则2b: 新边有条件，已有全无条件 → 删除已有无条件边，加入新条件边
    if (newIsConditional && allUnconditional) {
      console.log(`[addEdge] 规则2: 新边有条件 "${newCond}"，已有全无条件 → 删除已有无条件边，加入新条件边`);
      const indicesToRemove = existing
        .map(e => edges.indexOf(e))
        .filter(i => i !== -1)
        .sort((a, b) => b - a);
      for (const idx of indicesToRemove) {
        edges.splice(idx, 1);
      }
      edges.push(edge);
      return;
    }

    // 规则4: 新边有条件，已有也有条件，且条件不同 → 报错
    if (newIsConditional && hasAnyConditional) {
      const existingConds = existing.map(e => (e.cond || '').trim());
      throw new Error(
        `边冲突: "${edge.srcLabel}" → "${edge.tgtLabel}" 已存在条件边 (条件: "${existingConds.join('", "')}"),` +
        ` 新边条件为 "${newCond}"。同一 src→tgt 不允许同时存在两条不同条件的边，请检查流程结构`
      );
    }

    // 兜底: 新边无条件，已有也全无条件 → 实际上被 exactMatch 拦住了，不会走到这里
    console.log(`[addEdge] 兜底: 都无条件 (${existing.length}条已有), 加入`);
    edges.push(edge);
  };
  // 根据裸引用获取或创建节点标签，不产生边
function ensureNodeForRef(ref) {
    console.log('ensureNodeForRef 被调用:', ref);
  if (ref.includes('->')) {
    console.trace('异常节点引用（含 ->）:', ref);
    throw new Error(`ensureNodeForRef 收到非法引用: "${ref}"`);
  }
    const trimmed = ref.trim();
    const bracketMatch = trimmed.match(/^\[(.+)\]$/);
    if (bracketMatch) {
      const label = bracketMatch[1];
      if (!usedLabels.has(label) && !nodeDecls.some(d => d.label === label)) {
        nodeDecls.push({ label, ref: '' });
        usedLabels.add(label);
      }
      return label;
    }
    const inlineMatch = trimmed.match(/^\[(.+?)\]:\s*(.*)$/);
    if (inlineMatch) {
      const label = inlineMatch[1];
      const refVal = inlineMatch[2].trim();
      if (!usedLabels.has(label) && !nodeDecls.some(d => d.label === label)) {
        nodeDecls.push({ label, ref: refVal });
        usedLabels.add(label);
      }
      return label;
    }
    let baseName = trimmed.startsWith('&') ? trimmed.substring(1) : trimmed;
    baseName = baseName.replace(/\(.*$/, '').trim();
    let label = baseName;
    let counter = 2;
    while (usedLabels.has(label) || nodeDecls.some(d => d.label === label)) {
      label = `${baseName}_${counter}`;
      counter++;
    }
    nodeDecls.push({ label, ref: trimmed });
    usedLabels.add(label);
    return label;
  }

  // 统一解析目标（支持 [label]、[label]:ref、actionName、&module 等）
  function resolveTarget(srcLabel, targetRaw, cond) {
console.log('resolveTarget:', srcLabel, '->', targetRaw, 'cond:', cond);
console.log(`[DEBUG] resolveTarget: src="${srcLabel}", target="${targetRaw}", cond="${cond}"`);
    if (targetRaw == null) {
      console.trace('resolveTarget 收到空 targetRaw，srcLabel:', srcLabel);
      throw new Error(`resolveTarget 收到空 targetRaw，srcLabel: ${srcLabel}`);
    }
    const trimmed = targetRaw.trim().replace(/：/g, ':');
    const inlineMatch = trimmed.match(/^\[(.+?)\]:\s*(.*)$/);
    if (inlineMatch) {
      const label = inlineMatch[1];
      const ref = inlineMatch[2].trim();
      if (!usedLabels.has(label) && !nodeDecls.some(d => d.label === label)) {
        nodeDecls.push({ label, ref });
        usedLabels.add(label);
      }
      addEdge({ srcLabel, tgtLabel: label, cond, isBack: false });
      return label;
    }

    const bracketMatch = trimmed.match(/^\[(.+)\]$/);
    if (bracketMatch) {
      const label = bracketMatch[1];
      if (!usedLabels.has(label) && !nodeDecls.some(d => d.label === label)) {
        nodeDecls.push({ label, ref: '' });
        usedLabels.add(label);
      }
      addEdge({ srcLabel, tgtLabel: label, cond, isBack: false });
      return label;
    }

    // 普通引用
    let nodeLabel = trimmed.startsWith('&') ? trimmed.substring(1) : trimmed;
    const baseName = nodeLabel.replace(/\(.*$/, '').trim();
    let label = baseName;
    let counter = 2;
    while (usedLabels.has(label) || nodeDecls.some(d => d.label === label)) {
      label = `${baseName}_${counter}`;
      counter++;
    }
    nodeDecls.push({ label, ref: trimmed.trim() });
    usedLabels.add(label);
    addEdge({ srcLabel, tgtLabel: label, cond, isBack: false });
    return label;
  }

  // 链式入口解析：[A] -> [B] -> fork:/for:/par: 的入口串。
  // 先把入口链建成普通边，返回链尾节点作为控制块的入口。
  function resolveChainEntry(raw) {
    const parts = raw.split('->').map(p => p.trim()).filter(Boolean);
    if (parts.length <= 1) return ensureNodeForRef(parts[0] || raw.trim());
    let prev = ensureNodeForRef(parts[0]);
    for (let k = 1; k < parts.length; k++) {
      prev = resolveTarget(prev, parts[k], '');
    }
    return prev;
  }

  // 链式出口解析：-> [FAREWELL]:farewell -> [END]（for/par 出口行允许内联定义 + 链）
  function resolveExitChain(raw, srcLabel) {
    const parts = raw.split('->').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return srcLabel;
    let cur = srcLabel;
    for (const part of parts) {
      const ifMatch = part.match(/^if\s*\((.+)\)$/);
      if (ifMatch) {
        const rest = part.slice(part.indexOf(')') + 1).trim();
        cur = resolveTarget(cur, rest, ifMatch[1].trim());
      } else {
        cur = resolveTarget(cur, part, '');
      }
    }
    return cur;
  }

  // ── 第一步：全局裸引用规范化（按->切块，智能保留控制结构） ──
  for (const line of flowLines) {

    let t = normalizeSymbols(line.text, 'flow');
    console.log('规范化前:', line.text);
    // 按 -> 切割成块
    const parts = t.split('->').map(p => {
      let s = p.trim();
      if (!s) return '';

      // 已经是 [label] 或 [label]:ref → 原样
      if (s.startsWith('[')) return s;

      // 包含冒号的定义式（如 god:god_announce） → 原样
      if (/^[^:]+\s*:\s*.+/.test(s)) return s;

      // 如果块内包含控制流关键字或括号 → 整块原样保留
      if (
        /\b(if|for|while|fork|par|join|in|to|all)\b/.test(s) ||
        /[()]/.test(s)
      ) {
        return s;
      }

      // &module → 转成 [module]
      if (s.startsWith('&')) {
        const label = ensureNodeForRef(s);
        return `[${label}]`;
      }

      // 纯标识符（如 tally, nextDay；含中文节点名如 随机等一会儿）→ 转成 [label]
      if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(s)) {
        const label = ensureNodeForRef(s);
        return `[${label}]`;
      }

      // 其他未知结构，原样保留（安全）
      return s;
    });

    // 用 ' -> ' 重新拼接（保证后续正则 100% 命中）
    line.text = parts.join(' -> ');
    console.log('规范化后:', line.text);
  }

  let i = 0;
  let loopGuard = 0;
  while (i < flowLines.length) {

    if (++loopGuard > flowLines.length * 20) {
      throw new Error(`第 ${flowLines[i]?.lineNum || i} 行附近: 流程解析陷入死循环`);
    }
    const cl = flowLines[i];
    if (!cl) break;
    let text = normalizeSymbols(cl.text, 'flow').trim();
    console.log('>>> LINE', cl.lineNum+1, JSON.stringify(text));

    // 跳过空行和注释
    if (!text || text.startsWith('//')) {
      i++;
      continue;
    }

    // 跳过 // 注释行
    if (text.startsWith('//')) { i++; continue; }

    // 注释行（# for loop 魔法注释已废弃，一律跳过）
    if (text.startsWith('#')) {
      i++;
      continue;
    }
    // fork: 显式入口 [A] -> fork:（支持链式入口 [A] -> [B] -> fork:）
    const forkMatch = text.match(/^(.+)\s*->\s*fork:$/);
    if (forkMatch) {
      const srcLabel = resolveChainEntry(forkMatch[1].trim());
      i++;
      let forkGuard = 0;
      while (i < flowLines.length && flowLines[i].indent > cl.indent) {
        if (++forkGuard > 500) throw new Error(`fork 分支解析死循环`);
        const rawLine = flowLines[i].text;
        const bl = normalizeSymbols(rawLine, 'flow').trim();
        // 分支行：-> if (cond) -> 目标  或  -> 目标 -> 目标2 ...
        const bm = bl.match(/^->\s*(?:if\s*\((.+?)\)\s*->\s*)?(.+)$/);
        if (bm) {
          const cond = bm[1] || '';
          const rest = bm[2].trim();
          // 把剩余部分当链式解析，从 srcLabel 出发
          const parts = rest.split('->').map(p => p.trim()).filter(p => p !== '');
          if (parts.length === 0) throw new Error(`第 ${flowLines[i].lineNum + 1} 行: fork 分支缺少目标`);
          let curSrc = srcLabel;
          let first = true;
          for (const part of parts) {
            curSrc = resolveTarget(curSrc, part, first ? cond : '');
            first = false;
          }
        } else {
          throw new Error(`第 ${flowLines[i].lineNum + 1} 行: fork 分支格式错误: "${rawLine}"`);
        }
        i++;
      }
      continue;
    }



    // par 循环（与 for 完全相同的解析，但特殊类型为 PAR）
    const parMatch = text.match(/^(.+)\s*->\s*par\s+(.+):$/);
    if (parMatch) {
      const entryRaw = parMatch[1].trim();
      const condition = parMatch[2].trim();

      const entryLabel = resolveChainEntry(entryRaw);

      let parLabel = 'PAR';
      let counter = 2;
      while (nodeDecls.some(d => d.label === parLabel)) {
        parLabel = `PAR_${counter}`;
        counter++;
      }
      const parNodeLabel = parLabel;
      const parOutLabel = parLabel + '_out';

      nodeDecls.push({
        label: parNodeLabel,
        ref: '',
        specialType: 'PAR',
        forCondition: condition,
      });

      // 立即创建 par_out 节点（确保无论是否有出口行都存在）
      if (!nodeDecls.some(d => d.label === parOutLabel)) {
        nodeDecls.push({
          label: parOutLabel,
          ref: '',
          specialType: 'PAR_OUT',
          forNodeId: parNodeLabel,
        });
      }

      addEdge({ srcLabel: entryLabel, tgtLabel: parNodeLabel, cond: '', isBack: false });

      i++; // 跳过 par 行

      const rawBodyLines = [];
      while (i < flowLines.length && flowLines[i].indent > cl.indent) {
        rawBodyLines.push(flowLines[i]);
        i++;
      }

      if (rawBodyLines.length === 0) {
        throw new Error(`第 ${cl.lineNum + 1} 行: par 块不能为空`);
      }

      const pendingBackNodes = [];
      const cleanBodyLines = [];

      for (const bl of rawBodyLines) {
        let textBody = normalizeSymbols(bl.text, 'flow').trim();
        let lastNodeInLine = null;

        if (textBody.startsWith('->')) {
          const restAfterStart = textBody.substring(2).trim();
          const ifMatch = restAfterStart.match(/^if\s*\((.+?)\)\s*->\s*(.*)$/);
          let startCond = '';
          if (ifMatch) {
            startCond = ifMatch[1].trim();
            textBody = ifMatch[2].trim();
          } else {
            textBody = restAfterStart;
          }
          const parts = textBody.split('->').map(x => x.trim()).filter(Boolean);
          if (!parts.length) {
            throw new Error(`第 ${bl.lineNum + 1} 行: par 内部行首 -> 后面缺少目标`);
          }
          const firstPart = parts[0];
          const tgtLabel = resolveTarget(parNodeLabel, firstPart, startCond);
          lastNodeInLine = tgtLabel;
        }

        let endsWithArrow = false;
        if (textBody.endsWith('->')) {
          textBody = textBody.slice(0, -2).trim();
          endsWithArrow = true;
        }

        if (textBody) {
          const parts = textBody.split('->').map(p => p.trim()).filter(p => p !== '');
          if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const labelMatch = lastPart.match(/^\[(.+?)\]/);
            if (labelMatch) {
              lastNodeInLine = labelMatch[1];
            } else {
              lastNodeInLine = ensureNodeForRef(lastPart);
            }
          }
        } else if (!lastNodeInLine) {
          throw new Error(`第 ${bl.lineNum + 1} 行: par 内部行缺少节点`);
        }

        if (endsWithArrow && lastNodeInLine) {
          pendingBackNodes.push(lastNodeInLine);
        }

        if (textBody) {
          cleanBodyLines.push({
            ...bl,
            text: textBody,
          });
        }
      }

      if (cleanBodyLines.length > 0) {
        const minIndent = Math.min(...cleanBodyLines.map(l => l.indent));
        const normalizedLines = cleanBodyLines.map(l => ({
          ...l,
          indent: l.indent - minIndent + 2,
        }));
        const { nodeDecls: bodyDecls, edges: bodyEdges } = parseFlowSection(
          normalizedLines,
          [...usedLabels]
        );
        bodyDecls.forEach(d => {
          if (!nodeDecls.some(existing => existing.label === d.label)) {
            nodeDecls.push(d);
          }
        });
        bodyEdges.forEach(be => addEdge(be));
      }

      // 内部路径末端连向 par_out（不再是 PAR 自身）
      pendingBackNodes.forEach(pbLabel => {
        addEdge({ srcLabel: pbLabel, tgtLabel: parOutLabel, cond: '', isBack: false });
      });

      // 处理出口：同缩进的 -> [ExitNode]（出口行可同时是控制块入口：
      // -> [A] -> [B] -> fork: 时，链部分作为出口，控制块行留给主循环）
      if (i < flowLines.length && flowLines[i].indent === cl.indent) {
        const afterLine = normalizeSymbols(flowLines[i].text, 'flow').trim();
        const am = afterLine.match(/^->\s*(.+)$/);
        if (am) {
          const exitTargetRaw = am[1].trim();
          const ctrlMatch = exitTargetRaw.match(/\s*->\s*(for|par|fork|join)\b/);
          if (ctrlMatch) {
            // 出口链 + 控制块入口：链部分建出口边，不消费该行
            const chainPart = exitTargetRaw.slice(0, ctrlMatch.index).trim();
            if (chainPart) {
              resolveExitChain(chainPart, parOutLabel);
            }
          } else {
            // 纯出口链（支持内联定义：-> [FAREWELL]:farewell -> [END]）
            resolveExitChain(exitTargetRaw, parOutLabel);
            i++;
          }
        }
      }

      currentNode = parOutLabel;
      continue;
    }

    // join(all):
    const jm = text.match(/^join\((\w+)\):$/);
    if (jm) {
      const joinParam = jm[1]; // 保留用户写的参数，如 "all", "1", "any"
      i++;
      const sources = [];
      while (i < flowLines.length && !flowLines[i].text.trim().startsWith('to ')) {
        const rawLine = flowLines[i].text;
        const srcLine = rawLine.trim();
        if (!srcLine.endsWith('->')) {
          throw new Error(`第 ${flowLines[i].lineNum + 1} 行: join 内部每行必须以 -> 结尾。当前行: "${rawLine}"`);
        }
        // label 禁止跨括号（防回溯把多段链式吞进单个节点名）
        const sm = srcLine.match(/^\[([^\[\]]+?)\]\s*->$/);
        if (sm) {
          sources.push(sm[1]);
        } else {
          throw new Error(`第 ${flowLines[i].lineNum + 1} 行: join 源节点格式错误，期望 [节点名] ->，实际: "${rawLine}"`);
        }
        i++;
      }
      if (i < flowLines.length && flowLines[i].text.trim().startsWith('to ')) {
        let targetRaw = flowLines[i].text.trim().slice(3).trim();
        if (!targetRaw) throw new Error(`第 ${flowLines[i].lineNum + 1} 行: join 目标为空`);
        if (targetRaw.endsWith('->')) {
          targetRaw = targetRaw.slice(0, -2).trim();
        }
        // 支持链式目标 to [A]:ref -> [B]：sources 连链首，currentNode 走链尾
        const parts = targetRaw.split('->').map(p => p.trim()).filter(Boolean);
        if (parts.length === 0) throw new Error(`第 ${flowLines[i].lineNum + 1} 行: join 目标为空`);
        const tgtLabel = ensureNodeForRef(parts[0]);
        let tail = tgtLabel;
        for (let k = 1; k < parts.length; k++) {
          tail = resolveTarget(tail, parts[k], '');
        }
        sources.forEach(s => addEdge({ srcLabel: s, tgtLabel: tgtLabel, cond: '', isBack: false }));

        // ═══ 将 join 信息存入目标节点的声明 ═══
        const tgtDecl = nodeDecls.find(d => d.label === tgtLabel);
        if (tgtDecl) {
          if (!tgtDecl.joinEntries) tgtDecl.joinEntries = [];
          tgtDecl.joinEntries.push({ sources: sources.slice(), param: joinParam });
        } else {
          // ensureNodeForRef 应该已创建，但以防万一手动补
          const newDecl = { label: tgtLabel, ref: '', joinEntries: [{ sources: sources.slice(), param: joinParam }] };
          nodeDecls.push(newDecl);
          usedLabels.add(tgtLabel);
        }

        currentNode = tail;
        i++;
      } else {
        throw new Error(`第 ${(flowLines[i]?.lineNum || flowLines.length) + 1} 行附近: join 缺少 to 目标`);
      }
      continue;
    }



    // for 循环新语法: [A] -> for 条件:
    const forEntryMatch = text.match(/^(.+)\s*->\s*for\s+(.+):$/);
    if (forEntryMatch) {
      const entryRaw = forEntryMatch[1].trim();
      const condition = forEntryMatch[2].trim();

      // 解析入口节点（支持链式入口 [A] -> [B] -> for ...）
      const entryLabel = resolveChainEntry(entryRaw);

      // 生成唯一的 FOR 节点标签
      let forLabel = 'FOR';
      let counter = 2;
      while (nodeDecls.some(d => d.label === forLabel)) {
        forLabel = `FOR_${counter}`;
        counter++;
      }
      const forNodeLabel = forLabel;
      const forOutLabel = forLabel + '_out';

      // 声明 FOR 节点
      nodeDecls.push({
        label: forNodeLabel,
        ref: '',
        specialType: 'FOR',
        forCondition: condition,
      });

      // 入口边: entryLabel -> FOR
      addEdge({ srcLabel: entryLabel, tgtLabel: forNodeLabel, cond: '', isBack: false });

      i++; // 跳过 for 行

      // 收集缩进大于 for 行的内部行
      const rawBodyLines = [];
      while (i < flowLines.length && flowLines[i].indent > cl.indent) {
        rawBodyLines.push(flowLines[i]);
        i++;
      }

      if (rawBodyLines.length === 0) {
        throw new Error(`第 ${cl.lineNum + 1} 行: for 块不能为空`);
      }

      // ---------- 剥箭头预处理 ----------
      const pendingBackNodes = []; // 需要回连/连出口的节点 label
      const cleanBodyLines = [];   // 剥除箭头后的行（用于递归解析）

      for (const bl of rawBodyLines) {
        let textBody = normalizeSymbols(bl.text, 'flow').trim();
        let lastNodeInLine = null; // 记录该行最右节点

        // 1. 处理行首箭头：-> if (cond) -> target 或 -> target ...
        if (textBody.startsWith('->')) {
          const restAfterStart = textBody.substring(2).trim();
          const ifMatch = restAfterStart.match(/^if\s*\((.+?)\)\s*->\s*(.*)$/);
          let startCond = '';
          if (ifMatch) {
            startCond = ifMatch[1].trim();
            textBody = ifMatch[2].trim();
          } else {
            textBody = restAfterStart;
          }
          // 提取第一个目标节点（仅用于生成 FOR->node 边，不截断 textBody）
          const parts =
            textBody
              .split('->')
              .map(x => x.trim())
              .filter(Boolean);

          if (!parts.length) {
            throw new Error(`第 ${bl.lineNum + 1} 行: for 内部行首 -> 后面缺少目标`);
          }

          const firstPart = parts[0];

          const tgtLabel =
            resolveTarget(
              forNodeLabel,
              firstPart,
              startCond
            );

          lastNodeInLine = tgtLabel;
          // 注意：textBody 保持不变，继续包含完整链式，以便后续行尾箭头处理和 cleanBodyLines 解析
        }

        // 2. 处理行尾箭头
        let endsWithArrow = false;
        if (textBody.endsWith('->')) {
          textBody = textBody.slice(0, -2).trim();
          endsWithArrow = true;
        }

        // 3. 找出该行的最右节点（用于 pendingBackNodes）
        if (textBody) {
          // 从 textBody 中提取最后一个节点 label
          const parts = textBody.split('->').map(p => p.trim()).filter(p => p !== '');
          if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            // 尝试解析最后一个节点的 label
            const labelMatch = lastPart.match(/^\[(.+?)\]/);
            if (labelMatch) {
              lastNodeInLine = labelMatch[1];
            } else {
              // 裸引用，用 ensureNodeForRef 获取 label
              const lbl = ensureNodeForRef(lastPart);
              lastNodeInLine = lbl;
            }
          }
        } else if (!lastNodeInLine) {
          // textBody 为空且没有行首箭头，说明该行只有行尾箭头（不太可能，但防御）
          throw new Error(`第 ${bl.lineNum + 1} 行: for 内部行缺少节点`);
        }

        // 如果有行尾箭头，记录最右节点
        if (endsWithArrow && lastNodeInLine) {
          pendingBackNodes.push(lastNodeInLine);
        }

        // 若剥完后 textBody 非空，作为普通行加入 cleanBodyLines
        if (textBody) {
          cleanBodyLines.push({
            ...bl,
            text: textBody,
          });
        }
      }

      // 递归解析清理后的循环体内部
      if (cleanBodyLines.length > 0) {
        const minIndent = Math.min(...cleanBodyLines.map(l => l.indent));
        const normalizedLines = cleanBodyLines.map(l => ({
          ...l,
          indent: l.indent - minIndent + 2,
        }));
        const { nodeDecls: bodyDecls, edges: bodyEdges } = parseFlowSection(
          normalizedLines,
          [...usedLabels]
        );
        bodyDecls.forEach(d => {
          if (!nodeDecls.some(existing => existing.label === d.label)) {
            nodeDecls.push(d);
          }
        });
        bodyEdges.forEach(be => addEdge(be));
      }

      // 处理出口：同缩进的 -> [ExitNode]
      // 无论有无出口，pendingBackNodes 都应回连 FOR 形成环
      pendingBackNodes.forEach(pbLabel => {
        addEdge({ srcLabel: pbLabel, tgtLabel: forNodeLabel, cond: '', isBack: true });
      });

      console.log('FOR出口诊断:', {
        i,
        lineText: flowLines[i]?.text,
        lineIndent: flowLines[i]?.indent,
        forIndent: cl.indent,
        isMatch: flowLines[i]?.indent === cl.indent
      });
      if (i < flowLines.length && flowLines[i].indent === cl.indent) {
        const afterLine = normalizeSymbols(flowLines[i].text, 'flow').trim();
        const am = afterLine.match(/^->\s*(.+)$/);
        if (am) {
          // 声明 for_out 节点
          if (!nodeDecls.some(d => d.label === forOutLabel)) {
            nodeDecls.push({
              label: forOutLabel,
              ref: '',
              specialType: 'FOR_OUT',
              forNodeId: forNodeLabel,
            });
          }
          const exitTargetRaw = am[1].trim();
          const ctrlMatch = exitTargetRaw.match(/\s*->\s*(for|par|fork|join)\b/);
          if (ctrlMatch) {
            // 出口链 + 控制块入口：链部分建出口边，不消费该行
            const chainPart = exitTargetRaw.slice(0, ctrlMatch.index).trim();
            if (chainPart) {
              resolveExitChain(chainPart, forOutLabel);
            }
          } else {
            // for_out -> 出口节点（支持链：-> [X]:ref -> [Y]）
            resolveExitChain(exitTargetRaw, forOutLabel);
            i++;
          }
        }
      }

      // 更新 currentNode 为 for_out 标签，方便后续链
      currentNode = forOutLabel;
      continue;
    }


    // ⚠️ 重要：先匹配链式连接（[label] -> ...），再匹配节点声明（[label]: ...）
    // [label]:ref -> ... 链式（如 [AI_ATK]:ai_attack -> [AI_DONE]）
    // label 用 [^\[\]] 防回溯跨箭头：否则 `[START] -> [x]:a -> [END]` 会被
    // 误判成声明行，把 "START] -> [x" 当成节点名（2026-08-22 flow 链式 bug 根因）。
    const dmChain = text.match(/^\[([^\[\]]+?)\]:\s*(\S+)\s*->\s*(.+)$/);
    if (dmChain) {
      const label = dmChain[1];
      const ref = dmChain[2].trim();
      const existing = nodeDecls.find((d) => d.label === label);
      if (existing) existing.ref = ref || existing.ref;
      else nodeDecls.push({ label, ref });
      i++;
      // 剩余链从 label 出发（复用 chainMatch 的解析逻辑）
      const rest = dmChain[3].trim();
      const rawParts = rest.split('->').map((p) => p.trim()).filter((p) => p !== '');
      const parts = [];
      let pendingCond = null;
      for (const part of rawParts) {
        const ifMatch = part.match(/^if\s*\((.+)\)$/);
        if (ifMatch) {
          pendingCond = ifMatch[1].trim();
        } else {
          parts.push({ target: part, cond: pendingCond || '' });
          pendingCond = null;
        }
      }
      if (pendingCond) {
        throw new Error(
          `第 ${cl.lineNum + 1} 行: 条件 "if (${pendingCond})" 后面缺少目标节点 内容: "${cl.text}"`
        );
      }
      let currentSrc = label;
      for (const { target, cond } of parts) {
        currentSrc = resolveTarget(currentSrc, target, cond);
      }
      currentNode = currentSrc;
      continue;
    }

    const chainMatch = text.match(/^\[(.+?)\]\s*->\s*(.*)$/);
    if (chainMatch) {
      const srcLabel = chainMatch[1];
      let rest = chainMatch[2];
      i++;

      if (!nodeDecls.some(d => d.label === srcLabel)) {
        nodeDecls.push({ label: srcLabel, ref: '' });
      }

      const rawParts = rest.split('->').map(p => p.trim()).filter(p => p !== '');
      const parts = [];
      let pendingCond = null;
      for (const part of rawParts) {
        const ifMatch = part.match(/^if\s*\((.+)\)$/);
        if (ifMatch) {
          pendingCond = ifMatch[1].trim();
        } else {
          parts.push({ target: part, cond: pendingCond || '' });
          pendingCond = null;
        }
      }
      if (pendingCond) {
        throw new Error(
          `第 ${cl.lineNum + 1} 行: 条件 "if (${pendingCond})" 后面缺少目标节点 内容: "${cl.text}"`
        );
      }

      let currentSrc = srcLabel;
      for (const { target, cond } of parts) {
        currentSrc = resolveTarget(currentSrc, target, cond);
      }
      currentNode = currentSrc;
      continue;
    }

    // 单节点引用（无箭头），例如 for 内部剥箭头后只剩 [A]
    const soloNodeMatch = text.match(/^\[(.+?)\]\s*$/);
    if (soloNodeMatch && !text.includes('->') && !text.includes(':')) {
      ensureNodeForRef(`[${soloNodeMatch[1]}]`);
      i++;
      continue;
    }

    // 节点声明 [label]: ref
    const dm = text.match(/^\[(.+?)\]:\s*(.*)$/);
    if (dm) {
      const label = dm[1];
      const ref = dm[2].trim();
      const existing = nodeDecls.find(d => d.label === label);
      if (existing) existing.ref = ref || existing.ref;
      else nodeDecls.push({ label, ref });
      currentNode = label;
      i++;
      continue;
    }




    throw new Error(`第 ${cl.lineNum + 1} 行: 未识别的流程语法: "${text}"`);
  }

  return { nodeDecls, edges };
}

export {
  normalizeSymbols, parseFEMS, splitTopBlocks, stripComments, stripLineComments,
  extractHashSketch,
  parseMetaBlock, parseVarsBlock, parseCodeBlock,
  parseActorsBlock, parseMemoryOrContextBlock,
  parseActionBlock, parseModuleBlock, parseMainflowBlock,
  parseFlowSection,
};
