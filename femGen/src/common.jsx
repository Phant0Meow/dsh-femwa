// ═══════════════════════════════════════════════════════════════
// ═══ common.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    console.error('ErrorBoundary caught:', error, errorInfo);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 30,
            fontFamily: 'DM Sans, sans-serif',
            color: '#ef4444',
            background: '#fff5f5',
            minHeight: '100vh',
          }}
        >
          <h2>发生错误</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
            {this.state.error?.toString()}
          </pre>
          <details style={{ marginTop: 16 }}>
            <summary>组件堆栈</summary>
            <pre style={{ fontSize: 11 }}>
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>
          <button
            onClick={() => this.setState({ error: null, errorInfo: null })}
            style={{ marginTop: 16, padding: '8px 16px' }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══ FONTS ═══
// scoped=true（dsh 插件模式）：跳过 body/* 全局规则，避免污染宿主主题；
// 画布动画（呼吸灯/流光）与编辑器内 class 始终保留。
const FontStyle = ({ scoped = false }) => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
    ${scoped ? '' : '* { box-sizing: border-box; }\n    body { margin: 0; }'}
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #d1d9e6; border-radius: 3px; }
    input:focus, textarea:focus, select:focus { border-color: #3d5cf5 !important; box-shadow: 0 0 0 3px rgba(61,92,245,0.12) !important; }
    .node-drag { cursor: grabbing !important; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    @keyframes nodeGlow {
      0%, 100% { box-shadow: 0 0 8px 2px rgba(61,92,245,0.3), 0 0 16px 4px rgba(61,92,245,0.15); }
      50% { box-shadow: 0 0 16px 6px rgba(61,92,245,0.5), 0 0 32px 10px rgba(61,92,245,0.25); }
    }
    @keyframes nodeGlowError {
      0%, 100% { box-shadow: 0 0 8px 2px rgba(239,68,68,0.5), 0 0 16px 4px rgba(239,68,68,0.25); }
      50% { box-shadow: 0 0 16px 6px rgba(239,68,68,0.7), 0 0 32px 10px rgba(239,68,68,0.35); }
    }
    .streaming-cursor { animation: blink 0.8s infinite; font-weight: bold; color: #4f6ef7; }
  `}</style>
);

// ═══ CONSTANTS ═══
const NW = 100,
  NH = 64; // Action node size (w 50%, h 80%)
const MW = 110,
  MH = 74; // Module node size on canvas (w 50%, h 80%)
const SPW = 90,
  SPH = 36; // Special node size
const PSW = 90,
  PSH = 36; // Position node size

const TYPES = [
  { t: 'ai', lbl: '@ai', c: '#4f6ef7', bg: '#eef1ff' },
  { t: 'human', lbl: '@human', c: '#0ea577', bg: '#edfaf4' },
  { t: 'mind', lbl: '@mind', c: '#e11d48', bg: '#fff1f2' },
  { t: 'func', lbl: '@func', c: '#d97706', bg: '#fffbeb' },
  { t: 'assign', lbl: '@assign', c: '#8b5cf6', bg: '#f5f3ff' },
];

const ti = (t) => TYPES.find((x) => x.t === t) || TYPES[0];


const SPECIAL_COLORS = {
  START: { c: '#10b981', bg: '#ecfdf5' },
  END: { c: '#ef4444', bg: '#fef2f2' },
  IN: { c: '#10b981', bg: '#ecfdf5' },
  OUT: { c: '#ef4444', bg: '#fef2f2' },
  BREAK: { c: '#f59e0b', bg: '#fffbeb' },
  FOR: { c: '#4f6ef7', bg: '#eef1ff' },
  PAR: { c: '#7e22ce', bg: '#f3e8ff' },
};

// Nodes that can only receive connections, not send
const SINK_ONLY = new Set(['END', 'OUT', 'BREAK']);

let _n = 0,
  _e = 0,
  _a = 0,

  _m = 0;

const nid = () => `n${++_n}`;
const eid = () => `e${++_e}`;
const aid = () => `a${++_a}`;
const mid = () => `m${++_m}`;
const actionId = (path, name) => `a:${path.join('/')}:${name}`;

// ═══ NODE SIZE HELPER ═══

function getNodeSize(node) {
  if (node.type === 'special') return { w: SPW, h: SPH };
  if (node.type === 'for_out') return { w: 22, h: 22 };
  if (node.type === 'par_out') return { w: SPW, h: SPH };   // 和 PAR 节点一样大
  if (node.type === 'module') return { w: MW, h: MH };
  if (node.type === 'position') return { w: PSW, h: PSH };
  return { w: NW, h: NH };
}


// ═══ SMART PORT CALCULATION ═══
function getSmartPorts(srcNode, tgtNode, preferDifferent = false, occupiedSrcDirs = new Set(), occupiedTgtDirs = new Set()) {
  const ss = getNodeSize(srcNode);
  const ts = getNodeSize(tgtNode);
  const srcCx = srcNode.x + ss.w / 2;
  const srcCy = srcNode.y + ss.h / 2;
  const tgtCx = tgtNode.x + ts.w / 2;
  const tgtCy = tgtNode.y + ts.h / 2;

  const srcPorts = [
    { dir: 'top',    x: srcCx, y: srcNode.y },
    { dir: 'bottom', x: srcCx, y: srcNode.y + ss.h },
    { dir: 'left',   x: srcNode.x, y: srcCy },
    { dir: 'right',  x: srcNode.x + ss.w, y: srcCy },
  ];
  const tgtPorts = [
    { dir: 'top',    x: tgtCx, y: tgtNode.y },
    { dir: 'bottom', x: tgtCx, y: tgtNode.y + ts.h },
    { dir: 'left',   x: tgtNode.x, y: tgtCy },
    { dir: 'right',  x: tgtNode.x + ts.w, y: tgtCy },
  ];

  const allSrcFull = occupiedSrcDirs.size >= 4;
  const allTgtFull = occupiedTgtDirs.size >= 4;

  // 收集所有端口对，并评分
  const pairs = [];
  for (const sp of srcPorts) {
    for (const tp of tgtPorts) {
      const dx = sp.x - tp.x;
      const dy = sp.y - tp.y;
      pairs.push({
        sp, tp,
        dist: dx * dx + dy * dy,
        srcDir: sp.dir,
        tgtDir: tp.dir,
      });
    }
  }

  // 评分：srcDir/tgtDir 未被占用的得 0 分，被占用的得 1 分（全满时视为未占用）
  pairs.forEach(p => {
    const srcPenalty = (allSrcFull || !occupiedSrcDirs.has(p.srcDir)) ? 0 : 1;
    const tgtPenalty = (allTgtFull || !occupiedTgtDirs.has(p.tgtDir)) ? 0 : 1;
    p.score = srcPenalty + tgtPenalty;
  });

  // 先按评分升序（分数越低越优），再按距离升序
  pairs.sort((a, b) => a.score - b.score || a.dist - b.dist);
  const best = pairs[0];

  if (preferDifferent && pairs.length > 1) {
    // 找第一个和 best 方向不同的对
    for (const p of pairs) {
      if (p.srcDir !== best.srcDir || p.tgtDir !== best.tgtDir) {
        return {
          srcPort: { x: p.sp.x, y: p.sp.y },
          tgtPort: { x: p.tp.x, y: p.tp.y },
          srcDir: p.srcDir,
          tgtDir: p.tgtDir,
        };
      }
    }
  }

  return {
    srcPort: { x: best.sp.x, y: best.sp.y },
    tgtPort: { x: best.tp.x, y: best.tp.y },
    srcDir: best.srcDir,
    tgtDir: best.tgtDir,
  };
}

// ═══ SMART BEZIER — 控制点提取 ═══
function getControlPoints(x1, y1, dir1, x2, y2, dir2) {
  const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const offset = Math.max(40, Math.min(dist * 0.4, 120));
  let cx1 = x1, cy1 = y1, cx2 = x2, cy2 = y2;
  switch (dir1) {
    case 'right':  cx1 = x1 + offset; break;
    case 'left':   cx1 = x1 - offset; break;
    case 'bottom': cy1 = y1 + offset; break;
    case 'top':    cy1 = y1 - offset; break;
  }
  switch (dir2) {
    case 'left':   cx2 = x2 - offset; break;
    case 'right':  cx2 = x2 + offset; break;
    case 'top':    cy2 = y2 - offset; break;
    case 'bottom': cy2 = y2 + offset; break;
  }
  return { p0: { x: x1, y: y1 }, p1: { x: cx1, y: cy1 }, p2: { x: cx2, y: cy2 }, p3: { x: x2, y: y2 } };
}

// ═══ SMART BEZIER — 路径字符串（向后兼容） ═══
function smartBezier(x1, y1, dir1, x2, y2, dir2) {
  const { p0, p1, p2, p3 } = getControlPoints(x1, y1, dir1, x2, y2, dir2);
  return `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
}

// ═══ 贝塞尔曲线中点（t=0.5 处精确坐标） ═══
// C(0.5) = (P0 + 3*P1 + 3*P2 + P3) / 8
function bezierMidpoint(x1, y1, dir1, x2, y2, dir2) {
  const { p0, p1, p2, p3 } = getControlPoints(x1, y1, dir1, x2, y2, dir2);
  //console.log('[bezierMidpoint]', { p0, p1, p2, p3 });
  return {
    x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
    y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
  };
}

// ═══ 端口偏移计算（同方向多边分流） ═══
function applyPortOffset(port, dir, nodeObj, edgeId, portEdgeGroupMap) {
  if (!port) return port;
  // for_out 节点不平移（par_out 不在 portEdgeGroupMap 中，自然不偏移）
  if (nodeObj && nodeObj.type === 'for_out') return port;
  const key = `${nodeObj.id}:${dir}`;
  const group = portEdgeGroupMap[key];
  if (!group || group.count <= 1) return port;
  const idx = group.indices[edgeId] ?? 0;
  const total = group.count;
  const gap = 6;
  const offsetAmount = (idx - (total - 1) / 2) * gap;
  if (dir === 'top' || dir === 'bottom') {
    return { x: port.x + offsetAmount, y: port.y };
  }
  return { x: port.x, y: port.y + offsetAmount };
}

// ═══ PAR 平行线端口生成 ═══
function generateParallelPorts(port, dir, count, gap) {
  if (!port || port.x == null || port.y == null) return [];
  if (count <= 1) return [port];
  const result = [];
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * gap;
    if (dir === 'top' || dir === 'bottom') {
      result.push({ x: port.x + off, y: port.y });
    } else {
      result.push({ x: port.x, y: port.y + off });
    }
  }
  return result;
}

// ═══ 统一边几何计算 ═══
// 输出：{ pathDs, labelPos, srcPorts, tgtPorts, midIdx, srcDir, tgtDir }
// 不含样式判定（颜色/marker/dashArray 留在渲染层）
function computeEdgeGeometry(edge, srcNode, tgtNode, options) {
  const {
    isCycleEdge = false,
    isParEdge = false,
    parLineCount = 5,
    parGap = 6,
    portEdgeGroupMap = {},
  } = options;

  // console.log('[computeEdgeGeometry] edge.id=', edge.id, 'src=', srcNode.id, 'tgt=', tgtNode.id,
  //  'isCycleEdge=', isCycleEdge, 'isParEdge=', isParEdge);

  // 1. 智能端口选择
  let { srcPort, tgtPort, srcDir, tgtDir } = getSmartPorts(srcNode, tgtNode, isCycleEdge);
  // console.log('[computeEdgeGeometry] getSmartPorts:', { srcPort, tgtPort, srcDir, tgtDir });

  // 2. for_out 特殊端口：强制为节点中心
  if (srcNode.type === 'for_out') {
    srcPort = { x: srcNode.x + 11, y: srcNode.y + 11 };
    srcDir = 'center';
  }
  if (tgtNode.type === 'for_out') {
    tgtPort = { x: tgtNode.x + 11, y: tgtNode.y + 11 };
    tgtDir = 'center';
  }

  // 3. 端口偏移（多边同向分组）
  const adjustedSrcPort = applyPortOffset(srcPort, srcDir, srcNode, edge.id, portEdgeGroupMap);
  const adjustedTgtPort = applyPortOffset(tgtPort, tgtDir, tgtNode, edge.id, portEdgeGroupMap);
  // console.log('[computeEdgeGeometry] adjusted:', { adjustedSrcPort, adjustedTgtPort });

  // 4. PAR 平行线
  const srcPorts = isParEdge
    ? generateParallelPorts(adjustedSrcPort, srcDir, parLineCount, parGap)
    : [adjustedSrcPort].filter(p => p && p.x != null && p.y != null);
  const tgtPorts = isParEdge
    ? generateParallelPorts(adjustedTgtPort, tgtDir, parLineCount, parGap)
    : [adjustedTgtPort].filter(p => p && p.x != null && p.y != null);

  if (srcPorts.length === 0 || tgtPorts.length === 0) {
    // console.warn('[computeEdgeGeometry] 端口为空, edge.id=', edge.id);
    return null;
  }

  // 5. 生成路径数组
  const pathDs = srcPorts.map((sp, i) => {
    const tp = tgtPorts[i];
    return smartBezier(sp.x, sp.y, srcDir, tp.x, tp.y, tgtDir);
  });

  // 6. 标签位置：中间那条线的贝塞尔 t=0.5 中点
  const midIdx = isParEdge ? Math.floor(parLineCount / 2) : 0;
  const midSrc = srcPorts[midIdx];
  const midTgt = tgtPorts[midIdx];
  const labelPos = bezierMidpoint(midSrc.x, midSrc.y, srcDir, midTgt.x, midTgt.y, tgtDir);
  // console.log('[computeEdgeGeometry] labelPos:', labelPos, 'midIdx:', midIdx, 'pathDs count:', pathDs.length);

  return {
    pathDs,
    labelPos,
    srcPorts,
    tgtPorts,
    midIdx,
    srcDir,
    tgtDir,
  };
}


// ═══ BACK EDGE DETECTION ═══
function findBackEdges(nodes, edges) {
  const adj = new Map();
  edges.forEach((e) => {
    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src).push(e);
  });
  const vis = new Set(),
    stk = new Set(),
    back = new Set();
  function dfs(id) {
    vis.add(id);
    stk.add(id);
    for (const e of adj.get(id) || []) {
      if (!vis.has(e.tgt)) dfs(e.tgt);
      else if (stk.has(e.tgt)) back.add(e.id);
    }
    stk.delete(id);
  }
  // 强制从入口节点（START/IN）开始 DFS，确保回边检测正确
  const entryNodes = nodes.filter(n =>
    n.type === 'special' && (n.specialType === 'START' || n.specialType === 'IN')
  );
  if (entryNodes.length === 0) {
    console.warn('[findBackEdges] 未找到入口节点 (START/IN), 返回空 back 集合。nodes:', nodes.map(n => `${n.id}:${n.type}:${n.specialType || ''}`));
  } else {
    entryNodes.forEach(n => {
      if (!vis.has(n.id)) dfs(n.id);
    });
  }
  //console.log('[findBackEdges] 完成, back 边数:', back.size, '节点数:', nodes.length, '边数:', edges.length);
  return back;
}

// 新增：获取环上所有边（用于渲染）—— 按 FOR 节点分组

function findAllCycleEdges(nodes, edges) {
  const adj = new Map();
  edges.forEach((e) => {
    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src).push(e);
  });

  const forNodeIds = new Set(
    nodes.filter((n) => n.specialType === 'FOR' || n.specialType === 'PAR').map((n) => n.id)
  );

  // 为 PAR 建立 par_out 目标映射
  const parOutTargetMap = new Map();
  nodes.forEach((n) => {
    if (n.specialType === 'PAR' && n.forOutNodeId) {
      parOutTargetMap.set(n.id, n.forOutNodeId);
    }
  });

  const cycleMap = new Map();

  for (const startId of forNodeIds) {
    const visitedEdges = new Set();
    const pathEdges = [];
    const collected = new Set();
    const recStack = new Set(); // 防止非目标子环导致无限递归

    function dfs(currentId) {
      if (recStack.has(currentId)) {
        // console.log('[findAllCycleEdges] recStack 命中非目标节点:', currentId, 'startId:', startId, '当前路径边数:', pathEdges.length, '停止深入');
        return;
      }
      recStack.add(currentId);

      for (const e of adj.get(currentId) || []) {
        if (visitedEdges.has(e.id)) continue;
        visitedEdges.add(e.id);
        pathEdges.push(e.id);

        // FOR 环回到自身，PAR 环回到对应的 par_out 节点
        const isCycle =
          e.tgt === startId ||
          (parOutTargetMap.has(startId) &&
           parOutTargetMap.get(startId) != null &&
           e.tgt === parOutTargetMap.get(startId));

        if (isCycle) {
          pathEdges.forEach((id) => collected.add(id));
          // console.log('[findAllCycleEdges] 找到环! startId:', startId, '路径边数:', pathEdges.length, '累计收集:', collected.size);
        } else if (recStack.has(e.tgt)) {
          // ★ 回指上游节点：收录当前路径所有边（含此回指边自身），不递归
          const beforeSize = collected.size;
          pathEdges.forEach((id) => collected.add(id));
          // console.log('[findAllCycleEdges] 回指边收录, startId:', startId, 'currentId:', currentId, 'e.id:', e.id, 'e.tgt:', e.tgt, 'pathEdges:', [...pathEdges], '新增边数:', collected.size - beforeSize);
        } else {
          dfs(e.tgt);
        }

        pathEdges.pop();
        visitedEdges.delete(e.id);
      }

      recStack.delete(currentId);
    }

    dfs(startId);
    //console.log('[findAllCycleEdges] startId:', startId, '收集边数:', collected.size);
    if (collected.size > 0) {
      cycleMap.set(startId, collected);
    }
  }

  return cycleMap;
}


