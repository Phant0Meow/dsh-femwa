// ════════════════════════════════════════
// ═══════.  femGenerator.jsx     ═════════
// ════════════════════════════════════════


import { findBackEdges, findAllCycleEdges, TYPES, SPECIAL_COLORS } from './common';


// ═══ FEM GENERATOR ═══

function buildFEM(nodes, edges, proj, mode, modName, libModules, libActions) {
  if (!nodes.length) return '# 空画布，请添加节点';
  const cycleEdgesMap = findAllCycleEdges(nodes, edges);
  const back = findBackEdges(nodes, edges);
  const nm = new Map(nodes.map((n) => [n.id, n]));

  // 根据 actionId 查找 name
  const actionMap = new Map();
  (libActions || []).forEach(a => actionMap.set(a.id, a.name));

  const lines = [];

  function emitAction(a, indent) {
    const pfx = '  '.repeat(indent);
    let actorStr;
    if (a.executorType === 'func') {
      actorStr = a.executorActor ? `@func(${a.executorActor})` : `@func`;
    } else if (a.executorType === 'assign') {
      actorStr = '@assign';
    } else {
      actorStr = a.executorActor
        ? `@${a.executorType}(${a.executorActor})`
        : `@${a.executorType}`;
    }
    lines.push(`${pfx}action ${a.name} ${actorStr}:`);
    if (a.inMappings) {
      lines.push(`${pfx}  in:`);
      a.inMappings
        .split('\n')
        .filter(Boolean)
        .forEach((l) => lines.push(`${pfx}    ${l.trim()}`));
    }
    if (a.prompt) {
      lines.push(`${pfx}  prompt: |`);
      a.prompt.split('\n').forEach((l) => lines.push(`${pfx}    ${l}`));
    }
    if (a.showprompt) {
      lines.push(`${pfx}  showprompt: |`);
      a.showprompt.split('\n').forEach((l) => lines.push(`${pfx}    ${l}`));
    }
    if (a.scope) lines.push(`${pfx}  scope: ${a.scope}`);
    if (a.outVars) {
      lines.push(`${pfx}  out:`);
a.outVars.split('\n').forEach((v) => {
        const vt = v.trim();
        if (vt) lines.push(`${pfx}    ${vt}`);
      });
    }
    if (a.resolve) {
      const args = a.resolveArgs ? `(${a.resolveArgs})` : '';
      lines.push(`${pfx}  resolve: ${a.resolve}${args}`);
    }
    if (a.interrupt) lines.push(`${pfx}  interrupt: ${a.interrupt}`);
    if (a.fallback) lines.push(`${pfx}  fallback: ${a.fallback}`);
    if (a.maxRetries) lines.push(`${pfx}  max_retries: ${a.maxRetries}`);
    if (a.memory) lines.push(`${pfx}  memory: ${a.memory}`);
    if (a.context) lines.push(`${pfx}  context: ${a.context}`);
    lines.push('');
  }

  // ── meta section ──
  lines.push('meta:');
  if (proj.id) lines.push(`  id = ${proj.id}`);
  if (proj.name) lines.push(`  name = ${proj.name}`);
  if (proj.version) lines.push(`  version = ${proj.version}`);
  if (proj.owner) lines.push(`  owner = ${proj.owner}`);
  if (proj.database) lines.push(`  database = ${proj.database}`);
  if (proj.session) lines.push(`  session = ${proj.session}`);
  if (proj.delay != null) lines.push(`  delay = ${proj.delay}`);
  
  if (proj.system_safety) {
    if (typeof proj.system_safety === 'string' && proj.system_safety.includes('\n')) {
      lines.push(`  system_safety = |`);
      proj.system_safety.split('\n').forEach((l) => lines.push(`    ${l}`));
    } else {
      lines.push(`  system_safety = ${JSON.stringify(proj.system_safety)}`);
    }
  }
  if (proj.output_style) {
    if (typeof proj.output_style === 'string' && proj.output_style.includes('\n')) {
      lines.push(`  output_style = |`);
      proj.output_style.split('\n').forEach((l) => lines.push(`    ${l}`));
    } else {
      lines.push(`  output_style = ${JSON.stringify(proj.output_style)}`);
    }
  }

  const knownKeys = new Set(['id', 'name', 'version', 'owner', 'database', 'session', 'delay', 'system_safety', 'output_style', 'vars', 'code', 'actors']);
  for (const [key, value] of Object.entries(proj)) {
    if (knownKeys.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`  ${key} = |`);
      value.split('\n').forEach((l) => lines.push(`    ${l}`));
    } else {
      lines.push(`  ${key} = ${JSON.stringify(value)}`);
    }
  }
  lines.push('');

  // ── actors ──
  if (proj.actors?.length) {
    lines.push('actors:');
    proj.actors.forEach((a) => {
      const name = a.name?.startsWith('@') ? a.name : `@${a.name}`;
      const parts = [];
      // 仅在显式设置 soul 时输出；裸 actor（无 soul）保持裸写法——
      // 数字兜底（'1'/'0'）会产出编译期「soul 不存在」的文本，已废除。
      if (a.soul) parts.push(`soul:${a.soul}`);
      if (a.source) parts.push(`source:${a.source}`);
      if (a.type === 'ai' && a.tools === false) {
        parts.push('tools: false');
      } else if (a.type === 'ai' && a.tools === true) {
        parts.push('tools: true');
      } else if (a.type === 'ai' && Array.isArray(a.tools) && a.tools.length) {
        parts.push(`tools = [${a.tools.join(', ')}]`);
      }
      // 无任何属性时输出纯裸写法（不残留悬空的 "="），round-trip 对裸 actor 无损
      lines.push(parts.length > 0 ? `  ${a.type} ${name} = ${parts.join(', ')}` : `  ${a.type} ${name}`);
    });
    lines.push('');
  }

  // ── code ──
  if (proj.code && proj.code.length) {
    lines.push('code:');
    proj.code.forEach((c) => {
      const val = c.value ? `file:"${c.value}"` : '""';
      lines.push(`  ${c.name} = ${val}`);
    });
    lines.push('');
  }

// ── global vars ──
  if (proj.vars?.length) {
    lines.push('vars:');
    proj.vars.forEach(v => {
      if (v.name) lines.push(`  ${v.name} = ${v.defaultValue}`);
    });
    lines.push('');
  }
  // ── global actions ──
  (libActions || [])
    .filter((a) => a.path && a.path.length === 1 && a.path[0] === 'mainflow')
    .forEach((a) => emitAction(a, 0));

  // ── recursive module output ──
  const _emitVisited = new Set();
  function emitModule(mod, indentLevel) {
    if (_emitVisited.has(mod.id)) return;
    _emitVisited.add(mod.id);
    const pfx = '  '.repeat(indentLevel);
    lines.push(`${pfx}module ${mod.name}:`);
    
    // ═══ 修复 1：module 内部 meta 格式与项目级保持一致 ═══
    if (mod.meta && Object.keys(mod.meta).length) {
      lines.push(`${pfx}  meta:`);
      for (const [k, v] of Object.entries(mod.meta)) {
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'string' && v.includes('\n')) {
          lines.push(`${pfx}    ${k} = |`);
          v.split('\n').forEach((l) => lines.push(`${pfx}      ${l}`));
        } else {
          lines.push(`${pfx}    ${k} = ${JSON.stringify(v)}`);
        }
      }
      lines.push('');
    }
    
    if (mod.code && mod.code.length) {
      lines.push(`${pfx}  code:`);
      mod.code.forEach((c) => lines.push(`${pfx}    ${c.name} = ${c.value}`));
      lines.push('');
    }
    
    const internalActions = (libActions || []).filter(
      (a) =>
        a.path &&
        a.path.length === mod.path.length &&
        a.path.every((seg, i) => seg === mod.path[i])
    );
    
    if (mod.vars?.length) {
      lines.push(`${pfx}  vars:`);
      mod.vars.forEach(v => {
        if (v.name) lines.push(`${pfx}    ${v.name} = ${v.defaultValue}`);
      });
      lines.push('');
    }
    
    internalActions.forEach((a) => emitAction(a, indentLevel + 1));
    
    const daughterModules = (libModules || []).filter(
      (m) =>
        m.path &&
        m.path.length === mod.path.length + 1 &&
        mod.path.every((seg, i) => seg === m.path[i])
    );
    daughterModules.forEach((m) => emitModule(m, indentLevel + 1));
    
    lines.push(`${pfx}  flow:`);
    (mod.nodes || [])
      .filter((n) => n.type !== 'special' && n.type !== 'for_out' && n.type !== 'par_out')
      .forEach((n) => {
        const ref =
          n.type === 'module'
            ? `&${n.modRef || 'Module'}`
            : n.type === 'position'
            ? ''
            : actionMap.get(n.actionId) || 'unnamed';
        lines.push(`${pfx}    ${n.label}: ${ref}`);
      });
    lines.push('');
    const modCycleMap = findAllCycleEdges(mod.nodes || [], mod.edges || []);
    const modBack = findBackEdges(mod.nodes || [], mod.edges || []);
    console.log('[emitModule] 模块:', mod.name, 'cycleEdges:', modCycleMap.size, 'back:', modBack.size);
    emitFlowLines(mod.nodes || [], mod.edges || [], indentLevel + 2, lines, modCycleMap, modBack);
    lines.push('');
    // ── sketch（节点排版位置，相对于 IN 锚点；注释形式，后端忽略）──
    const modAnchor = (mod.nodes || []).find(
      n => n.type === 'special' && (n.specialType === 'IN' || n.specialType === 'START')
    );
    const modSketchNodes = (mod.nodes || []).filter(
      n => n.id !== modAnchor?.id && n.type !== 'for_out'
    );
    if (modAnchor && modSketchNodes.length > 0) {
      lines.push(`#${pfx}  sketch:`);
      modSketchNodes.forEach(n => {
        lines.push(`#${pfx}    ${n.label} = ${Math.round(n.x - modAnchor.x)}, ${Math.round(n.y - modAnchor.y)}`);
      });
      lines.push('');
    }
  }

  const topModules = (libModules || []).filter(
    (m) => m.path && m.path.length === 2 && m.path[0] === 'mainflow'
  );
  topModules.forEach((m) => emitModule(m, 0));

  // ── mainflow ──
  lines.push('mainflow:');
  const mainNodes = nodes.filter((n) => n.type !== 'special' && n.type !== 'for_out' && n.type !== 'par_out');
  mainNodes.forEach((n) => {
    const ref =
      n.type === 'module'
        ? `&${n.modRef || 'Module'}`
        : n.type === 'position'
        ? ''
        : actionMap.get(n.actionId) || 'unnamed';
    lines.push(`  ${n.label}: ${ref}`);
  });
  lines.push('');
  //console.log('[buildFEM] 主流程 emitFlowLines, 传入 back:', back.size, '边');
  emitFlowLines(nodes, edges, 1, lines, cycleEdgesMap, back);

  // ── mainflow sketch（节点排版位置，相对于 START 锚点；注释形式，后端忽略）──
  const mainAnchor = nodes.find(n => n.type === 'special' && n.specialType === 'START');
  const mainSketchNodes = nodes.filter(n => n.id !== mainAnchor?.id && n.type !== 'for_out');
  if (mainAnchor && mainSketchNodes.length > 0) {
    lines.push('\n#sketch:');
    mainSketchNodes.forEach(n => {
      lines.push(`#  ${n.label} = ${Math.round(n.x - mainAnchor.x)}, ${Math.round(n.y - mainAnchor.y)}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function emitFlowLines(nodes, edges, baseIndent, lines, cycleEdgesMap, back) {
  if (!back) {
    console.log('[emitFlowLines] back 未传入, 重新计算, nodes:', nodes.length, 'edges:', edges.length);
    back = findBackEdges(nodes, edges);
  } else {
    //console.log('[emitFlowLines] 使用传入的 back, 边数:', back.size);
  }
  const nm = new Map(nodes.map((n) => [n.id, n]));
  const pfx = '  '.repeat(baseIndent);

  const adj = new Map();
  const inAdj = new Map();
  edges.forEach((e) => {
    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src).push(e);
    if (!inAdj.has(e.tgt)) inAdj.set(e.tgt, []);
    inAdj.get(e.tgt).push(e);
  });

  // ═══ 1. 提取所有指向 FOR/PAR 节点的入口边，并从 adj 中移除，防止 walk 输出普通连线 ═══
  const specialEntryEdgesMap = new Map(); // src -> [edge]
  for (const [src, edgeList] of adj.entries()) {
    const specialEdges = edgeList.filter(e => {
      const tgtNode = nm.get(e.tgt);
      return tgtNode && tgtNode.type === 'special' &&
        (tgtNode.specialType === 'FOR' || tgtNode.specialType === 'PAR');
    });
    if (specialEdges.length > 0) {
      specialEntryEdgesMap.set(src, specialEdges);
      adj.set(src, edgeList.filter(e => !specialEdges.includes(e)));
    }
  }

  // ── 自动将新加入的入边归入 joinEntries 的 all 组 ──
  nodes.forEach(node => {
    if (node.joinEntries && node.joinEntries.length > 0) {
      const allIncoming = (inAdj.get(node.id) || [])
        .filter(e => !back.has(e.id))
        .map(e => {
          const lbl = nm.get(e.src)?.label || '';
          return lbl.replace(/^\[|\]$/g, '');  // 去括号，与 joinEntries 的 sources 一致
        })
        .filter(Boolean);
      const coveredSources = new Set();
      node.joinEntries.forEach(entry => entry.sources.forEach(s => coveredSources.add(s)));
      const newSources = allIncoming.filter(s => !coveredSources.has(s));
      if (newSources.length > 0) {
        let allEntry = node.joinEntries.find(e => e.param === 'all');
        if (!allEntry) {
          allEntry = { param: 'all', sources: [] };
          node.joinEntries.push(allEntry);
        }
        allEntry.sources.push(...newSources);
      }
    }
  });

  const emittedFors = new Set();

  // ★ 统一连接符：一处定义，四处复用
  function flowConnector(cond) {
    return cond ? `-> if (${cond}) ->` : '->';
  }

  function emitForBlock(forNodeId, indentLevel) {
    const forNode = nm.get(forNodeId);
    const isPar = forNode.specialType === 'PAR';
    const condition = forNode.forCondition || '@item in collection';
    const ipfx = '  '.repeat(indentLevel);

    // 上游节点 label
    const incomingEdges = inAdj.get(forNodeId) || [];
    const upstreamEdge = incomingEdges.find(e => !back.has(e.id));
    const upstreamLabel = upstreamEdge ? nm.get(upstreamEdge.src)?.label : '?';

    const keyword = isPar ? 'par' : 'for';
    lines.push(`${ipfx}${upstreamLabel} -> ${keyword} ${condition}:`);

    const cycleEdgeSet = cycleEdgesMap.get(forNodeId) || new Set();

    // 出口节点（for_out / par_out）
    const exitType = isPar ? 'par_out' : 'for_out';
    const forOutNode = nodes.find(n => n.type === exitType && n.forNodeId === forNodeId);
    const forOutNodeId = forOutNode?.id;

    // 收集环内边
    const entryEdges = [];
    const backEdges = [];
    const internalEdges = [];

    const stack = [forNodeId];
    const visitedForBody = new Set();

    while (stack.length > 0) {
      const cur = stack.pop();
      for (const e of adj.get(cur) || []) {
        if (!cycleEdgeSet.has(e.id)) continue;
        if (visitedForBody.has(e.id)) continue;
        visitedForBody.add(e.id);

        if (cur === forNodeId) {
          entryEdges.push(e);
        } else if (e.tgt === forNodeId || (forOutNodeId && e.tgt === forOutNodeId)) {
          backEdges.push(e);
        } else {
          internalEdges.push({ src: cur, tgt: e.tgt, cond: e.cond || '' });
        }

        if (e.tgt !== forNodeId && e.tgt !== forOutNodeId) {
          stack.push(e.tgt);
        }
      }
    }

    const bodyIndent = indentLevel + 1;
    const bp = '  '.repeat(bodyIndent);

    const entryVisited = new Set();

    for (const ee of entryEdges) {
      const startTgt = nm.get(ee.tgt);
      if (!startTgt || entryVisited.has(ee.tgt)) continue;
      entryVisited.add(ee.tgt);

      const chainParts = [];
      if (ee.cond) {
        chainParts.push(`if (${ee.cond}) -> ${startTgt.label}`);
      } else {
        chainParts.push(startTgt.label);
      }

      let current = ee.tgt;
      const localVisited = new Set([ee.id, ee.tgt]);

      while (true) {
        const outs = internalEdges.filter(e => e.src === current);
        if (outs.length === 1) {
          const nextEdge = outs[0];
          if (forOutNode && nextEdge.tgt === forOutNode.id) break;
          if (localVisited.has(nextEdge.tgt)) break;
          const tgtNode = nm.get(nextEdge.tgt);
          if (!tgtNode) break;

          if (nextEdge.cond) {
            chainParts.push(`if (${nextEdge.cond}) -> ${tgtNode.label}`);
          } else {
            chainParts.push(tgtNode.label);
          }

          localVisited.add(nextEdge.tgt);
          current = nextEdge.tgt;
        } else {
          break;
        }
      }

      // 3）如果最后一步连到出口节点，加箭头（出口侧）
      const endsAtExit = forOutNode && (adj.get(current) || []).some(e => e.tgt === forOutNode.id);
      const endsAtFor = edges.some(e => e.src === current && e.tgt === forNodeId);
      const chainStr = chainParts.join(' -> ');

      // ★ 检测回指边：当前节点是否有指向 localVisited 中已访问节点的 cinrcleEdge 出边
      const loopBackEdges = internalEdges.filter(e =>
        e.src === current && localVisited.has(e.tgt) && nm.has(e.tgt)
      );

      // ★ 检测额外出边：当前节点是否有不在 localVisited 中的 cycleEdge 出边（排除 forOutNode）
      const extraEdges = internalEdges.filter(e =>
        e.src === current && !localVisited.has(e.tgt) &&
        e.tgt !== current && !(forOutNode && e.tgt === forOutNode.id)
      );

      if (loopBackEdges.length > 0 || extraEdges.length > 0) {
        // 主链照常输出（含退出标记）
        const arrowSuffix = (endsAtExit || endsAtFor) ? ' ->' : '';
        lines.push(`${bp}-> ${chainStr}${arrowSuffix}`);
        console.log('[emitForBlock] 回指边输出, current:', nm.get(current)?.label, 'loopBack:', loopBackEdges.map(e => `${nm.get(e.src)?.label}->${nm.get(e.tgt)?.label}`), 'extra:', extraEdges.map(e => `${nm.get(e.src)?.label}->${nm.get(e.tgt)?.label}`));

        // 回指边和额外出边：作为独立行输出（不以 -> 开头）
        const seenTgt = new Set();
        for (const lb of loopBackEdges) {
          const tgtLabel = nm.get(lb.tgt)?.label;
          if (!tgtLabel || seenTgt.has(lb.tgt)) continue;
          seenTgt.add(lb.tgt);
          const srcLabel = nm.get(lb.src)?.label || '?';
          lines.push(`${bp}${srcLabel} ${flowConnector(lb.cond)} ${tgtLabel}`);
        }
        for (const ef of extraEdges) {
          const tgtLabel = nm.get(ef.tgt)?.label;
          if (!tgtLabel || seenTgt.has(ef.tgt)) continue;
          seenTgt.add(ef.tgt);
          const srcLabel = nm.get(ef.src)?.label || '?';
          lines.push(`${bp}${srcLabel} ${flowConnector(ef.cond)} ${tgtLabel}`);
        }
      } else {
        const arrowSuffix = (endsAtExit || endsAtFor) ? ' ->' : '';
        lines.push(`${bp}-> ${chainStr}${arrowSuffix}`);
      }
    }








    // 出口行
    if (forOutNode) {
      const exitEdges = adj.get(forOutNode.id) || [];
      if (exitEdges.length > 0) {
        const exitTarget = nm.get(exitEdges[0].tgt);
        if (exitTarget) {
          lines.push(`${ipfx}-> ${exitTarget.label}`);
        }
      }
    }

    emittedFors.add(forNodeId);
  }

function emitParBlock(parNodeId, indentLevel) {
    const parNode = nm.get(parNodeId);
    const condition = parNode.forCondition || '@item in collection';
    const ipfx = '  '.repeat(indentLevel);

    // 找上游节点 label
    const incomingEdges = inAdj.get(parNodeId) || [];
    const upstreamEdge = incomingEdges.find(e => !back.has(e.id));
    const upstreamLabel = upstreamEdge ? nm.get(upstreamEdge.src)?.label : '?';
    lines.push(`${ipfx}${upstreamLabel} -> par ${condition}:`);

    const bp = '  '.repeat(indentLevel + 1);
    const parOutNode = nodes.find(n => n.type === 'par_out' && n.forNodeId === parNodeId);
    const parOutId = parOutNode?.id;

    // 每条分支从 PAR 出发，向前追踪到 PAR_OUT
    const branchEdges = adj.get(parNodeId) || [];










    for (const be of branchEdges) {
      const startNode = nm.get(be.tgt);
      if (!startNode) continue;
      //console.log('[emitParBlock] 分支起点:', startNode.label, 'cond:', be.cond || '(无)');

      const chainParts = be.cond
        ? [`if (${be.cond}) -> ${startNode.label}`]
        : [startNode.label];

      let current = be.tgt;
      const localVisited = new Set([parNodeId, be.tgt]);

      // ★ 追踪过程中逐步收集所有中间节点的回边和额外出边
      const collectedLoopBacks = [];
      const collectedExtras = [];

      while (true) {
        //console.log('[emitParBlock] while 追踪, current:', nm.get(current)?.label, 'localVisited:', [...localVisited].map(id => nm.get(id)?.label).join(','));

        // ★ 每次迭代：检查当前节点是否有指向 localVisited 中已访问节点的回边
        const curLoopBacks = (adj.get(current) || []).filter(e =>
          localVisited.has(e.tgt) && nm.has(e.tgt) && e.tgt !== parNodeId
        );
        if (curLoopBacks.length > 0) {
          //console.log('[emitParBlock] 发现回边:', curLoopBacks.map(e => `${nm.get(e.src)?.label}->${nm.get(e.tgt)?.label}`).join(', '));
        }
        for (const e of curLoopBacks) collectedLoopBacks.push(e);

        // 前向出边（排除 parOut、parNode、已访问节点、back 边）
        const nexts = (adj.get(current) || []).filter(e =>
          e.tgt !== parOutId && e.tgt !== parNodeId && !localVisited.has(e.tgt) && !back.has(e.id)
        );
        //console.log('[emitParBlock] nexts:', nexts.map(e => `${nm.get(e.src)?.label}->${nm.get(e.tgt)?.label}`).join(', '), 'nexts.length:', nexts.length);

        // ★ 分叉检测：有回边 OR 前向边数量不是 1 → break
        if (curLoopBacks.length > 0 || nexts.length !== 1) {
          // 当前节点剩余的前向出边收集为额外出边
          for (const e of nexts) collectedExtras.push(e);
          if (curLoopBacks.length > 0) {
            //console.log('[emitParBlock] 回边触发 fork, 当前节点', nm.get(current)?.label, '收集前向边:', nexts.map(e => e.tgt).map(id => nm.get(id)?.label).join(', '));
          } else {
            console.log('[emitParBlock] 非回边 fork/dead-end, nexts.length:', nexts.length);
          }
          break;
        }

        // 单条前向边 → 继续追踪
        const nextEdge = nexts[0];
        const tgtNode = nm.get(nextEdge.tgt);
        if (!tgtNode) { console.log('[emitParBlock] tgtNode 为空, break'); break; }
        //console.log('[emitParBlock] 追踪前进:', nm.get(current)?.label, '->', tgtNode.label, 'cond:', nextEdge.cond || '(无)');
        chainParts.push(nextEdge.cond
          ? `if (${nextEdge.cond}) -> ${tgtNode.label}`
          : tgtNode.label);
        localVisited.add(nextEdge.tgt);
        current = nextEdge.tgt;
      }

      // 主链出口判断
      const toParOut = parOutId && (adj.get(current) || []).some(e => e.tgt === parOutId);
      const chainStr = chainParts.join(' -> ');
      //console.log('[emitParBlock] 追踪结束, current:', nm.get(current)?.label, 'toParOut:', toParOut, 'collectedLoopBacks:', collectedLoopBacks.length, 'collectedExtras:', collectedExtras.length);

      // 输出主链（含出口箭头）
      const arrowSuffix = toParOut ? ' ->' : '';
      const mainLine = `${bp}-> ${chainStr}${arrowSuffix}`;
      lines.push(mainLine);
      //console.log('[emitParBlock] 输出主链:', mainLine);

      // 输出所有收集到的回边（独立行）
      const seenBackTgt = new Set();
      for (const lb of collectedLoopBacks) {
        const tgtLabel = nm.get(lb.tgt)?.label;
        if (!tgtLabel || seenBackTgt.has(lb.tgt)) continue;
        seenBackTgt.add(lb.tgt);
        const srcLabel = nm.get(lb.src)?.label || '?';
        const line = `${bp}${srcLabel} ${flowConnector(lb.cond)} ${tgtLabel}`;
        lines.push(line);
        //console.log('[emitParBlock] 输出回边:', line);
      }

      // 输出所有收集到的额外出边（独立行，检查目标是否有到 parOut 的出口）
      const seenExtraTgt = new Set();
      for (const ef of collectedExtras) {
        const tgtLabel = nm.get(ef.tgt)?.label;
        if (!tgtLabel || seenExtraTgt.has(ef.tgt)) continue;
        seenExtraTgt.add(ef.tgt);
        // ★ 额外出边的目标节点如果直接连到 parOut，追加出口箭头
        const tgtHasParOut = parOutId && (adj.get(ef.tgt) || []).some(e2 => e2.tgt === parOutId);
        const srcLabel = nm.get(ef.src)?.label || '?';
        const extraArrow = tgtHasParOut ? ' ->' : '';
        const line = `${bp}${srcLabel} ${flowConnector(ef.cond)} ${tgtLabel}${extraArrow}`;
        lines.push(line);
        //console.log('[emitParBlock] 输出额外出边:', line, 'tgtHasParOut:', tgtHasParOut);
      }
    }

    // PAR 出口行
    if (parOutNode) {
      const exitEdges = adj.get(parOutNode.id) || [];
      if (exitEdges.length > 0) {
        const exitTarget = nm.get(exitEdges[0].tgt);
        if (exitTarget) lines.push(`${ipfx}-> ${exitTarget.label}`);
      }
    }
    emittedFors.add(parNodeId);
  }



  // ═══ 修复 3：position 节点不参与 join 阻塞 ═══
  const joinNodes = new Map();
  inAdj.forEach((eds, nodeId) => {
    const node = nm.get(nodeId);
    if (node && node.type === 'position') return;
    if (node && node.type === 'par_out') return;
    const normal = eds.filter((e) => !back.has(e.id));
    if (normal.length > 1) joinNodes.set(nodeId, normal.length);
  });

  const startNode = nodes.find(
    (n) =>
      n.type === 'special' &&
      (n.specialType === 'START' || n.specialType === 'IN')
  );

  if (startNode) {
    const visited = new Set();
    const joinReached = new Map();

    function walk(id) {
      const node = nm.get(id);
      if (!node) return;

      if ((node.specialType === 'FOR' || node.specialType === 'PAR') && (!cycleEdgesMap || !cycleEdgesMap.has(id))) {
        return;
      }

      // ═══ 2. 遍历入口边，生成 for/par 块 ═══
      const specialEntries = specialEntryEdgesMap.get(id) || [];
      for (const se of specialEntries) {
        const tgtNode = nm.get(se.tgt);
        if (!tgtNode || emittedFors.has(se.tgt)) continue;
        // ★ 区分 FOR 和 PAR：PAR 必须走 emitParBlock，否则回边场景会丢出口箭头
        if (tgtNode.specialType === 'PAR') {
          //console.log('[walk] specialEntry→PAR, id:', id, 'label:', tgtNode.label, '→ emitParBlock');
          emitParBlock(se.tgt, baseIndent);
        } else {
          //console.log('[walk] specialEntry→FOR, id:', id, 'label:', tgtNode.label, '→ emitForBlock');
          emitForBlock(se.tgt, baseIndent);
        }
        const exitType = tgtNode.specialType === 'PAR' ? 'par_out' : 'for_out';
        const forOutNode = nodes.find(n => n.type === exitType && n.forNodeId === se.tgt);
        if (forOutNode) {
          const exitEdges = adj.get(forOutNode.id) || [];
          if (exitEdges.length > 0) walk(exitEdges[0].tgt);
        }
      }

      if (joinNodes.has(id) || (node.joinEntries && node.joinEntries.length > 0)) {
        // 如果节点有 joinEntries，使用其中定义的参数和源列表；
        // 否则是自动检测的汇聚，生成 join(all)
        if (node.joinEntries && node.joinEntries.length > 0) {
          // 等待所有入边都就位（如果该节点在 joinNodes 中）
          if (joinNodes.has(id)) {
            const cnt = (joinReached.get(id) || 0) + 1;
            joinReached.set(id, cnt);
            if (cnt < joinNodes.get(id)) return;
          }
          for (const entry of node.joinEntries) {
            lines.push(`${pfx}join(${entry.param}):`);
            for (const srcLabel of entry.sources) {
              const clean = String(srcLabel).replace(/^\[|\]$/g, '');
              lines.push(`${pfx}  [${clean}] ->`);
            }
            lines.push(`${pfx}to ${node.label}`);
          }
        } else if (joinNodes.has(id)) {
          const cnt = (joinReached.get(id) || 0) + 1;
          joinReached.set(id, cnt);
          if (cnt < joinNodes.get(id)) return;
          const sources = inAdj.get(id).filter((e) => !back.has(e.id));
          // 自动生成 joinEntries 的 all 条目，方便后续新增边归入
          if (!node.joinEntries) node.joinEntries = [];
          node.joinEntries.push({ sources: sources.map(e => nm.get(e.src)?.label).filter(Boolean), param: 'all' });
          lines.push(`${pfx}join(all):`);
          sources.forEach((e) =>
            lines.push(`${pfx}  ${nm.get(e.src)?.label} ->`)
          );
          lines.push(`${pfx}to ${node.label}`);
        }
      }

// PAR 节点：分支向前汇聚，不走 cycleEdgesMap，单独处理
      if (node.specialType === 'PAR') {
        if (!emittedFors.has(id)) {
          emitParBlock(id, baseIndent);
          const parOutNode = nodes.find(n => n.type === 'par_out' && n.forNodeId === id);
          if (parOutNode) {
            const exitEdges = adj.get(parOutNode.id) || [];
            if (exitEdges.length > 0) walk(exitEdges[0].tgt);
          }
        }
        if (!visited.has(id)) visited.add(id);
        return;
      }

      // ═══ 修复 4：FOR 节点必须标记 visited，防止重复 emit 和断链 ═══
      if (node.specialType === 'FOR' && cycleEdgesMap && cycleEdgesMap.has(id)) {
        if (!emittedFors.has(id)) {
emitForBlock(id, baseIndent);
          const forOutNode = nodes.find(n => n.type === 'for_out' && n.forNodeId === id);
          if (forOutNode) {
            const exitEdges = adj.get(forOutNode.id) || [];
            if (exitEdges.length > 0) walk(exitEdges[0].tgt);
          }
        }
        if (!visited.has(id)) visited.add(id);
        return;
      }

      if (visited.has(id)) return;
      visited.add(id);

      const outs = (adj.get(id) || []).filter((e) => {
        if (back.has(e.id)) return false;
        const tgtNode = nm.get(e.tgt);
        if (tgtNode && tgtNode.specialType === 'FOR' && !cycleEdgesMap?.has(e.tgt)) return false;
        return true;
      });

      const backOuts = (adj.get(id) || []).filter((e) => back.has(e.id));

if (backOuts.length) {
        if (outs.length > 0 || backOuts.some(e => e.cond)) {
          // 带条件的回边 + 前向边 → 统一生成 fork:
          const allEdges = [...backOuts, ...outs];
          lines.push(`${pfx}${node.label} -> fork:`);
          const seenForkTgt = new Set();
          allEdges.forEach((e) => {
            const tgt = nm.get(e.tgt);
            if (!tgt || seenForkTgt.has(tgt.id)) return;
            seenForkTgt.add(tgt.id);
            const cond = e.cond ? ` if (${e.cond}) ->` : '';
            lines.push(`${pfx}  ->${cond} ${tgt.label}`);
          });
          outs.forEach((e) => walk(e.tgt));
          return;
        }
        // 纯无条件回边（简单 for 循环）：输出显式边（不再生成 # for loop 注释）
        backOuts.forEach((e) => {
          lines.push(`${pfx}${node.label} -> ${nm.get(e.tgt)?.label}`);
        });
      }

      // 过滤掉指向 PAR 的边（由 emitParBlock 统一处理）
      const outsWithoutPar = outs.filter(e => {
        const tgtNode = nm.get(e.tgt);
        return !(tgtNode && tgtNode.specialType === 'PAR');
      });

      if (outsWithoutPar.length === 0) {
        // 只剩 PAR 出口，交给 emitParBlock（如果还没处理）
        outs.forEach(e => {
          const tgtNode = nm.get(e.tgt);
          if (tgtNode && tgtNode.specialType === 'PAR' && !emittedFors.has(e.tgt)) {
            emitParBlock(e.tgt, baseIndent);
            const parOutNode = nodes.find(n => n.type === 'par_out' && n.forNodeId === e.tgt);
            if (parOutNode) {
              const exitEdges = adj.get(parOutNode.id) || [];
              if (exitEdges.length > 0) walk(exitEdges[0].tgt);
            }
          }
        });
        return;
      }

      if (outsWithoutPar.length === 1) {
        const e = outsWithoutPar[0];
        const tgt = nm.get(e.tgt);
        if (tgt && tgt.specialType === 'FOR' && cycleEdgesMap?.has(e.tgt)) {
          walk(e.tgt);
        } else if (tgt && tgt.specialType === 'PAR' && !emittedFors.has(e.tgt)) {
          emitParBlock(e.tgt, baseIndent);
          const parOutNode = nodes.find(n => n.type === 'par_out' && n.forNodeId === e.tgt);
          if (parOutNode) {
            const exitEdges = adj.get(parOutNode.id) || [];
            if (exitEdges.length > 0) walk(exitEdges[0].tgt);
          }
        } else if (tgt && !joinNodes.has(e.tgt)) {
          const cond = e.cond ? ` if (${e.cond}) ->` : '';
          lines.push(`${pfx}${node.label} ->${cond} ${tgt.label}`);
          walk(e.tgt);
        } else {
          walk(e.tgt);
        }
      } else {
        // 分离 PAR 出口和普通出口
        const parOuts = [];
        const normalOuts = [];
        outs.forEach(e => {
          const tgtNode = nm.get(e.tgt);
          if (tgtNode && tgtNode.specialType === 'PAR') {
            parOuts.push(e);
          } else {
            normalOuts.push(e);
          }
        });

        // 先处理 PAR 出口（不打印普通边）
        parOuts.forEach(e => {
          if (!emittedFors.has(e.tgt)) {
            emitParBlock(e.tgt, baseIndent);
            const parOutNode = nodes.find(n => n.type === 'par_out' && n.forNodeId === e.tgt);
            if (parOutNode) {
              const exitEdges = adj.get(parOutNode.id) || [];
              if (exitEdges.length > 0) walk(exitEdges[0].tgt);
            }
          }
        });

        // 普通出口正常打印 fork
        if (normalOuts.length > 0) {
          lines.push(`${pfx}${node.label} -> fork:`);
          const seenTgt = new Set();
          normalOuts.forEach((e) => {
            const tgt = nm.get(e.tgt);
            if (!tgt || seenTgt.has(tgt.id)) return;
            seenTgt.add(tgt.id);
            const cond = e.cond ? ` if (${e.cond}) ->` : '';
            lines.push(`${pfx}  ->${cond} ${tgt.label}`);
          });
          normalOuts.forEach((e) => walk(e.tgt));
        }
      }
    }

    // ═══ 3. 处理 START/IN 直连特殊节点的情况 ═══
    const startSpecialEntries = specialEntryEdgesMap.get(startNode.id) || [];
    for (const se of startSpecialEntries) {
      const tgtNode = nm.get(se.tgt);
      if (!tgtNode || emittedFors.has(se.tgt)) continue;
      // ★ 区分 FOR 和 PAR
      if (tgtNode.specialType === 'PAR') {
        //console.log('[walk:START] specialEntry→PAR, label:', tgtNode.label, '→ emitParBlock');
        emitParBlock(se.tgt, baseIndent);
      } else {
        //console.log('[walk:START] specialEntry→FOR, label:', tgtNode.label, '→ emitForBlock');
        emitForBlock(se.tgt, baseIndent);
      }
      const exitType = tgtNode.specialType === 'PAR' ? 'par_out' : 'for_out';
      const forOutNode = nodes.find(n => n.type === exitType && n.forNodeId === se.tgt);
      if (forOutNode) {
        const exitEdges = adj.get(forOutNode.id) || [];
        if (exitEdges.length > 0) walk(exitEdges[0].tgt);
      }
    }

    const startOuts = (adj.get(startNode.id) || []).filter((e) => {
      if (back.has(e.id)) return false;
      const tgtNode = nm.get(e.tgt);
      if (tgtNode && tgtNode.specialType === 'FOR' && !cycleEdgesMap?.has(e.tgt)) return false;
      return true;
    });

    if (startOuts.length === 1) {
      const tgt = nm.get(startOuts[0].tgt);
      if (tgt) {
        if (tgt.specialType === 'FOR' && cycleEdgesMap?.has(tgt.id)) {
          walk(startOuts[0].tgt);
        } else {
          lines.push(`${pfx}${startNode.label} -> ${tgt.label}`);
          walk(startOuts[0].tgt);
        }
      }
    } else if (startOuts.length > 1) {
      lines.push(`${pfx}${startNode.label} -> fork:`);
      const seenStartTgt = new Set();
      startOuts.forEach((e) => {
        const tgt = nm.get(e.tgt);
        if (!tgt || seenStartTgt.has(tgt.id)) return;
        seenStartTgt.add(tgt.id);
        const cond = e.cond ? ` if (${e.cond}) ->` : '';
        lines.push(`${pfx}  ->${cond} ${tgt.label}`);
      });
      startOuts.forEach((e) => walk(e.tgt));
    }
  } else {
    const hasIncoming = new Set(edges.map((e) => e.tgt));
    const starts = nodes.filter((n) => !hasIncoming.has(n.id));
    lines.push(
      `${pfx}[START] -> ${starts.map((n) => n.label).join(', ') || '[END]'}`
    );
  }
}

export { buildFEM, emitFlowLines };