// ═══ SHARED STYLES ═══
const inp = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: 7,
  border: '1.5px solid #dde4ef',
  fontSize: 12.5,
  color: '#1b2540',
  background: '#f8fafc',
  outline: 'none',
  fontFamily: 'DM Sans, sans-serif',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};
const btnP = {
  padding: '8px 16px',
  borderRadius: 7,
  background: '#3d5cf5',
  color: 'white',
  border: 'none',
  cursor: 'pointer',
  fontSize: 12.5,
  fontWeight: 700,
  fontFamily: 'DM Sans, sans-serif',
  transition: 'opacity 0.12s',
};
const btnS = {
  padding: '8px 16px',
  borderRadius: 7,
  background: 'white',
  color: '#5a6a8a',
  border: '1.5px solid #dde4ef',
  cursor: 'pointer',
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: 'DM Sans, sans-serif',
};


// ═══ FIELD ═══
function F({ label, hint, children }) {
  return (
    // flex: 1 + minWidth: 0：并排字段（如 Version/Owner）在 flex 行里自动
    // 平分宽度；block 父级下 flex 属性不生效，单列布局不受影响。
    <div style={{ marginBottom: 13, flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#7a8aaa',
          marginBottom: 5,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        {label}
        {hint && (
          <span style={{ fontWeight: 400, color: '#b0bad0', fontSize: 10.5 }}>
            {hint}
          </span>
        )}
      </div>
      {children}
  </div>
  );
}

// ═══ PORT CIRCLE ═══
function PortCircle({ x, y, color, onMouseDown, onMouseUp, nodeId, portDir, portX, portY }) {
  return (
    <div
      data-port-node={nodeId}
      data-port-dir={portDir}
      data-port-x={portX}
      data-port-y={portY}
      onMouseDown={
        onMouseDown
          ? (e) => {
              e.stopPropagation();
              onMouseDown(e);
            }
          : undefined
      }
      onMouseUp={
        onMouseUp
          ? (e) => {
              e.stopPropagation();
              onMouseUp(e);
            }
          : undefined
      }
      style={{
        position: 'absolute',
        left: x - 12,
        top: y - 12,
        width: 24,
        height: 24,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'crosshair',
        zIndex: 30,
      }}
    >
      <div style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: 'white',
        border: `2.5px solid ${color}`,
        pointerEvents: 'none',
      }} />
    </div>
  );
}


// ═══ PROP ROW ═══
function PR({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11.5, marginBottom: 5 }}>
      <span style={{ color: '#9aaccb', minWidth: 48, flexShrink: 0 }}>{k}</span>
      <span
        style={{
          color: '#1b2540',
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {v}
      </span>
    </div>
  );
}


// ═══ DEFAULT CANVAS NODES ═══
function makeDefaultNodes(mode) {
  if (mode === 'mainflow') {
    return [
      {
        id: nid(),
        type: 'special',
        specialType: 'START',
        x: 80,
        y: 200,
        label: '[START]',
      },
      {
        id: nid(),
        type: 'special',
        specialType: 'END',
        x: 600,
        y: 200,
        label: '[END]',
      },
    ];
  }
  return [
    {
      id: nid(),
      type: 'special',
      specialType: 'IN',
      x: 80,
      y: 200,
      label: '[IN]',
    },
    {
      id: nid(),
      type: 'special',
      specialType: 'OUT',
      x: 600,
      y: 200,
      label: '[OUT]',
    },
  ];
}

// ═══ NAME UNIQUENESS HELPER ═══
function getAllNames(lib, proj) {
  const names = new Set();
  (lib?.actions || []).forEach((a) => names.add(a.name));
  (lib?.modules || []).forEach((m) => names.add(m.name));
  (proj?.actors || []).forEach((a) => {
    const n = a.name?.replace('@', '');
    if (n) names.add(n);
  });
  return names;
}

export {
  ErrorBoundary, FontStyle, TYPES, ti, SPECIAL_COLORS, SINK_ONLY,
  nid, eid, aid, mid, actionId, NW, NH, MW, MH, SPW, SPH, PSW, PSH,
  getNodeSize, getSmartPorts, smartBezier, getControlPoints, bezierMidpoint,
  computeEdgeGeometry,
  findBackEdges, findAllCycleEdges, inp, btnP, btnS, F as Field,
  PortCircle, PR, makeDefaultNodes, getAllNames,
};
