// ═══════════════════════════════════════════════════════════════
// ═══ FemWorAuto.jsx ═══
// ═══════════════════════════════════════════════════════════════



import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ErrorBoundary, FontStyle, TYPES, ti, SPECIAL_COLORS, SINK_ONLY,
  nid, eid, mid, NW, NH, MW, MH, SPW, SPH, PSW, PSH,
  getNodeSize, getSmartPorts, smartBezier, getControlPoints, bezierMidpoint,
  computeEdgeGeometry,
  findBackEdges, findAllCycleEdges, inp, btnP, btnS, Field,
  PortCircle, PR, makeDefaultNodes, getAllNames,
} from './common';
import { parseFEMS } from './femParser';
import { buildFEM } from './femGenerator';
import { parsedToGraph } from './graphBuilder';
import { ActionNodeView, PositionNodeView, SpecialNodeView, ForOutNodeView, ParOutNodeView } from './canvasNodes';
import { LibPanel } from './libPanel';
import { ProjPanel } from './projectPanel';
import { ActionModal } from './actionModal';
import { ApiKeyModal } from './apiKeyModal';
import { BackendUrlModal } from './BackendUrlModal';
import { SoulModal } from './soulModal';
import { BubbleOverlay } from './bubbleOverlay';
import { FemPreview } from './femPreview';
import { MobileLayout, useMobile } from './mobileView';

// ═══ MAIN APP ═══
// ── 后端地址工具函数 ──
function getBackendHost() {
  try { return sessionStorage.getItem('fem_backend_host') || localStorage.getItem('fem_backend_host') || 'http://localhost'; } catch { return 'http://localhost'; }
}
function getBackendPort() {
  try { return sessionStorage.getItem('fem_backend_port') || '8000'; } catch { return '8000'; }
}
function getBackendBaseUrl() {
  const host = getBackendHost().replace(/\/+$/, '');
  const port = getBackendPort();
  return `${host}:${port}`;
}

export default function FEMEditor({ plugin = false, onRun, onStop, initialScript, initialCheckpoint, initialRunning = false, onSnapshot } = {}) {
// 插件模式：由 dsh-femwa 注入（plugin=true）——运行/停止走插件回调，
// SSE 连插件广播路由；独立模式保留原后端调用（getBackendBaseUrl）。
// initialScript/initialCheckpoint/initialRunning：会话恢复（刷新/重启/运行中打开）。
// onSnapshot(fems)：画布编辑防抖后实时写会话快照（双视图同步）。
//console.log('✅ FEMEditor 已进入渲染');
  const [locationPath, setLocationPath] = useState(['mainflow']);
  const mode =
    locationPath.length === 1 && locationPath[0] === 'mainflow'
      ? 'mainflow'
      : 'module';
  const currentModuleName =
    locationPath.length > 1 ? locationPath[locationPath.length - 1] : null;

  const [nodes, setNodes] = useState(makeDefaultNodes('mainflow'));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [edges, setEdges] = useState([]);
  const edgesRef = useRef(edges);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // ---- 统一存储 ----
  const [actionStore, setActionStore] = useState([]); // { id, path, name, executorType, ... }
  const [moduleStore, setModuleStore] = useState([]); // { id, path, name, meta, code, nodes, edges }
  const [flowStore, setFlowStore] = useState([]); // { path, nodes, edges }

  const [sel, setSel] = useState(null);
  const [drag, setDrag] = useState(null);
  const [conn, setConn] = useState(null);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('library');
  const [proj, setProj] = useState({
    name: '新篇章-Neon',
    version: '1.0',
    owner: '1',
    database: 'chronica.wor',
    session: 'new',
    system_safety: '',
    output_style: '',
    code: [],
    actors: [],
  });

  // Canvas panning & zoom
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [rightPanelWidth, setRightPanelWidth] = useState(274);
  const [isResizingRight, setIsResizingRight] = useState(false);

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const mouseDownPos = useRef({ x: 0, y: 0 });
  const mouseDownPosRef = useRef({ x: 0, y: 0 });
  const isMouseDownRef = useRef(false);
  const isDraggingRef = useRef(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, px: 0, py: 0 });


  // ── 全局强制取消拖拽/连线/平移（单击任意位置时触发） ──
  const dragRef = useRef(drag);
  const connRef = useRef(conn);
  const isPanningRef = useRef(isPanning);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  useEffect(() => { connRef.current = conn; }, [conn]);
  useEffect(() => { isPanningRef.current = isPanning; }, [isPanning]);

  useEffect(() => {
    const handler = (e) => {
      if (dragRef.current || connRef.current || isPanningRef.current) {
        setDrag(null);
        setConn(null);
        setIsPanning(false);
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('mousedown', handler, true);
    return () => window.removeEventListener('mousedown', handler, true);
  }, []);

  // 移除 savedMainflow，改用 flowStore

  // FEM preview editing
  const [femText, setFemText] = useState('');
  const [femDirty, setFemDirty] = useState(false);
  const [lastValidFem, setLastValidFem] = useState('');
  const [femError, setFemError] = useState(null);
  const [bubbleOverlay, setBubbleOverlay] = useState(null); // { nodeId }
  const [libSel, setLibSel] = useState(null); // { type: 'action'|'module', id }

  // Right panel resize logic
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingRight) return;
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 200 && newWidth <= 500) {
        setRightPanelWidth(newWidth);
      }
    };
    const handleMouseUp = () => setIsResizingRight(false);

    if (isResizingRight) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingRight]);




  // ── 后端地址/连接状态 ──
  const [backendRefreshTrigger, setBackendRefreshTrigger] = useState(0);
  const [backendConnected, setBackendConnected] = useState(null);

  // ── 后端连接状态检测 ──
  useEffect(() => {
    const checkConnection = async () => {
      if (plugin) { setBackendConnected(true); return; } // 插件模式：后端就是插件自身
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(getBackendBaseUrl() + '/api/ping', {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        setBackendConnected(resp.ok);
      } catch {
        setBackendConnected(false);
      }
    };
    checkConnection();
    const interval = setInterval(checkConnection, 5000);
    return () => clearInterval(interval);
  }, [backendRefreshTrigger]);

  // ── 工作流运行状态 ──
  const [flowStatus, setFlowStatus] = useState('idle'); // idle | running | paused
  const [activeNodeIds, setActiveNodeIds] = useState(new Set()); // 当前正在运行的节点ID，用于呼吸灯效果
  const [errorNodeIds, setErrorNodeIds] = useState(new Set());

  // ── API Key 状态 ──
  const [userApiKey, setUserApiKey] = useState(() => {
    try { return localStorage.getItem('fem_user_api_key') || ''; } catch { return ''; }
  });
  const [userApiProvider, setUserApiProvider] = useState(() => {
    try { return localStorage.getItem('fem_user_api_provider') || 'mimo'; } catch { return 'mimo'; }
  });
const [userApiUrl, setUserApiUrl] = useState(() => {
  try { return localStorage.getItem('fem_user_api_url') || ''; } catch { return ''; }
});
const [userApiModel, setUserApiModel] = useState(() => {
  try { return localStorage.getItem('fem_user_api_model') || ''; } catch { return ''; }
});
  const [apiUrlInput, setApiUrlInput] = useState(userApiUrl);
  const [apiModelInput, setApiModelInput] = useState(userApiModel);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);   // 补上这一行！
  const [apiKeyInput, setApiKeyInput] = useState(userApiKey);
  const [apiProviderSelect, setApiProviderSelect] = useState(userApiProvider);
  const [rememberKey, setRememberKey] = useState(true);
  const [runId, setRunId] = useState(null);
  const [nodeStates, setNodeStates] = useState({}); // { [nodeId]: { status, streamingText, output, prompt, history } }
  const eventSourceRef = useRef(null);
  const humanInputResolveRef = useRef(null); // 用于人类输入的 Promise resolve


  // ── 新建 SOUL ID 浮层状态 ──
  const [soulModalOpen, setSoulModalOpen] = useState(false);
  const [backendModalOpen, setBackendModalOpen] = useState(false);
  const [soulForm, setSoulForm] = useState({ soul_id: '', soul_name: '', description: '', user_id: '', password: '' });




  // Import file ref
  const fileInputRef = useRef(null);

  const cvRef = useRef(null);

  // ═══ 运行时模块自动切换 ═══
  const moduleStackRef = useRef([]);            // 运行时模块栈
  const moduleStoreRef = useRef(moduleStore);   // 绕闭包，持有最新 moduleStore
  const locationPathRef = useRef(locationPath); // 绕闭包，持有最新 locationPath
  const [canvasOpacity, setCanvasOpacity] = useState(1); // 淡入动效

  // 同步 ref
  useEffect(() => { moduleStoreRef.current = moduleStore; }, [moduleStore]);
  useEffect(() => { locationPathRef.current = locationPath; }, [locationPath]);

  // 辅助：根据路径查找模块（从 moduleStore）
  const findModuleByPath = useCallback(
    (path) => {
      if (path.length <= 1) return null;
      return moduleStore.find(
        (m) =>
          m.path &&
          m.path.length === path.length &&
          m.path.every((seg, i) => seg === path[i])
      );
    },
    [moduleStore]
  );

  // 辅助：从 actionStore 获取当前 locationPath 前缀匹配的 action 列表（祖先+自己）
  const visibleActions = useMemo(() => {
    return actionStore.filter((a) => {
      const ap = a.path || [];
      // 只显示当前层级及祖先层级的 Action（路径是 locationPath 的前缀，包括相等）
      if (ap.length > locationPath.length) return false;
      return ap.every((seg, i) => seg === locationPath[i]);
    });
  }, [actionStore, locationPath]);

  // 辅助：从 moduleStore 获取可见模块（祖先、自己、子模块、姊妹模块）
  const visibleModules = useMemo(() => {
    const anc = moduleStore.filter((m) => {
      const mp = m.path || [];
      return (
        mp.length < locationPath.length &&
        locationPath.every((seg, i) => seg === mp[i])
      );
    });
    const daughters = moduleStore.filter((m) => {
      const mp = m.path || [];
      return (
        mp.length === locationPath.length + 1 &&
        locationPath.every((seg, i) => seg === mp[i])
      );
    });
    const sisters = moduleStore.filter((m) => {
      const mp = m.path || [];
      if (mp.length !== locationPath.length) return false;
      if (mp.length === 0) return false;
      const motherSame = mp
        .slice(0, -1)
        .every((seg, i) => locationPath[i] === seg);
      const notSelf = !(
        mp.length === locationPath.length &&
        mp.every((seg, i) => seg === locationPath[i])
      );
      return motherSame && notSelf;
    });
    // 去重（理论上无重复）
    return [...new Set([...anc, ...daughters, ...sisters])];
  }, [moduleStore, locationPath]);

  // 兼容性 lib 对象，供现有代码使用（后续可逐步移除）
  const lib = useMemo(
    () => ({
      actions: visibleActions,
      modules: visibleModules,
    }),
    [visibleActions, visibleModules]
  );

  // 当前 flow 快照（用于生成 FEM 或加载时）
  const currentFlow = useMemo(() => {
    return flowStore.find((f) => {
      const fp = f.path || [];
      return (
        fp.length === locationPath.length &&
        fp.every((seg, i) => seg === locationPath[i])
      );
    });
  }, [flowStore, locationPath]);

  // 旧的注释掉的 effect 已无必要，因为画布加载和保存将统一处理

  const flowStoreRef = useRef(flowStore);
  useEffect(() => { flowStoreRef.current = flowStore; }, [flowStore]);

  // 运行时模块切换：先保存当前画布，再切换 path，触发淡入
  const saveAndNavigateRef = useRef(null);
  saveAndNavigateRef.current = (targetPath) => {
    const currentPath = locationPathRef.current;
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    setFlowStore(prev => {
      const idx = prev.findIndex(
        f => f.path?.length === currentPath.length &&
             f.path?.every((s, i) => s === currentPath[i])
      );
      const entry = { path: [...currentPath], nodes: currentNodes, edges: currentEdges };
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = entry;
        return updated;
      }
      return [...prev, entry];
    });
    setLocationPath(targetPath);
    setCanvasOpacity(0);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setCanvasOpacity(1);
      });
    });
  };

  const nm = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const backEdges = useMemo(() => {
    // console.log('[backEdges] useMemo 重算, nodes:', nodes.length, 'edges:', edges.length);
    return findBackEdges(nodes, edges);
  }, [nodes, edges]);

  const actionMap = useMemo(() => {
    const map = new Map();
    actionStore.forEach(a => map.set(a.id, a));
    return map;
  }, [actionStore]);

  const sortedEdges = useMemo(() => {
    const forOutNodeIds = new Set(
      nodes.filter(n => n.type === 'for_out' || n.type === 'par_out').map(n => n.id)
    );
    const hasForOut = (edge) => forOutNodeIds.has(edge.src) || forOutNodeIds.has(edge.tgt);
    const normal = [];
    const forOutEdges = [];
    for (const e of edges) {
      if (hasForOut(e)) {
        forOutEdges.push(e);
      } else {
        normal.push(e);
      }
    }
    return [...normal, ...forOutEdges];
  }, [edges, nodes]);


  // 按 FOR 节点分组的环边映射
  const cycleEdgesMap = useMemo(() => findAllCycleEdges(nodes, edges), [nodes, edges]);

  // 所有环边的全局集合（包含 FOR 和 PAR）
  const allCycleEdges = useMemo(() => {
    const all = new Set();
    for (const edgeSet of cycleEdgesMap.values()) {
      for (const eid of edgeSet) all.add(eid);
    }
    return all;
  }, [cycleEdgesMap]);
 

  
  // 检测从 FOR 节点出发但未形成回环的边（红色虚线）
  const forBrokenEdges = useMemo(() => {
    const broken = new Set();
    const adj = new Map();
    edges.forEach((e) => {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src).push(e);
    });
    const forNodeIds = new Set(
      nodes.filter(n => n.specialType === 'FOR').map(n => n.id)
    );
    const outNodeIds = new Set(
      nodes.filter(n => n.type === 'for_out' || n.type === 'par_out').map(n => n.id)
    );
    for (const startId of forNodeIds) {
      const stack = [startId];
      const localVisited = new Set();
      while (stack.length) {
        const cur = stack.pop();
        for (const e of adj.get(cur) || []) {
          if (localVisited.has(e.id)) continue;
          localVisited.add(e.id);
          if (outNodeIds.has(e.src) || outNodeIds.has(e.tgt)) continue;
          if (allCycleEdges.has(e.id)) continue;
          if (forNodeIds.has(e.tgt)) continue;
          broken.add(e.id);
          stack.push(e.tgt);
        }
      }
    }
    return broken;
  }, [nodes, edges, allCycleEdges]);


  // ── PAR 相关计算 ──
  const parNodeIds = useMemo(() => 
    new Set(nodes.filter(n => n.specialType === 'PAR').map(n => n.id)), 
    [nodes]
  );

// PAR 节点与其 par_out 节点的映射
const parOutNodeMap = useMemo(() => {
    const map = new Map();
    nodes.forEach(n => {
      if (n.type === 'par_out' && n.forNodeId) {
        map.set(n.forNodeId, n.id);
      }
    });
    return map;
  }, [nodes]);

  // PAR 有效边（蓝实线）：从 PAR 主节点出发，到达其对应 par_out 节点的路径上的边（不包括 par_out 出发的边）
  const parCycleEdges = useMemo(() => {
    const valid = new Set();
    const adj = new Map();
    edges.forEach(e => {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src).push(e);
    });
    const nmLocal = new Map(nodes.map(n => [n.id, n])); // O(1) 查找替代 nodes.find
    //console.log('[parCycleEdges] 开始计算, parNodeIds:', [...parNodeIds]);
    for (const parId of parNodeIds) {
      const targetOutId = parOutNodeMap.get(parId);
      if (!targetOutId) { console.warn('[parCycleEdges] PAR节点', parId, '无对应 par_out, 跳过'); continue; }
      const visitedEdges = new Set();
      const path = [];
      const recStack = new Set(); // 防止非目标子环无限递归
      function dfs(curId) {
        if (recStack.has(curId)) {
          //console.log('[parCycleEdges] recStack 命中入口, 节点:', curId, 'parId:', parId, '停止深入');
          return;
        }
        recStack.add(curId);
        if (curId === targetOutId) {
          path.forEach(eid => valid.add(eid));
          //console.log('[parCycleEdges] PAR', parId, '节点直接到达 par_out, 收集路径边数:', path.length);
          recStack.delete(curId);
          return;
        }
        // 不进入 par_out 节点
        if (nmLocal.get(curId)?.type === 'par_out') { recStack.delete(curId); return; }
        for (const e of (adj.get(curId) || [])) {
          if (visitedEdges.has(e.id)) continue;
          visitedEdges.add(e.id);
          path.push(e.id);
          if (e.tgt === targetOutId) {
            // 边直接到达 par_out
            path.forEach(eid => valid.add(eid));
            //console.log('[parCycleEdges] 边到达 par_out, parId:', parId, 'curId:', curId, 'e.id:', e.id, '收集路径边数:', path.length, '累计:', valid.size);
          } else if (recStack.has(e.tgt)) {
            // ★ 回指上游节点：收录当前路径所有边（含此回指边），不递归
            //console.log('[parCycleEdges] 回指边收录, parId:', parId, 'curId:', curId, 'e.id:', e.id, 'e.tgt:', e.tgt, 'path:', [...path], '累计:', valid.size);
            path.forEach(eid => valid.add(eid));
          } else {
            dfs(e.tgt);
          }
          path.pop();
          visitedEdges.delete(e.id);
        }
        recStack.delete(curId);
      }
      dfs(parId);
    }
    //console.log('[parCycleEdges] 计算完成, 有效边数:', valid.size);
    return valid;
  }, [nodes, edges, parNodeIds, parOutNodeMap]);

  // PAR 无效边（红虚线）：从 PAR 主节点出发，未到达 par_out 的边（同样不进入 par_out 继续）
  const parBrokenEdges = useMemo(() => {
    const broken = new Set();
    const adj = new Map();
    edges.forEach(e => {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src).push(e);
    });
    for (const parId of parNodeIds) {
      const targetOutId = parOutNodeMap.get(parId);
      if (!targetOutId) continue;
      const visited = new Set();
      const stack = [parId];
      while (stack.length) {
        const cur = stack.pop();
        // 遇到 par_out 节点不再继续
        if (nodes.find(n => n.id === cur)?.type === 'par_out') continue;
        for (const e of (adj.get(cur) || [])) {
          if (visited.has(e.id)) continue;
          visited.add(e.id);
          if (!parCycleEdges.has(e.id)) {
            broken.add(e.id);
          }
          stack.push(e.tgt);
        }
      }
    }
    return broken;
  }, [nodes, edges, parCycleEdges, parNodeIds, parOutNodeMap]);

  // 删除 parCycleEdgesMap，后续代码中如果有引用它的地方（如循环显示）请改为直接使用 parCycleEdges
  // 如果没有其他引用，可直接移除。

  // ── 连线端点偏移分组 ──
  const portEdgeGroupMap = useMemo(() => {
    // key: `${nodeId}:${dir}`, value: { edges: string[], indices: { [edgeId]: number } }
    const groups = {};
    edges.forEach(e => {
      const s = nm.get(e.src), t = nm.get(e.tgt);
      if (!s || !t) return;
      if (e.src === e.tgt) return; // 自环不参与
      const isCycle = allCycleEdges.has(e.id);
      const { srcDir, tgtDir } = getSmartPorts(s, t, isCycle);
      // 排除 for_out 节点
      const srcKey = (s.type === 'for_out' || s.type === 'par_out') ? null : `${e.src}:${srcDir}`;
      const tgtKey = (t.type === 'for_out' || t.type === 'par_out') ? null : `${e.tgt}:${tgtDir}`;
      if (srcKey) {
        if (!groups[srcKey]) groups[srcKey] = [];
        groups[srcKey].push(e.id);
      }
      if (tgtKey) {
        if (!groups[tgtKey]) groups[tgtKey] = [];
        groups[tgtKey].push(e.id);
      }
    });
    // 对每组排序，构建索引映射
    const result = {};
    for (const key in groups) {
      const edgeIds = groups[key].sort(); // 按 ID 稳定排序
      const indices = {};
      edgeIds.forEach((id, idx) => { indices[id] = idx; });
      result[key] = { edgeIds, indices, count: edgeIds.length };
    }
    return result;
  }, [edges, nodes, allCycleEdges, nm]);

  // 判断当前是否有真正在运行的节点（非完成/错误）
  const hasActiveRunningNodes = useMemo(() => {
    if (flowStatus !== 'running') return false;
    for (const id of activeNodeIds) {
      const status = nodeStates[id]?.status;
      if (status && !['ai_done', 'human_done', 'done', 'error'].includes(status)) {
        return true;
      }
    }
    return false;
  }, [flowStatus, activeNodeIds, nodeStates]);

  // All names for uniqueness check
  const allNames = useMemo(() => {
    const names = new Set();
    actionStore.forEach((a) => names.add(a.name));
    moduleStore.forEach((m) => names.add(m.name));
    (proj.actors || []).forEach((a) => {
      const n = a.name?.replace('@', '');
      if (n) names.add(n);
    });
    return names;
  }, [actionStore, moduleStore, proj]);

  // ═══ 已停用：autoFem 实时计算 ═══
  // 原因：
  // 1. 每次 nodes/edges 变化（拖拽一像素）都触发 buildFEM（含双DFS+全量序列化），性能灾难
  // 2. femDirty 一旦被意外激活，后续所有画布操作都不刷新 FEM 文本
  // 3. onSave 末尾的 setFemDirty(false) 与 React 批量更新形成竞态
  // 改为：用户点 [图到文本] 按钮或运行/导出时，调用 handleGraphToFem()
  //
  // const autoFem = useMemo(() => {
  //   try {
  //     const flowMap = new Map();
  //     flowStore.forEach((f) => flowMap.set(f.path.join('/'), f));
  //     flowMap.set(locationPath.join('/'), { path: locationPath, nodes, edges });
  //     const mainFlow = flowMap.get('mainflow');
  //     const mainNodes = mainFlow ? mainFlow.nodes : makeDefaultNodes('mainflow');
  //     const mainEdges = mainFlow ? mainFlow.edges : [];
  //     const mergedModules = moduleStore.map((mod) => {
  //       const key = mod.path.join('/');
  //       const flow = flowMap.get(key);
  //       return flow ? { ...mod, nodes: flow.nodes, edges: flow.edges } : mod;
  //     });
  //     return buildFEM(mainNodes, mainEdges, proj, mode, currentModuleName, mergedModules, actionStore);
  //   } catch (e) {
  //     console.error('autoFem 生成失败:', e);
  //     return '# 生成 FEM 时出错，请检查控制台';
  //   }
  // }, [nodes, edges, locationPath, proj, mode, currentModuleName, moduleStore, actionStore, flowStore]);
  //
  // useEffect(() => {
  //   if (!femDirty) {
  //     setFemText(autoFem);
  //     setLastValidFem(autoFem);
  //     setFemError(null);
  //   }
  // }, [autoFem, femDirty]);

  // Coordinate conversion (accounting for pan)
  const xy = useCallback(
    (e) => {
      const r = cvRef.current?.getBoundingClientRect();
      if (!r) return [0, 0];
      return [
        (e.clientX - r.left - pan.x) / scale,
        (e.clientY - r.top - pan.y) / scale,
      ];
    },
    [pan, scale]
  );

  // ── 画布状态持久化 ──
  const saveToLocalStorage = useCallback(() => {
    try {
      const updatedFlowStore = [...flowStore];
      const idx = updatedFlowStore.findIndex(
        (f) =>
          f.path?.length === locationPath.length &&
          f.path?.every((s, i) => s === locationPath[i])
      );
      const entry = {
        path: [...locationPath],
        nodes: nodesRef.current,
        edges: edgesRef.current,
      };
      if (idx >= 0) {
        updatedFlowStore[idx] = entry;
      } else {
        updatedFlowStore.push(entry);
      }
      const state = {
        nodes: nodesRef.current,
        edges: edgesRef.current,
        flowStore: updatedFlowStore,
        locationPath,
        actionStore,
        moduleStore,
        proj,
      };
      localStorage.setItem('fem_editor_state', JSON.stringify(state));
      const currentFlow = updatedFlowStore.find(f => f.path.join('/') === locationPath.join('/'));
      const entryNode = currentFlow?.nodes?.find(n => n.specialType === 'START' || n.specialType === 'IN');
      //console.log('[DEBUG] saveToLocalStorage 入口坐标:', entryNode?.x, entryNode?.y, '当前路径:', locationPath.join('/'));
    } catch (e) {
      console.warn('保存画布状态失败:', e);
    }
  }, [locationPath, actionStore, moduleStore, proj, flowStore]);

  // 当状态变化时自动保存（防抖延迟）
  useEffect(() => {
    const timer = setTimeout(() => {
      saveToLocalStorage();
    }, 10);
    return () => clearTimeout(timer);
  }, [saveToLocalStorage]);

  // 插件模式：画布编辑防抖 → 实时写会话快照（双视图同步，3s 防抖避免频繁生成）。
  useEffect(() => {
    if (!plugin || typeof onSnapshot !== 'function') return;
    const timer = setTimeout(() => {
      try {
        const fem = handleGraphToFemRef.current();
        if (fem && fem.trim()) onSnapshot(fem);
      } catch (e) {
        console.warn('[FEMEditor] 会话快照同步失败:', e);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [plugin, nodes, edges, flowStore, locationPath, actionStore, moduleStore, proj, onSnapshot]);

  // 初始化时加载状态（插件模式跳过：画布状态按会话快照恢复，不读 localStorage）
  useEffect(() => {
    if (plugin) return;
    try {
      const saved = localStorage.getItem('fem_editor_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        //console.log('[DEBUG] 从 localStorage 恢复的数据：');
        const flow = parsed.flowStore?.find(f => f.path?.join?.('/') === parsed.locationPath?.join?.('/'));
        const entryNode = flow?.nodes?.find(n => n.specialType === 'START' || n.specialType === 'IN');
        //console.log('[DEBUG] 恢复的入口坐标:', entryNode?.x, entryNode?.y, '路径:', parsed.locationPath?.join?.('/'));

        if (parsed.nodes) setNodes(parsed.nodes);
        if (parsed.edges) setEdges(parsed.edges);
        if (parsed.flowStore) setFlowStore(parsed.flowStore);
        if (parsed.locationPath) setLocationPath(parsed.locationPath);
        if (parsed.actionStore) setActionStore(parsed.actionStore);
        if (parsed.moduleStore) setModuleStore(parsed.moduleStore);
        if (parsed.proj) setProj(parsed.proj);
      }
    } catch (e) {
      console.warn('加载画布状态失败:', e);
    }
  }, []); // 仅挂载时运行一次

  // 插件模式会话恢复：剧本快照 → 文本到图加载画布 + 代码框；断点 → 「继续」+ 高亮。
  // 依赖 props（session-state 异步返回后才会触发），且 props 稳定后只执行一次。
  useEffect(() => {
    if (!plugin) return;
    if (initialScript && initialScript.trim().length > 0) {
      try {
        applyFEMText(initialScript);
        setFemText(initialScript);
        console.log('[FEMEditor] 已从会话快照恢复画布, 长度:', initialScript.length);
      } catch (e) {
        console.warn('[FEMEditor] 会话快照恢复失败:', e);
      }
    }
    if (initialCheckpoint) {
      setFlowStatus('paused'); // 按钮显示「继续」= 断点续跑
    }
    if (initialRunning) {
      // 会话已在运行（比如对话窗先启动的）：立即接入实时流，按钮显示运行态。
      setFlowStatus('running');
      connectSse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, initialScript, initialCheckpoint, initialRunning]);

  // 断点高亮：画布恢复（applyFEMText 异步 setState）完成后按 label 匹配节点。
  useEffect(() => {
    if (!plugin || !initialCheckpoint) return;
    const target = (nodes || []).find((n) => n.label === initialCheckpoint);
    if (target) setActiveNodeIds(new Set([target.id]));
  }, [plugin, initialCheckpoint, nodes]);

  // Space key for panning
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (
        e.code === 'Space' &&
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const handleKeyUp = (e) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // 全局禁止画布外的缩放（滚轮、手势、键盘）
  useEffect(() => {
    const handleGlobalWheel = (e) => {
      // 画布内的所有 wheel 事件：全面阻止浏览器默认行为（横向滑动、返回手势、缩放等）
      if (cvRef.current?.contains(e.target)) {
        e.preventDefault();
        return;
      }
      // 画布外：仅禁止 Ctrl / ⌘ 缩放
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    document.addEventListener('wheel', handleGlobalWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handleGlobalWheel, { capture: true });
  }, []);


  useEffect(() => {
    // 禁止移动端手势缩放（画布外）
    const handleGesture = (e) => {
      if (!cvRef.current?.contains(e.target)) {
        e.preventDefault();
      }
    };
    document.addEventListener('gesturestart', handleGesture);
    document.addEventListener('gesturechange', handleGesture);
    document.addEventListener('gestureend', handleGesture);
    return () => {
      document.removeEventListener('gesturestart', handleGesture);
      document.removeEventListener('gesturechange', handleGesture);
      document.removeEventListener('gestureend', handleGesture);
    };
  }, []);

  useEffect(() => {
    // 禁止 Ctrl/⌘ + 滚轮 及 Ctrl/⌘ + +/-/0 缩放（输入框内除外）
    const handleKeyZoom = (e) => {
      if (e.ctrlKey || e.metaKey) {
        const key = e.key;
        if (key === '-' || key === '+' || key === '=' || key === '0') {
          const tag = e.target.tagName;
          if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !e.target.isContentEditable) {
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyZoom, { passive: false, capture: true });
    return () => window.removeEventListener('keydown', handleKeyZoom, { capture: true });
  }, []);

  // Delete key handler
  useEffect(() => {
    const h = (e) => {
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        sel &&
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'TEXTAREA'
      ) {
          if (sel.type === 'node') {
            const node = nm.get(sel.id);
            if (node?.type === 'special') {
              const isMandatory = node.specialType === 'START' || node.specialType === 'IN';
              const sameTypeNodes = nodes.filter(n => n.type === 'special' && n.specialType === node.specialType);
              const isOnlyExit = (node.specialType === 'END' || node.specialType === 'OUT') && sameTypeNodes.length <= 1;
              if (isMandatory || isOnlyExit) return;
            }
            deleteNode(sel.id);
          } else {
            setEdges((p) => p.filter((e) => e.id !== sel.id));
            setSel(null);
          }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, nodes]);

  // 当 locationPath 变化时，加载新路径的画布（只依赖 locationPath）
  useEffect(() => {
    const currentFlowStore = flowStoreRef.current;
    const flow = currentFlowStore.find(
      (f) =>
        f.path?.length === locationPath.length &&
        f.path?.every((s, i) => s === locationPath[i])
    );
    if (flow) {
      setNodes(flow.nodes || []);
      setEdges(flow.edges || []);
    } else {
      // 没有缓存，创建默认节点
      if (locationPath.length === 1 && locationPath[0] === 'mainflow') {
        setNodes(makeDefaultNodes('mainflow'));
        setEdges([]);
      } else {
        setNodes(makeDefaultNodes('module'));
        setEdges([]);
      }
    }
  }, [locationPath]); // 不再依赖 flowStore，避免实时同步覆盖用户操作

  // Add action node to canvas
  function addNode(action, x, y) {
    const n = nodes.length;
    const id = nid();
    // 生成唯一节点标签
    const base = action.name;
    const existingLabels = new Set(nodes.map((node) => node.label));
    let label = `[${base}]`;
    if (existingLabels.has(label)) {
      let cnt = 2;
      while (existingLabels.has(`[${base}_${cnt}]`)) cnt++;
      label = `[${base}_${cnt}]`;
    }
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'action',
        actionId: action.id,
        x: x ?? 180 + (n % 3) * 240,
        y: y ?? 120 + Math.floor(n / 3) * 140,
        label,
      },
    ]);
  }

  // Add module node to canvas
  function addModuleNode(mod, x, y) {
    const n = nodes.length;
    const id = nid();
    // 生成唯一节点标签
    const base = mod.name;
    const existingLabels = new Set(nodes.map((node) => node.label));
    let label = `[${base}]`;
    if (existingLabels.has(label)) {
      let cnt = 2;
      while (existingLabels.has(`[${base}_${cnt}]`)) cnt++;
      label = `[${base}_${cnt}]`;
    }
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'module',
        modRef: mod.name,
        modDef: mod,
        x: x ?? 180 + (n % 3) * 260,
        y: y ?? 120 + Math.floor(n / 3) * 150,
        label,
      },
    ]);
  }

  // Add special node to canvas
  function addSpecialNode(specialType, x, y) {
    if (specialType === 'START' || specialType === 'IN') {
      if (nodes.some((n) => n.type === 'special' && n.specialType === specialType)) return;
    }
    const n = nodes.filter((nd) => nd.type === 'special' && nd.specialType === specialType).length;
    const id = nid();
    const label = n > 0 ? `[${specialType}_${n + 1}]` : `[${specialType}]`;
    const nodeX = x ?? 600;
    const nodeY = y ?? 200 + n * 80;

if (specialType === 'FOR') {
  const outId = nid();
  const outLabel = `${label}_出`;
  const outX = nodeX + SPW - 22;
  const outY = nodeY + (SPH - 22) / 2;
  setNodes((p) => [
    ...p,
    {
      id,
      type: 'special',
      specialType,
      x: nodeX,
      y: nodeY,
      label,
      forOutNodeId: outId,
      forCondition: '',
    },
    {
      id: outId,
      type: 'for_out',
      specialType: 'FOR_OUT',
      x: outX,
      y: outY,
      label: outLabel,
      forNodeId: id,
    },
  ]);
  } else if (specialType === 'PAR') {
    // 保证 label 唯一（考虑画布上已存在各种 label 的情况）
    const existingLabels = new Set(nodes.map((n) => n.label));
    let baseLabel = `[PAR]`;
    let candidateLabel = baseLabel;
    let counter = 2;
    while (existingLabels.has(candidateLabel)) {
      candidateLabel = `[PAR_${counter}]`;
      counter++;
    }
    const finalLabel = candidateLabel; // 例： [PAR_2]
    const baseName = finalLabel.slice(1, -1); // 去掉 [] 得到 PAR_2
    const outId = nid();
    const outLabel = `[${baseName}_出]`;
    const outX = nodeX + 220;
    const outY = nodeY;
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'special',
        specialType: 'PAR',
        x: nodeX,
        y: nodeY,
        label: finalLabel,
        forOutNodeId: outId,
        forCondition: '',
      },
      {
        id: outId,
        type: 'par_out',
        specialType: 'PAR_OUT',
        x: outX,
        y: outY,
        label: outLabel,
        forNodeId: id,
      },
    ]);
  } else {
      setNodes((p) => [
        ...p,
        {
          id,
          type: 'special',
          specialType,
          x: nodeX,
          y: nodeY,
          label,
        },
      ]);
    }
  }

  // Add position node to canvas
  function addPositionNode(x, y) {
    const existingLabels = new Set(nodes.map(n => n.label));
    let base = 'pos';
    let counter = 1;
    let label = `[${base}_${counter}]`;
    while (existingLabels.has(label)) {
      counter++;
      label = `[${base}_${counter}]`;
    }
    const id = nid();
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'position',
        x: x ?? 300,
        y: y ?? 150,
        label,
      },
    ]);
  }

  const deleteNode = useCallback((nodeId) => {
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node) return;
    const idsToDelete = new Set([nodeId]);
    if ((node.specialType === 'FOR' || node.specialType === 'PAR') && node.forOutNodeId) {
      idsToDelete.add(node.forOutNodeId);
} else if (node.type === 'for_out' && node.forNodeId) {
  idsToDelete.add(node.forNodeId);
} else if (node.type === 'par_out') {
  // par_out 节点不可单独删除，忽略
  return;
}
    setNodes(p => p.filter(n => !idsToDelete.has(n.id)));
    setEdges(p => p.filter(e => !idsToDelete.has(e.src) && !idsToDelete.has(e.tgt)));
    setSel(null);
  }, [nodesRef]);

  function handleSelectLib(type, id) {
    setLibSel({ type, id });
    setSel(null);
  }

  const handleBubbleClick = useCallback((nodeId) => {
    setBubbleOverlay({ nodeId });
  }, []);

  const handleBubbleClose = useCallback(() => {
    setBubbleOverlay(null);
  }, []);

  // ── API Key 管理 ──
  const handleSaveApiKey = () => {
    const key = apiKeyInput.trim();
    const provider = apiProviderSelect;
    const url = apiUrlInput.trim();
    const model = apiModelInput.trim();
    setUserApiKey(key);
    setUserApiProvider(provider);
    setUserApiUrl(url);
    setUserApiModel(model);
    if (rememberKey) {
      try {
        localStorage.setItem('fem_user_api_key', key);
        localStorage.setItem('fem_user_api_provider', provider);
        localStorage.setItem('fem_user_api_url', url);
        localStorage.setItem('fem_user_api_model', model);
      } catch {}
    } else {
      try {
        localStorage.removeItem('fem_user_api_key');
        localStorage.removeItem('fem_user_api_provider');
        localStorage.removeItem('fem_user_api_url');
        localStorage.removeItem('fem_user_api_model');
      } catch {}
    }
    setApiKeyModalOpen(false);
  };
  const handleClearApiKey = () => {
    setUserApiKey('');
    setApiKeyInput('');
    setUserApiUrl('');
    setUserApiModel('');
    setApiModelInput('');
    try {
      localStorage.removeItem('fem_user_api_key');
      localStorage.removeItem('fem_user_api_provider');
      localStorage.removeItem('fem_user_api_url');
      localStorage.removeItem('fem_user_api_model');
    } catch {}
  };

  // ── 新建 SOUL ID ──
  const handleCreateSoul = useCallback(async () => {
    setSoulFormError('');
    const { soul_id, soul_name, description, user_id, password } = soulForm;

    // 前端基础校验
    if (!soul_id.trim()) { setSoulFormError('soul_id 不能为空'); return; }
    if (!/^[a-zA-Z0-9]+$/.test(soul_id.trim())) { setSoulFormError('soul_id 只允许英文字母和数字'); return; }
    if (!user_id.trim()) { setSoulFormError('user_id 不能为空'); return; }
    if (!/^[a-zA-Z0-9]+$/.test(user_id.trim())) { setSoulFormError('user_id 只允许英文字母和数字'); return; }

    setSoulFormSubmitting(true);
    try {
      const resp = await fetch(getBackendBaseUrl() + '/api/souls/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          soul_id: soul_id.trim(),
          soul_name: soul_name.trim(),
          description: description.trim(),
          user_id: user_id.trim(),
          password: password,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setSoulFormError(data.error || '创建失败');
        return;
      }
      // 成功：关闭浮层，重置表单
      setSoulModalOpen(false);
      setSoulForm({ soul_id: '', soul_name: '', description: '', user_id: '', password: '' });
      setSoulFormError('');
      alert(`SOUL ID "${data.soul_id}" 创建成功！`);
    } catch (e) {
      setSoulFormError('网络错误，请检查后端是否启动');
    } finally {
      setSoulFormSubmitting(false);
    }
  }, [soulForm]);

  // ── 工作流运行：启动运行 ──
  const handleRunWorkflow = useCallback(async () => {
    console.log('[handleRunWorkflow] ====== 准备启动 ======');
    console.log('[handleRunWorkflow] flowStatus:', flowStatus);
    if (flowStatus === 'running') return;
    // 不用检查 API Key
    // ⚡ 运行前即时生成最新 FEM 文本（通过 ref 调用最新版，拿到同步返回值）
    console.log('[handleRunWorkflow] 运行前自动同步: 图 -> 文本');
    const fem = handleGraphToFemRef.current();
    console.log('[handleRunWorkflow] 同步完成, fem 长度:', fem?.length);
    console.log('[handleRunWorkflow] fem 前200字符:', fem?.slice(0, 200));
    if (!fem || !fem.trim()) {
      alert('请先编写或导入 FEM 脚本');
      return;
    }
    console.log('[handleRunWorkflow] 发送到后端...');

    // ★ 运行开始前：初始化模块栈 + 保存当前画布
    moduleStackRef.current = [];
    {
      const cp = locationPathRef.current;
      const cn = nodesRef.current;
      const ce = edgesRef.current;
      setFlowStore(prev => {
        const idx = prev.findIndex(
          f => f.path?.length === cp.length && f.path?.every((s, i) => s === cp[i])
        );
        const entry = { path: [...cp], nodes: cn, edges: ce };
        if (idx >= 0) { const u = [...prev]; u[idx] = entry; return u; }
        return [...prev, entry];
      });
    }

    setFlowStatus('running');
    setNodeStates({});
    setActiveNodeIds(new Set());

    try {
      if (plugin) {
        // 插件模式：交给 dsh-femwa 运行（保存剧本 + 启动引擎，同一 run
        // 也驱动聊天窗角色气泡）；SSE 连插件广播路由（相对路径，同源）。
        // 按钮语义：「运行」= reset 从头；「继续」（paused 态）= 断点续跑。
        if (typeof onRun === 'function') await onRun(fem, { reset: flowStatus !== 'paused' });
        setRunId(null);
        connectSse();
        return;
      }
      // 1. 发送 FEM 脚本到后端，启动运行（独立模式）
      const resp = await fetch(getBackendBaseUrl() + '/api/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': userApiKey,
          'X-API-Provider': userApiProvider,
          'X-API-Model': apiModelInput, 
          'X-API-Url': userApiUrl,
        },
        body: JSON.stringify({ fems: fem }),
      });
      const data = await resp.json();
      const newRunId = data.run_id;
      setRunId(newRunId);

      // 2. 连接 SSE 流
      const es = new EventSource(
        getBackendBaseUrl() + `/api/run/${newRunId}/stream`
      );
      eventSourceRef.current = es;

es.onmessage = (event) => {
  let evt;
  try {
    evt = JSON.parse(event.data);
  } catch (e) {
    console.error('SSE parse error:', e);
    return;
  }
  if (evt.type === 'heartbeat') return;

  console.log('[SSE onmessage]', event.data);
  handleWorkflowEvent(evt);
};

      es.onerror = (event) => {
        console.error('[SSE] 连接出错或关闭', event);
        console.log('[SSE] readyState:', es.readyState, '(0=CONNECTING, 1=OPEN, 2=CLOSED)');
        es.close();
        eventSourceRef.current = null;
        setFlowStatus('idle');
        // 清空所有活跃节点（SSE 意外断开时安全清空）
        setActiveNodeIds(new Set());
      };
    } catch (err) {
      console.error('Failed to start workflow:', err);
      alert('启动工作流失败: ' + err.message);
      setFlowStatus('idle');
      setActiveNodeIds(new Set());
    }
  }, [flowStatus, userApiKey, userApiProvider, userApiUrl]);

  // ── 暂停工作流 ──
  const handlePauseWorkflow = useCallback(async () => {
    if (!runId && !plugin) return;
    try {
      if (plugin) {
        await fetch('/dsh-femwa/pause', { method: 'POST' });
      } else {
        await fetch(getBackendBaseUrl() + `/api/run/${runId}/pause`, { method: 'POST' });
      }
      setFlowStatus('paused');
    } catch (err) {
      console.error('暂停失败:', err);
    }
  }, [runId, plugin]);

  // ── 停止工作流 ──
const handleStopWorkflow = useCallback(async () => {
    if (!runId && !plugin) return;
    try {
      if (plugin) {
        if (typeof onStop === 'function') { onStop(); return; }
        await fetch('/dsh-femwa/stop', { method: 'POST' });
      } else {
        await fetch(getBackendBaseUrl() + `/api/run/${runId}/stop`, { method: 'POST' });
      }
      // 状态将由 flow_stopped 事件更新
    } catch (err) {
      console.error('停止失败:', err);
    }
  }, [runId, plugin, onStop]);

  // ── 继续工作流 ──
  const handleResumeWorkflow = useCallback(async () => {
    if (plugin) {
      // 插件模式：续跑 = 重新发起 run（插件侧自动注入 checkpoint 续跑；
      // bridge 的 resume 是半实现，不能用于续跑）。
      await handleRunWorkflow();
      return;
    }
    if (!runId) return;
    try {
      await fetch(getBackendBaseUrl() + `/api/run/${runId}/resume`, { method: 'POST' });
      setFlowStatus('running');
    } catch (err) {
      console.error('继续失败:', err);
    }
  }, [runId, plugin, handleRunWorkflow]);

  // ── 处理工作流事件 ──
const handleWorkflowEvent = useCallback((evt) => {
  if (evt.type !== 'heartbeat') {
    console.log('[SSE event]', evt);
    console.log('[handleWorkflowEvent] 收到事件', evt);
  }
  const { type, data } = evt;
    console.log('[SSE event]', evt);

    // 无需节点匹配的事件：直接处理或忽略
    if (type === 'heartbeat' || type === 'step') return;
    const needsNodeMatch = !['flow_start', 'flow_done', 'flow_stopped', 'done', 'module_enter', 'module_exit'].includes(type);

    let matchedNode = null;
    let nodeId = undefined;

    if (needsNodeMatch) {
      const actionName = data?.node_name;
      if (!actionName) {
        console.warn('[FEM] 事件缺少 node_name:', type, data);
        return;
      }
      const currentNodes = nodesRef.current;
      matchedNode = currentNodes.find((n) => n.label === actionName);
      if (!matchedNode) {
        console.error(
          `[FEM Editor] 无法匹配节点 "${actionName}"\n` +
          `画布上的所有 action 节点如下：\n` +
          currentNodes
            .filter(n => n.type === 'action')
            .map(n => `  name="${actionStore.find(a => a.id === n.actionId)?.name || '?'}", label="${n.label}", id="${n.id}"`)
            .join('\n')
        );
        return;
      }
      nodeId = matchedNode.id;
    }
    console.log('[handleWorkflowEvent] type:', type, 'nodeId:', nodeId, 'matchedNode:', matchedNode?.label);

    switch (type) {
      case 'module_enter': {
        const enterName = data.module_name;
        console.log('[module_enter] module_name:', enterName, 'moduleStack:', [...moduleStackRef.current]);
        moduleStackRef.current.push(enterName);
        const targetModule = moduleStoreRef.current.find(m => m.name === enterName);
        if (targetModule) {
          console.log('[module_enter] 切换到画布:', targetModule.path);
          saveAndNavigateRef.current(targetModule.path);
        } else {
          console.warn('[module_enter] 模块未找到:', enterName, 'moduleStore:', moduleStoreRef.current.map(m => m.name));
        }
        break;
      }

      case 'module_exit': {
        const exitName = data.module_name;
        console.log('[module_exit] module_name:', exitName, 'moduleStack:', [...moduleStackRef.current]);
        moduleStackRef.current.pop();
        const stackTop = moduleStackRef.current[moduleStackRef.current.length - 1];
        if (stackTop) {
          const parentMod = moduleStoreRef.current.find(m => m.name === stackTop);
          if (parentMod) {
            console.log('[module_exit] 回到栈顶模块:', parentMod.path);
            saveAndNavigateRef.current(parentMod.path);
          } else {
            console.warn('[module_exit] 栈顶模块未找到:', stackTop, '，回主流程');
            saveAndNavigateRef.current(['mainflow']);
          }
        } else {
          console.log('[module_exit] 栈空，回主流程');
          saveAndNavigateRef.current(['mainflow']);
        }
        break;
      }

      case 'node_start':
        // 节点开始运行
        setActiveNodeIds(prev => new Set([...prev, nodeId]));
        setNodeStates((prev) => ({
          ...prev,
          [nodeId]: {
            ...prev[nodeId],
            status:
              data.node_type === 'ai'
                ? 'ai_streaming'
                : data.node_type === 'human'
                ? 'human_wait'
                : 'running',
            type: data.node_type,
            prompt: data.prompt || prev[nodeId]?.prompt || '',
            streamingText: '',
            output: '',
            history: data.history || prev[nodeId]?.history || [],
          },
        }));
        break;

      case 'ai_token':
        // AI 流式输出 token
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              status: 'ai_streaming',
              streamingText: (existing.streamingText || '') + data.token,
            },
          };
        });
        break;

      case 'ai_done':
        // AI 输出完成
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除该节点的错误标记（如果有）
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              status: 'ai_done',
              output: data.output || existing.streamingText,
              streamingText: '',
            },
          };
        });
        break;

case 'human_wait':
  console.log('[human_wait] 收到的 data:', data);
  console.log('[human_wait] out_vars:', data.out_vars);
  setActiveNodeIds(prev => new Set([...prev, nodeId]));
  setNodeStates((prev) => ({
    ...prev,
    [nodeId]: {
      ...prev[nodeId],
      status: 'human_wait',
      type: 'human',
      wait_key: data.wait_key || '',  // ← 这行必须有
      context: data.context || '',
      memory: data.memory || '',
      showprompt: data.showprompt || null,
      prompt: data.prompt || prev[nodeId]?.prompt || '',
      outVars: data.out_vars || [],
    },
  }));
  setBubbleOverlay({ nodeId });
  break;

case 'human_input_error':
  // 人类输入被引擎拒绝（未声明变量等）：重新打开输入框并显示错误信息
  console.log('[human_input_error] 收到的 data:', data);
  setActiveNodeIds(prev => new Set([...prev, nodeId]));
  setNodeStates((prev) => ({
    ...prev,
    [nodeId]: {
      ...prev[nodeId],
      status: 'human_wait',
      type: 'human',
      wait_key: data.wait_key || prev[nodeId]?.wait_key || '',
      inputError: data.error || '输入无效，请重新输入',
      outVars: prev[nodeId]?.outVars || [],
    },
  }));
  setBubbleOverlay({ nodeId });
  break;

      case 'context_ready':
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              context: data.context || '',
              showprompt: data.showprompt || null,
              ai_name: data.ai_name || 'AI',
            },
          };
        });
        break;

      case 'human_done':
        // 人类输入完成
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除该节点的错误标记（如果有）
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              status: 'human_done',
              output: data.input || '',
            },
          };
        });
        break;

      case 'func_result':
        // 函数执行结果
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除错误标记
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => ({
          ...prev,
          [nodeId]: {
            ...prev[nodeId],
            status: 'done',
            type: 'func',
            output: data.output || '',
          },
        }));
        break;

      case 'assign_result':
        // 赋值结果
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除错误标记
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => ({
          ...prev,
          [nodeId]: {
            ...prev[nodeId],
            status: 'done',
            type: 'assign',
            output:
              typeof data.output === 'string'
                ? data.output
                : JSON.stringify(data.output, null, 2),
          },
        }));
        break;


      case 'flow_stopped':
        setFlowStatus('idle');
        setActiveNodeIds(new Set());
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        // ★ 运行中断：清空模块栈，回主流程
        moduleStackRef.current = [];
        saveAndNavigateRef.current(['mainflow']);
        break;

      case 'flow_done':
        // 工作流执行完成
        setFlowStatus('idle');
        // 找到 END 节点，呼吸灯停在 END
        const endNode = nodesRef.current.find(
          n => n.type === 'special' && n.specialType === 'END'
        );
        setActiveNodeIds(new Set(endNode ? [endNode.id] : []));
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        // ★ 运行结束：清空模块栈，回主流程
        moduleStackRef.current = [];
        saveAndNavigateRef.current(['mainflow']);
        break;
        break;

      case 'flow_error':
        // 工作流出错：仅将对应节点标记为 error，其他分支继续运行
        if (nodeId) {
          // 标记为错误节点（独立集合，确保变红）
          setErrorNodeIds(prev => new Set([...prev, nodeId]));
          // 同时更新节点状态
          setNodeStates(prev => ({
            ...prev,
            [nodeId]: { ...prev[nodeId], status: 'error' },
          }));
          // 确保该节点仍在活跃集合中（可能有并发分支还在跑）
          setActiveNodeIds(prev => new Set([...prev, nodeId]));
        }
        alert('节点出错: ' + (data.error || '未知错误'));
        // ★ 出错时清空模块栈（不切画布，让用户看错误）
        moduleStackRef.current = [];
        break;

      case 'done':
        // SSE 流结束标记（后端 event_generator 结束时发送）
        setFlowStatus('idle');
        // 清空所有活跃节点（done 事件不携带具体节点信息）
        setActiveNodeIds(new Set());
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        // ★ 运行结束：清空模块栈，回主流程
        moduleStackRef.current = [];
        saveAndNavigateRef.current(['mainflow']);
        break;

      default:
        console.warn('[FEM] 收到未知事件类型:', type, data);
        break;
    }
  }, []);

  // 连接插件 SSE 广播（运行中打开标签页也实时接入；已连接则先关闭重连）。
  const connectSse = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource('/dsh-femwa/events');
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      let evt;
      try {
        evt = JSON.parse(event.data);
      } catch (e) {
        console.error('SSE parse error:', e);
        return;
      }
      if (evt.type === 'heartbeat' || evt.type === 'connected') return;
      handleWorkflowEvent(evt);
    };
    es.onerror = (event) => {
      console.error('[SSE] 连接出错或关闭', event);
      es.close();
      eventSourceRef.current = null;
      setFlowStatus('idle');
      setActiveNodeIds(new Set());
    };
  }, [handleWorkflowEvent]);

  // 卸载时关闭 SSE（切换标签页/关闭会话不残留连接）。
  useEffect(() => () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // ── 提交人类输入 ──
const submitHumanInput = useCallback(
  async (nodeId, chatText, assignments) => {
    const hasChat = chatText && chatText.trim();
    const hasVars = assignments && Object.keys(assignments).length > 0;
    if (!runId || (!hasChat && !hasVars)) return;

    // 直接从 nodeStates 取，不用 ref
    const waitKey = nodeStates[nodeId]?.wait_key;
    console.log('[submitHumanInput] nodeId:', nodeId, 'waitKey:', waitKey, 'chatText:', chatText);
    
    if (!waitKey) {
      console.error('[submitHumanInput] 找不到 wait_key，nodeStates[nodeId]:', nodeStates[nodeId]);
      return;
    }

    const payload = {
      wait_key: waitKey,
      chat_text: chatText || '',
      variables: assignments || {},
    };
    console.log('[submitHumanInput] payload:', JSON.stringify(payload));

    if (plugin) {
      await fetch('/dsh-femwa/human-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch(getBackendBaseUrl() + `/api/run/${runId}/human-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    setNodeStates((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        status: 'human_done',
        output: chatText || '',
      },
    }));
  },
  [runId, nodeStates, plugin]  // nodeStates 加入依赖
);

  // 保存当前画布到 flowStore（通用函数）
  const saveCurrentFlow = useCallback(() => {
    setFlowStore((prev) => {
      const exists = prev.findIndex(
        (f) =>
          f.path?.length === locationPath.length &&
          f.path?.every((s, i) => s === locationPath[i])
      );
      const entry = {
        path: [...locationPath],
        nodes: [...nodes],
        edges: [...edges],
      };
      if (exists >= 0) {
        const updated = [...prev];
        updated[exists] = entry;
        return updated;
      } else {
        return [...prev, entry];
      }
    });
  }, [locationPath, nodes, edges]);

  // 进入模块前保存当前画布
  function editModule(mod) {
    saveCurrentFlow();
    setLocationPath(mod.path);
  }

  // 当切换路径时，也应当保存当前画布（将在后续 effect 中处理）

  // Mouse handlers
  const onMM = useCallback(
    (e) => {
      // 节点拖拽、连线时，无需检查 isMouseDownRef
      if (drag) {
        setNodes((p) => {
          const draggedNode = p.find(n => n.id === drag.id);
          if (!draggedNode) return p;
          const newX = drag.ox + (e.clientX - drag.sx) / scale;
          const newY = drag.oy + (e.clientY - drag.sy) / scale;
          return p.map((n) => {
            if (n.id === drag.id) {
              return { ...n, x: newX, y: newY };
            }
// 拖拽 FOR 节点 → 联动 for_out 小圆点（PAR 不联动）
if (draggedNode.specialType === 'FOR' && n.type === 'for_out' && n.id === draggedNode.forOutNodeId) {
  return { ...n, x: newX + SPW - 22, y: newY + (SPH - 22) / 2 };
}
// 拖拽 for_out 小圆点 → 联动 FOR 节点（par_out 不联动）
if (draggedNode.type === 'for_out' && n.id === draggedNode.forNodeId) {
  return { ...n, x: newX - SPW + 22, y: newY - (SPH - 22) / 2 };
}
// par_out 完全自由移动，不做任何联动
            return n;
          });
        });
        return;
      }
      if (conn) {
        const [cx, cy] = xy(e);
        setConn((p) => ({ ...p, mx: cx, my: cy }));
        return;
      }

      // 画布平移：必须按下鼠标才开始判断
      if (!isMouseDownRef.current) return;

      if (!isPanning) {
        const dx = e.clientX - mouseDownPosRef.current.x;
        const dy = e.clientY - mouseDownPosRef.current.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          setIsPanning(true);
          isDraggingRef.current = true;
        }
        return;
      }
      setPan({
        x: panStart.px + e.clientX - panStart.x,
        y: panStart.py + e.clientY - panStart.y,
      });
    },
    [drag, conn, xy, isPanning, panStart, scale]
  );

  const handleWheel = useCallback(
    (e) => {
      //e.preventDefault();
      e.stopPropagation();
      // 阻止原生事件冒泡，避免全局 Ctrl+滚轮缩放干扰画布
      e.nativeEvent?.stopImmediatePropagation?.();

      // Ctrl / ⌘ + 滚轮 → 缩放
      if (e.ctrlKey || e.metaKey) {
        const rect = cvRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - pan.x) / scale;
        const worldY = (mouseY - pan.y) / scale;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.min(3, Math.max(0.2, scale * delta));
        const newPanX = mouseX - worldX * newScale;
        const newPanY = mouseY - worldY * newScale;
        setScale(newScale);
        setPan({ x: newPanX, y: newPanY });
      } else {
        // 普通滚轮 / 触控板双指 → 平移画布
        setPan((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    },
    [scale, pan]
  );


  const onMU = useCallback(() => {
    if (drag) {
      const draggedNode = nodesRef.current.find(n => n.id === drag.id);
      if (draggedNode && (draggedNode.specialType === 'START' || draggedNode.specialType === 'IN')) {
        const dx = draggedNode.x;
        const dy = draggedNode.y;
        //console.log('[DEBUG] 入口归零前坐标:', draggedNode.x, draggedNode.y);
        // 平移当前 flow 的所有节点，并将入口归零
        setNodes(prev => {
          const updated = prev.map(n => ({
            ...n,
            x: n.id === draggedNode.id ? 0 : n.x - dx,
            y: n.id === draggedNode.id ? 0 : n.y - dy,
          }));
          const entry = updated.find(n => n.id === draggedNode.id);
          //console.log('[DEBUG] 入口归零后坐标:', entry?.x, entry?.y);
          return updated;
        });
        // 立即同步到 flowStore（不等 saveCurrentFlow）
        setFlowStore(prev => {
          const idx = prev.findIndex(f => f.path?.length === locationPath.length && f.path?.every((s, i) => s === locationPath[i]));
          const entry = { path: [...locationPath], nodes: nodesRef.current.map(n => ({...n})) }; // 这里会拿到旧的 nodes，没关系，下一步会更新
          const updated = idx >= 0 ? [...prev] : [...prev, { path: [...locationPath], nodes: [], edges: [] }];
          if (idx >= 0) updated[idx] = { ...updated[idx], nodes: nodesRef.current.map(n => ({...n})) };
          else updated.push({ path: [...locationPath], nodes: nodesRef.current.map(n => ({...n})), edges: [] });
          //console.log('[DEBUG] flowStore 更新后当前 flow:', updated.find(f => f.path.join('/') === locationPath.join('/'))?.nodes?.find(n => n.specialType === 'START' || n.specialType === 'IN')?.x);
          return updated;
        });
      }
    }
    if (isMouseDownRef.current && !isDraggingRef.current) {
      setSel(null);
    }
    setDrag(null);
    setConn(null);
    setIsPanning(false);
    isDraggingRef.current = false;
    isMouseDownRef.current = false;
  }, [drag, nodesRef]);

  // Canvas mouse down (for panning)
  const onCanvasDown = useCallback(
    (e) => {
      if (!e.target?.dataset?.canvasBg && e.target !== cvRef.current) return;
      if (drag || isPanning || conn) {
        setDrag(null);
        setIsPanning(false);
        setConn(null);
        isDraggingRef.current = false;
        isMouseDownRef.current = false;
        return;
      }
      if (e.button === 0 || e.button === 1) {
        isMouseDownRef.current = true;
        mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
        setPanStart({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
        e.preventDefault();
      }
    },
    [pan, drag, isPanning, conn]
  );

  // Port handlers for a node
  function handlePortDown(e, nodeId, portDir, portX, portY) {
    // Sink-only nodes cannot start connections
    const node = nm.get(nodeId);
    if (node?.type === 'special' && SINK_ONLY.has(node.specialType) && portDir !== 'for_out') return;
    const [cx, cy] = xy(e);
    // 如果提供了实际端口坐标（FOR 出圆圈），使用它；否则从节点坐标计算
    let srcX = portX, srcY = portY;
    if (srcX === undefined || srcY === undefined) {
      // 默认从节点中心计算
      const size = getNodeSize(node);
      srcX = node.x + size.w / 2;
      srcY = node.y + size.h / 2;
    }
    setConn({ srcId: nodeId, srcDir: portDir, mx: cx, my: cy, srcX, srcY });
  }

  function handlePortUp(e, nodeId, portDir) {
    if (!conn) return;
    // 禁止 for_out 节点连向自己
    const targetNode = nm.get(nodeId);
    if ((targetNode?.type === 'for_out' || targetNode?.type === 'par_out') && conn.srcId === nodeId) {
      setConn(null);
      return;
    }
    if (conn.srcId === nodeId) {
      // 自环边
      if (!edges.some((ed) => ed.src === nodeId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: nodeId, tgt: nodeId, cond: '', isSelfLoop: true },
        ]);
      }
      setConn(null);
    } else {
      if (!edges.some((ed) => ed.src === conn.srcId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: conn.srcId, tgt: nodeId, cond: '' },
        ]);
      }
      setConn(null);
    }
  }

  // Handle mouse up on node body (for connection drop)
  function handleBodyMouseUp(e, nodeId) {
    if (conn && conn.srcId !== nodeId) {
      if (!edges.some((ed) => ed.src === conn.srcId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: conn.srcId, tgt: nodeId, cond: '' },
        ]);
      }
      setConn(null);
    }
  }

  // Drag from library
  function handleLibDragStart(e, type, idOrType) {
    e.dataTransfer.setData(
      'application/fem-item',
      JSON.stringify({ type, id: idOrType })
    );
    e.dataTransfer.effectAllowed = 'copy';
  }

  function handleCanvasDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleCanvasDrop(e) {
    e.preventDefault();
    let data;
    try {
      data = JSON.parse(e.dataTransfer.getData('application/fem-item'));
    } catch {
      return;
    }
    if (!data) return;

    const [cx, cy] = xy(e);
    const dropX = cx - 50;
    const dropY = cy - 20;

    if (data.type === 'action') {
      let action = lib.actions.find((a) => a.id === data.id);
      if (action && isFinite(dropX) && isFinite(dropY))
        addNode(action, dropX, dropY);
    } else if (data.type === 'module') {
      const mod = lib.modules.find((m) => m.id === data.id);
      if (mod) addModuleNode(mod, dropX, dropY);
    } else if (data.type === 'special') {
      addSpecialNode(data.id, dropX, dropY);
    } else if (data.type === 'position') {
      addPositionNode(dropX, dropY);
    }
  }

  // Import .fems file
  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        applyFEMText(text);
      } catch (err) {
        setFemError(err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // Apply FEM text (from preview or import)
  function applyFEMText(text) {
    console.log('1. 开始解析');
    const parsed = parseFEMS(text);
    console.log('2. 解析完成', parsed);
    console.log('3. 开始转换为图');
    const {
      proj: _proj,
      libActions,
      libModules,
      nodes: newNodes,
      edges: newEdges,
      mainflowNodes,
      mainflowEdges,
    } = parsedToGraph(parsed, mode, currentModuleName);
    let newProj = _proj;  // 允许后续修改
    console.log('4. 图转换完成', {
      libActions,
      libModules,
      nodes: newNodes,
      edges: newEdges,
    });
    console.log('5. 准备 setState');
    // 确保 delay 等 meta 字段从解析结果中传递过来（graphBuilder 可能遗漏）
    if (parsed.meta.delay != null) {
      newProj = { ...newProj, delay: parsed.meta.delay };
    }
    setProj(prev => ({ ...prev, ...newProj }));
    setActionStore(libActions); // libActions 已是扁平数组（含模块内部 action）
    setModuleStore(libModules);
    // 构建 flowStore：主流程 + 所有模块
    // 构建 flowStore
    const newFlowStore = (libModules || []).map((mod) => ({
      path: mod.path,
      nodes: mod.nodes || [],
      edges: mod.edges || [],
    }));
    // 根据当前路径更新或添加对应 flow
    const targetPath = locationPath;
    const existingIdx = newFlowStore.findIndex(
      (f) =>
        f.path.length === targetPath.length &&
        f.path.every((s, i) => s === targetPath[i])
    );
    if (existingIdx >= 0) {
      newFlowStore[existingIdx] = {
        path: targetPath,
        nodes: newNodes,
        edges: newEdges,
      };
    } else {
      newFlowStore.push({ path: targetPath, nodes: newNodes, edges: newEdges });
    }
    // 确保主流程存在（若当前不在主流程），使用解析出的真实 mainflow 图
    if (targetPath.length !== 1 || targetPath[0] !== 'mainflow') {
      const mainflowIdx = newFlowStore.findIndex(
        (f) => f.path.length === 1 && f.path[0] === 'mainflow'
      );
      if (mainflowIdx >= 0) {
        newFlowStore[mainflowIdx] = { path: ['mainflow'], nodes: mainflowNodes, edges: mainflowEdges };
      } else {
        newFlowStore.push({ path: ['mainflow'], nodes: mainflowNodes, edges: mainflowEdges });
      }
    }
    setFlowStore(newFlowStore);
    setNodes(newNodes);
    setEdges(newEdges);
    console.log('6. setState 完成');
    setFemDirty(false);
    setFemError(null);
    setLastValidFem(text);
    setSel(null);
    console.log('7. 全部完成');
  }

  // ═══ [图到文本]：当前画布 → .fems 文本 ═══
  // 同步 return text，因为 setState 是异步的，调用方（运行/导出）直接用返回值
  function handleGraphToFem() {
    //console.log('[handleGraphToFem] ====== 开始 ======');
    //console.log('[handleGraphToFem] locationPath:', locationPath.join('/'));
    //console.log('[handleGraphToFem] mode:', mode, ', nodes:', nodes.length, ', edges:', edges.length);
    //console.log('[handleGraphToFem] flowStore 条目:', flowStore.length);
    //console.log('[handleGraphToFem] moduleStore 条目:', moduleStore.length);
    //console.log('[handleGraphToFem] actionStore 条目:', actionStore.length);
    //console.log('[handleGraphToFem] proj.name:', proj.name, 'proj.id:', proj.id);

    // 1. 构建 flowMap
    const flowMap = new Map();
    flowStore.forEach((f) => flowMap.set(f.path.join('/'), f));
    flowMap.set(locationPath.join('/'), { path: locationPath, nodes, edges });
    //console.log('[handleGraphToFem] flowMap 大小:', flowMap.size);

    // 2. 获取主流程节点/边
    const mainFlow = flowMap.get('mainflow');
    const mainNodes = mainFlow ? mainFlow.nodes : makeDefaultNodes('mainflow');
    const mainEdges = mainFlow ? mainFlow.edges : [];
    //console.log('[handleGraphToFem] mainFlow 存在:', !!mainFlow);
    //console.log('[handleGraphToFem] mainNodes:', mainNodes.length, ', mainEdges:', mainEdges.length);

    // 3. 合并 moduleStore 与 flowMap 的最新数据
    const mergedModules = moduleStore.map((mod) => {
      const key = mod.path.join('/');
      const flow = flowMap.get(key);
      return flow ? { ...mod, nodes: flow.nodes, edges: flow.edges } : mod;
    });
    //console.log('[handleGraphToFem] mergedModules:', mergedModules.length);

    // 4. 调用 buildFEM（这里是核心计算——含双DFS+全量序列化）
    //console.log('[handleGraphToFem] 调用 buildFEM...');
    const newFem = buildFEM(
      mainNodes,
      mainEdges,
      proj,
      mode,
      currentModuleName,
      mergedModules,
      actionStore
    );
    //console.log('[handleGraphToFem] buildFEM 完成, 长度:', newFem.length);
    //console.log('[handleGraphToFem] 前300字符:', newFem.slice(0, 300));

    // 5. 更新状态
    setFemText(newFem);
    setLastValidFem(newFem);
    setFemDirty(false);
    setFemError(null);
    //console.log('[handleGraphToFem] setState 已入队（异步生效）');

    // 6. 同步返回——调用方直接用，不依赖异步 state
    //console.log('[handleGraphToFem] ====== 完成 ======');
    return newFem;
  }

  // useRef 持有最新 handleGraphToFem 引用
  // handleRunWorkflow 被 useCallback 缓存，闭包里的函数引用可能过时
  // 通过 ref.current() 总是调到本次 render 的最新版
  const handleGraphToFemRef = useRef(handleGraphToFem);
  handleGraphToFemRef.current = handleGraphToFem;
  //console.log('[ref] handleGraphToFemRef.current 已更新');

  function handleApplyFem() {
    console.log('[handleApplyFem] 开始, femText 长度:', femText?.length);
    try {
      applyFEMText(femText);
    } catch (err) {
      console.error('[handleApplyFem] 异常:', err.message);
      setFemError(err.message);
    }
  }

  function handleRestoreFem() {
    setFemText(lastValidFem);
    setFemDirty(false);
    setFemError(null);
  }

const selNode = sel?.type === 'node' ? nm.get(sel.id) : null;
  const selEdge =
    sel?.type === 'edge' ? edges.find((e) => e.id === sel.id) : null;
  const selAction = selNode?.type === 'action'
    ? actionStore.find((a) => a.id === selNode.actionId)
    : null;

  // ── 响应式布局检测 ──
  const isMobile = useMobile(768);

  // actorNames（手机端 ProjPanel 需要）
  const actorNames = (proj.actors || []).map((a) => a.name.replace('@', ''));

  // Compute temporary connection line
  function getTempConnLine() {
    if (!conn) return null;
    const srcNode = nm.get(conn.srcId);
    if (!srcNode) return null;
    const ss = getNodeSize(srcNode);

    // 对于 FOR 出口，使用出圆圈的位置
    let srcPort;
    switch (conn.srcDir) {
      case 'top':
        srcPort = { x: srcNode.x + ss.w / 2, y: srcNode.y };
        break;
      case 'bottom':
        srcPort = { x: srcNode.x + ss.w / 2, y: srcNode.y + ss.h };
        break;
      case 'left':
        srcPort = { x: srcNode.x, y: srcNode.y + ss.h / 2 };
        break;
      case 'right':
        srcPort = { x: srcNode.x + ss.w, y: srcNode.y + ss.h / 2 };
        break;
      case 'center':
        // ForOut 节点是圆形，使用实际传入的 srcX, srcY
        srcPort = { x: conn.srcX || (srcNode.x + ss.w / 2), y: conn.srcY || (srcNode.y + ss.h / 2) };
        break;
      default:
        srcPort = { x: srcNode.x + ss.w, y: srcNode.y + ss.h / 2 };
    }
    const dx = (conn.mx || 0) - srcPort.x;
    const dy = (conn.my || 0) - srcPort.y;
    let srcDir = conn.srcDir || 'right';
    if (!conn.srcDir) {
      if (Math.abs(dx) > Math.abs(dy)) srcDir = dx > 0 ? 'right' : 'left';
      else srcDir = dy > 0 ? 'bottom' : 'top';
    }
    const oppositeDir = {
      right: 'left',
      left: 'right',
      top: 'bottom',
      bottom: 'top',
    }[srcDir];
    return smartBezier(
      srcPort.x,
      srcPort.y,
      srcDir,
      conn.mx || srcPort.x,
      conn.my || srcPort.y,
      oppositeDir
    );
  }

// ────────────────────────────────────────────────────────────
  // 手机端：构建 canvasContent（SVG + 节点层）传给 MobileLayout
  // 桌面端：内联渲染，结构不变
  // ────────────────────────────────────────────────────────────

  // 删除节点（供手机端 PropsPanel 调用）
  const handleDeleteSelNode = () => {
    if (!sel || sel.type !== 'node') return;
    const node = nm.get(sel.id);
    if (node?.type === 'special') {
      const isMandatory = node.specialType === 'START' || node.specialType === 'IN';
      const sameTypeNodes = nodes.filter(n => n.type === 'special' && n.specialType === node.specialType);
      const isOnlyExit = (node.specialType === 'END' || node.specialType === 'OUT') && sameTypeNodes.length <= 1;
      if (isMandatory || isOnlyExit) return;
    }
    deleteNode(sel.id);
  };
  // 删除边（供手机端 PropsPanel 调用）
  const handleDeleteSelEdge = () => {
    if (!sel || sel.type !== 'edge') return;
    setEdges((p) => p.filter((e) => e.id !== sel.id));
    setSel(null);
  };
  // 修改边条件（供手机端 PropsPanel 调用）
  const handleCondChange = (cond) => {
    if (!sel || sel.type !== 'edge') return;
    setEdges((p) => p.map((ed) => ed.id === sel.id ? { ...ed, cond } : ed));
  };
  // 编辑选中节点的 Action（供手机端 PropsPanel 调用）
  const handleEditSelAction = () => {
    if (!selNode || !selAction) return;
    setModal({ type: 'editNode', action: selAction, nodeId: selNode.id });
  };

  if (isMobile && !plugin) {
    // 插件模式不提供移动端布局（dsh web 桌面为主）
    return (
      <ErrorBoundary>
        <FontStyle scoped={plugin} />
        <MobileLayout
          proj={proj}
          actorNames={actorNames}
          onProjChange={setProj}
          cvRef={cvRef}
          pan={pan}
          setPan={setPan}
          scale={scale}
          setScale={setScale}
nodes={nodes}
          setNodes={setNodes}
          edges={edges}
          sel={sel}
          setSel={setSel}
          drag={drag}
          setDrag={setDrag}
          conn={conn}
          setConn={setConn}
          isPanning={isPanning}
          onMM={onMM}
          onMU={onMU}
          onCanvasDown={onCanvasDown}
          handleWheel={handleWheel}
          handlePortDown={handlePortDown}
          handlePortUp={handlePortUp}
          handleCanvasDragOver={handleCanvasDragOver}
          handleCanvasDrop={handleCanvasDrop}
          canvasOpacity={canvasOpacity}
          canvasContent={
            <>
              <svg
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 24 }}
              >
                <defs>
                  {[['a','#94a3b8'],['as','#3d5cf5'],['a_for','#4f6ef7'],['al','#ef4444'],['aj','#f59e0b']].map(([id,col]) => (
                    <marker key={id} id={id} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                      <polygon points="0 0, 8 3, 0 6" fill={col} />
                    </marker>
                  ))}
                </defs>
                {sortedEdges.map((e) => {
                  const s = nm.get(e.src), t = nm.get(e.tgt);
                  if (!s || !t) return null;
                  const isCycleEdge = allCycleEdges.has(e.id);
                  const isParCycle = parCycleEdges.has(e.id);
                  const isParBroken = parBrokenEdges.has(e.id);
                  const isForBroken = forBrokenEdges.has(e.id);
                  const isSel = sel?.type === 'edge' && sel.id === e.id;
                  if (e.src === e.tgt) {
                    const ss = getNodeSize(s);
                    const cx = s.x + ss.w / 2, cy = s.y + ss.h / 2;
                    const pathD = `M${s.x+ss.w},${cy} C${cx+ss.w*0.8},${s.y-ss.h*0.4} ${cx+ss.w*0.8},${s.y-ss.h*0.4} ${cx},${s.y}`;
                    return (
                      <g key={e.id}>
                        <path d={pathD} fill="none" stroke="transparent" strokeWidth={12} style={{cursor:'pointer',pointerEvents:'stroke'}} onClick={(ev) => { ev.stopPropagation(); setSel({ type: 'edge', id: e.id }); }} />
                        <path d={pathD} fill="none" stroke={isSel?'#3d5cf5':'#4f6ef7'} strokeWidth={isSel?2.5:1.5} strokeDasharray="5,3" markerEnd={`url(#${isSel?'as':'a_for'})`} style={{pointerEvents:'none'}} />
                      </g>
                    );
                  }
                  const { pathDs, labelPos, srcDir, tgtDir } = computeEdgeGeometry(e, s, t, isCycleEdge, allCycleEdges, portEdgeGroupMap);
                  const stroke = isSel ? '#3d5cf5' : isParBroken || isForBroken ? '#ef4444' : isCycleEdge || isParCycle ? '#4f6ef7' : '#94a3b8';
                  const dashed = isParBroken || isForBroken ? '5,3' : isCycleEdge ? '7,3' : null;
                  const markerId = isSel ? 'as' : isParBroken || isForBroken ? 'al' : isCycleEdge ? 'a_for' : 'a';
                  return (
                    <g key={e.id}>
                      {pathDs.map((d, i) => (
                        <path key={i} d={d} fill="none" stroke="transparent" strokeWidth={12} style={{cursor:'pointer',pointerEvents:'stroke'}} onClick={(ev) => { ev.stopPropagation(); setSel({ type: 'edge', id: e.id }); }} />
                      ))}
                      {pathDs.map((d, i) => (
                        <path key={`v${i}`} d={d} fill="none" stroke={stroke} strokeWidth={isSel?2.5:1.5} strokeDasharray={dashed} markerEnd={i===pathDs.length-1?`url(#${markerId})`:undefined} style={{pointerEvents:'none'}} />
                      ))}
                      {e.cond && labelPos && (
                        <g>
                          <rect x={labelPos.x-22} y={labelPos.y-8} width={44} height={16} rx={4} fill="white" stroke={stroke} strokeWidth={1} />
                          <text x={labelPos.x} y={labelPos.y+4} textAnchor="middle" fontSize={9} fill={stroke} fontFamily="JetBrains Mono,monospace" fontWeight={700}>{e.cond.length>8?e.cond.slice(0,7)+'…':e.cond}</text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {conn && (() => { const d = getTempConnLine(); return d ? <path d={d} fill="none" stroke="#3d5cf5" strokeWidth={2} strokeDasharray="6,3" style={{pointerEvents:'none'}} /> : null; })()}
              </svg>
              {nodes.map((n) => {
                const enrichedNode = n.type === 'action' ? { ...n, action: actionMap.get(n.actionId) } : n;
                const commonProps = {
                  sel: sel?.type === 'node' && sel.id === enrichedNode.id,
                  onBody: (e) => {
                    e.stopPropagation();
                    if (drag || isPanning || conn) { setDrag(null); setIsPanning(false); setConn(null); return; }
                    setSel({ type: 'node', id: enrichedNode.id });
                    setDrag({ id: enrichedNode.id, sx: e.clientX, sy: e.clientY, ox: enrichedNode.x, oy: enrichedNode.y });
                  },
                  onPortDown: (e, dir) => handlePortDown(e, enrichedNode.id, dir),
                  onPortUp: (e, dir) => handlePortUp(e, enrichedNode.id, dir),
                  onBodyMouseUp: (e) => handleBodyMouseUp(e, enrichedNode.id),
                };
                if (enrichedNode.type === 'special') return <SpecialNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} isActive={activeNodeIds.has(enrichedNode.id)} />;
                if (enrichedNode.type === 'for_out') {
                  const motherNode = enrichedNode.forNodeId ? nm.get(enrichedNode.forNodeId) : null;
                  return <ForOutNodeView key={enrichedNode.id} node={enrichedNode} sel={sel?.type==='node'&&sel.id===enrichedNode.id} forSpecialType={motherNode?.specialType||'FOR'} onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)} onBubbleClick={(nid) => { setDrag(null); setConn(null); setIsPanning(false); setSel({ type: 'node', id: nid }); }} onPortDown={(e, dir, x, y) => handlePortDown(e, enrichedNode.id, dir, x, y)} onPortUp={(e, dir) => handlePortUp(e, enrichedNode.id, dir)} />;
                }
                if (enrichedNode.type === 'par_out') return <ParOutNodeView key={enrichedNode.id} node={enrichedNode} sel={sel?.type==='node'&&sel.id===enrichedNode.id} onBody={(e) => { e.stopPropagation(); if (drag||isPanning||conn){setDrag(null);setIsPanning(false);setConn(null);return;} setSel({type:'node',id:enrichedNode.id}); setDrag({id:enrichedNode.id,sx:e.clientX,sy:e.clientY,ox:enrichedNode.x,oy:enrichedNode.y}); }} onPortDown={(e, dir) => handlePortDown(e, enrichedNode.id, dir)} onPortUp={(e, dir) => handlePortUp(e, enrichedNode.id, dir)} onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)} />;
                if (enrichedNode.type === 'position') return <PositionNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} />;
                return <ActionNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} onBubbleClick={handleBubbleClick} nodeState={nodeStates[enrichedNode.id]} isActive={activeNodeIds.has(enrichedNode.id)} errorNodeIds={errorNodeIds} onDbl={() => { if (enrichedNode.type==='action'&&enrichedNode.action) setModal({type:'editNode',action:enrichedNode.action,nodeId:enrichedNode.id}); else if (enrichedNode.type==='module') { const mod=enrichedNode.modDef; if(mod) editModule(mod); } }} />;
              })}
            </>
          }
          lib={lib}
          mode={mode}
          locationPath={locationPath}
          allNames={allNames}
          onNew={() => setModal({ type: 'new' })}
          onAdd={addNode}
          onAddModule={addModuleNode}
          onAddSpecial={addSpecialNode}
          onAddPosition={addPositionNode}
          onEdit={(a) => setModal({ type: 'edit', action: a })}
          onEditModule={editModule}
          onDragStart={handleLibDragStart}
          onSelectLib={handleSelectLib}
          onNewModule={(name) => {
            const newPath = [...locationPath, name];
            const newModule = { id: mid(), name, path: newPath, meta: {}, code: [], vars: [], nodes: makeDefaultNodes('module'), edges: [] };
            saveCurrentFlow();
            setModuleStore((prev) => [...prev, newModule]);
            setFlowStore((prev) => [...prev, { path: newPath, nodes: newModule.nodes, edges: newModule.edges }]);
            setLocationPath(newPath);
            setNodes(newModule.nodes);
            setEdges(newModule.edges);
            setFemDirty(false);
          }}
          libSel={libSel}
          flowStatus={flowStatus}
          hasActiveRunningNodes={hasActiveRunningNodes}
          onRun={handleRunWorkflow}
          onPause={handlePauseWorkflow}
          onResume={handleResumeWorkflow}
          nodeStates={nodeStates}
          actionStore={actionStore}
          activeNodeIds={activeNodeIds}
          errorNodeIds={errorNodeIds}
          bubbleOverlay={bubbleOverlay}
          onBubbleClose={handleBubbleClose}
          submitHumanInput={submitHumanInput}
          femText={femText}
          onFemChange={(v) => { setFemText(v); setFemDirty(true); }}
          femError={femError}
          femDirty={femDirty}
          onApplyFem={handleApplyFem}
          onRestoreFem={handleRestoreFem}
          onGraphToFem={handleGraphToFem}
onOpenApiKey={() => { 
  setApiKeyInput(userApiKey); 
  setApiProviderSelect(userApiProvider); 
  setApiModelInput(userApiModel); 
  setApiKeyModalOpen(true); 
}}
          onOpenSoul={() => { setSoulForm({ soul_id: '', soul_name: '', description: '', user_id: '', password: '' }); setSoulFormError(''); setSoulModalOpen(true); }}
          backEdges={backEdges}
          onDeleteNode={handleDeleteSelNode}
          onDeleteEdge={handleDeleteSelEdge}
          onCondChange={handleCondChange}
          onEditAction={handleEditSelAction}
        />
        {/* ActionModal、ApiKeyModal、SoulModal 在手机端也需要 */}
        {modal && (
          <ActionModal
            init={modal.type !== 'new' ? modal.action : null}
            existingNames={[...allNames]}
            isModuleInternal={mode === 'module'}
            onSave={(action) => {
              const actionWithPath = { ...action, path: action.path || [...locationPath] };
              if (modal.type === 'editNode') {
                setNodes((p) => p.map((n) => n.id === modal.nodeId ? { ...n, label: `[${actionWithPath.name}]` } : n));
              } else if (modal.type === 'edit') {
                setNodes((p) => p.map((n) => n.actionId === actionWithPath.id ? { ...n, label: `[${actionWithPath.name}]` } : n));
              } else {
                addNode(actionWithPath);
              }
              setActionStore((prev) => {
                const idx = prev.findIndex((a) => a.id === actionWithPath.id);
                if (idx >= 0) { const updated = [...prev]; updated[idx] = actionWithPath; return updated; }
                return [...prev, actionWithPath];
              });
              setModal(null);
            }}
            onClose={() => setModal(null)}
          />
        )}
        <ApiKeyModal
          open={apiKeyModalOpen}
          apiKeyInput={apiKeyInput}
          setApiKeyInput={setApiKeyInput}
          apiProviderSelect={apiProviderSelect}
          setApiProviderSelect={setApiProviderSelect}
          apiUrlInput={apiUrlInput}
          setApiUrlInput={setApiUrlInput}
          apiModelInput={apiModelInput}
          setApiModelInput={setApiModelInput}
          rememberKey={rememberKey}
          setRememberKey={setRememberKey}
          userApiKey={userApiKey}
          onSave={handleSaveApiKey}
          onClear={handleClearApiKey}
          onClose={() => setApiKeyModalOpen(false)}
        />
        <SoulModal
          open={soulModalOpen}
          onClose={() => setSoulModalOpen(false)}
          onCreated={() => setSoulModalOpen(false)}
        />
      </ErrorBoundary>
    );
  }

  // ══════════════════════════════════════════
  // 桌面端原有渲染（保持完全不变）
  // ══════════════════════════════════════════
  return (
    <ErrorBoundary>
      <FontStyle scoped={plugin} />
      <div
        style={{
          display: 'flex',
          // 插件模式整体缩放锁定 75%（zoom 连布局尺寸一起缩；
          // 弹窗 fixed 相对本容器定位，inset:0 跟随缩放）。
          width: '100%',
          height: plugin ? '100%' : '100vh',
          zoom: plugin ? 0.75 : 1,
          background: '#edf1f8',
          fontFamily: 'DM Sans, sans-serif',
          overflow: 'hidden',
        }}
      >
        {/* ── LEFT SIDEBAR（258 → 232 = 缩窄 10%）── */}
        <div
          style={{
            width: 232,
            background: 'white',
            borderRight: '1px solid #e4ecf7',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            zIndex: 10,
          }}
        >
          <div
            style={{
              padding: '16px 16px 13px',
              borderBottom: '1px solid #e4ecf7',
            }}
          >
            <div
              style={{
                fontWeight: 900,
                fontSize: 18,
                color: '#1b2540',
                letterSpacing: '-0.03em',
              }}
            >
              <span style={{ color: '#3d5cf5' }}>FEM</span> WAutomata
            </div>
            <div
              style={{
                fontSize: 10.5,
                color: '#9aaccb',
                marginTop: 2,
                letterSpacing: '0.01em',
              }}
            >
              Flow Engine for Minds - Work Automata
            </div>
          </div>

          <div style={{ display: 'flex', borderBottom: '1px solid #e4ecf7' }}>
            {[
              ['library', '组件库'],
              ['project', '项目设置'],
            ].map(([k, v]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  flex: 1,
                  padding: '9px 0',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: tab === k ? '#3d5cf5' : '#9aaccb',
                  borderBottom: `2.5px solid ${
                    tab === k ? '#3d5cf5' : 'transparent'
                  }`,
                  fontFamily: 'DM Sans, sans-serif',
                  transition: 'all 0.12s',
                }}
              >
                {v}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '13px 13px' }}>
            {tab === 'library' ? (
              <LibPanel
                lib={lib}
                mode={mode}
                locationPath={locationPath}
                allNames={allNames}
                onNew={() => setModal({ type: 'new' })}
                onNewModule={(name) => {
                  const newPath = [...locationPath, name];
                  const newModule = {
                    id: mid(),
                    name,
                    path: newPath,
                    meta: {},
                    code: [],
                    vars: [],
                    nodes: makeDefaultNodes('module'),
                    edges: [],
                  };
                  // 保存当前画布到 flowStore
                  saveCurrentFlow();
                  // 添加新模块到 moduleStore
                  setModuleStore((prev) => [...prev, newModule]);
                  // 将新模块的默认 flow 加入 flowStore
                  setFlowStore((prev) => [
                    ...prev,
                    {
                      path: newPath,
                      nodes: newModule.nodes,
                      edges: newModule.edges,
                    },
                  ]);
                  // 切换路径
                  setLocationPath(newPath);
                  setNodes(newModule.nodes);
                  setEdges(newModule.edges);
                  setFemDirty(false);
                  // 注意：autoFem 会自动更新，无需手动 setFemText
                }}
                onSelectLib={handleSelectLib}
                onAdd={addNode}
                onAddModule={addModuleNode}
                onAddSpecial={addSpecialNode}
                onAddPosition={addPositionNode}
                onEdit={(a) => setModal({ type: 'edit', action: a })}
                onEditModule={editModule}
                onDragStart={handleLibDragStart}
              />
              ) : mode === 'module' ? (
              (() => {
                const currentMod = moduleStore.find(
                  (m) =>
                    m.path.length === locationPath.length &&
                    m.path.every((s, i) => s === locationPath[i])
                );
                if (!currentMod) return <div style={{ color: '#c4d0e0', fontSize: 12 }}>未找到模块</div>;
                const modAsProj = {
                  ...currentMod.meta,
                  name: currentMod.name,
                  vars: currentMod.vars || [],
                  code: currentMod.code || [],
                  actors: [],
                };
                return (
                  <ProjPanel
                    proj={modAsProj}
                    actorNames={[]}
                    onChange={(newData) => {
                      const { name, vars, code, actors, ...meta } = newData;
                      setModuleStore((prev) =>
                        prev.map((m) =>
                          m.path.length === locationPath.length &&
                          m.path.every((s, i) => s === locationPath[i])
                            ? { ...m, name: name || m.name, meta, vars: vars || [], code: code || [] }
                            : m
                        )
                      );
                    }}
                  />
                );
              })()
            ) : (
              <ProjPanel
                proj={proj}
                actorNames={(proj.actors || []).map((a) =>
                  a.name.replace('@', '')
                )}
                onChange={setProj}
              />
            )}
          </div>

          {/* ── 底部工具栏 ── */}
          <div style={{
            borderTop: '1px solid #e4ecf7',
            padding: '10px 13px',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}>
            {/* 插件模式：key 走 dsh credentials、后端就是插件自身，两个按钮无意义 */}
            {!plugin && (
            <button
            onClick={() => { 
   setApiKeyInput(userApiKey); 
   setApiProviderSelect(userApiProvider); 
   setApiModelInput(userApiModel); 
   setApiKeyModalOpen(true);
 }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '6px 8px', borderRadius: 7,
                fontSize: 11, fontWeight: 600,
                fontFamily: 'DM Sans, sans-serif',
                cursor: 'pointer', transition: 'all 0.12s',
                border: '1px solid',
                background: userApiKey ? '#f0fdf4' : '#fef2f2',
                borderColor: userApiKey ? '#bbf7d0' : '#fecaca',
                color: userApiKey ? '#15803d' : '#b91c1c',
                flex: 1,
              }}
            >
              {userApiKey ? 'Key已设置' : 'API Key'}
            </button>
            )}
            {!plugin && (
            <button
              onClick={() => setBackendModalOpen(true)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '6px 8px', borderRadius: 7,
                fontSize: 11, fontWeight: 600,
                fontFamily: 'DM Sans, sans-serif',
                cursor: 'pointer', transition: 'all 0.12s',
                border: '1px solid',
                background: backendConnected === true ? '#f0fdf4' : backendConnected === false ? '#fef2f2' : '#f8fafc',
                borderColor: backendConnected === true ? '#bbf7d0' : backendConnected === false ? '#fecaca' : '#dde4ef',
                color: backendConnected === true ? '#15803d' : backendConnected === false ? '#b91c1c' : '#5a6a8a',
                flex: 1,
              }}
            >
              {backendConnected === true ? '后端健康' : '连接后端'}
            </button>
            )}
            <button
              onClick={() => { setSoulForm({ soul_id: '', soul_name: '', description: '', user_id: '', password: '' }); setSoulFormError(''); setSoulModalOpen(true); }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '6px 8px', borderRadius: 7,
                fontSize: 11, fontWeight: 600,
                fontFamily: 'DM Sans, sans-serif',
                cursor: 'pointer', transition: 'all 0.12s',
                border: '1px solid #dde4ef',
                background: '#f8fafc',
                color: '#5a6a8a',
                flex: 1,
              }}
            >
              新建SOUL
            </button>
          </div>
        </div>

        {/* ── CENTER ── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}
        >
          {/* Toolbar */}
          <div
            style={{
              height: 50,
              background: 'white',
              borderBottom: '1px solid #e4ecf7',
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11.5, color: '#7a8aaa', fontWeight: 600 }}>
              位置
            </span>
            <button
              onClick={() => {
                if (
                  locationPath.length !== 1 ||
                  locationPath[0] !== 'mainflow'
                ) {
                  saveCurrentFlow();
                  setLocationPath(['mainflow']);
                }
              }}
              disabled={
                locationPath.length === 1 && locationPath[0] === 'mainflow'
              }
              style={{
                padding: '4px 13px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: 'DM Sans, sans-serif',
                border: `1.5px solid ${
                  mode === 'mainflow' ? '#3d5cf5' : '#dde4ef'
                }`,
                background: mode === 'mainflow' ? '#eff2ff' : 'white',
                color: mode === 'mainflow' ? '#3d5cf5' : '#7a8aaa',
                opacity: mode === 'mainflow' ? 0.7 : 1,
              }}
            >
              主流程
            </button>
            {locationPath.map((seg, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 && (
                  <span
                    style={{ color: '#b0bad0', fontSize: 12, fontWeight: 600 }}
                  >
                    &gt;
                  </span>
                )}
                {idx === 0 ? null : (
                  <button
                    onClick={() => {
                      saveCurrentFlow();
                      const newPath = locationPath.slice(0, idx + 1);
                      setLocationPath(newPath);
                    }}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 700,
                      border: `1.5px solid #dde4ef`,
                      background: 'white',
                      color: '#7a8aaa',
                    }}
                  >
                    {seg}
                  </button>
                )}
              </React.Fragment>
            ))}
            {mode === 'module' && (
              <button
                onClick={() => {
                  saveCurrentFlow();
                  const newPath = locationPath.slice(0, -1);
                  setLocationPath(newPath);
                }}
                style={{
                  padding: '4px 12px',
                  fontSize: 11,
                  background: '#dde4ef',
                  border: 'none',
                  borderRadius: 7,
                  cursor: 'pointer',
                }}
              >
                返回上级
              </button>
            )}{' '}
            <div style={{ flex: 1 }} />
            <input
              ref={fileInputRef}
              type="file"
              accept=".fems"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ ...btnS, fontSize: 12, padding: '5px 14px' }}
            >
              导入 .fems
            </button>
            <button
              onClick={() => {
                console.log('[导出 .fems] 开始即时生成');
                const exportText = handleGraphToFem();
                console.log('[导出 .fems] 生成完成, 长度:', exportText.length);
                const blob = new Blob([exportText], {
                  type: 'text/plain',
                });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${proj.name || 'flow'}.fems`;
                a.click();
                console.log('[导出 .fems] 下载已触发');
              }}
              style={{ ...btnS, fontSize: 12, padding: '5px 14px' }}
            >
              导出 .fems
            </button>
            {flowStatus === 'idle' ? (
              <button
                onClick={handleRunWorkflow}
                style={{
                  ...btnS,
                  fontSize: 12,
                  padding: '5px 14px',
                  background: '#22c55e',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                ▶ 运行
              </button>
            ) : (flowStatus === 'running' && !hasActiveRunningNodes) || flowStatus === 'paused' ? (
              <button
                onClick={handleResumeWorkflow}
                style={{
                  ...btnS,
                  fontSize: 12,
                  padding: '5px 14px',
                  background: '#3d5cf5',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                ▶ 继续
              </button>
            ) : flowStatus === 'running' ? (
              <button
                onClick={handlePauseWorkflow}
                style={{
                  ...btnS,
                  fontSize: 12,
                  padding: '5px 14px',
                  background: '#f59e0b',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                ⏸️ 暂停
              </button>
            ) : null}
          </div>

          {/* Canvas */}
          <div
            ref={cvRef}
            style={{
              flex: 1,
              position: 'relative',
              overflow: 'hidden',

              overscrollBehaviorX: 'contain',
              overscrollBehaviorY: 'contain', /*禁止浏览器返回手势的冲突*/

              backgroundImage:
                'radial-gradient(circle, #bfcde2 1.2px, transparent 1.2px)',
              backgroundSize: '22px 22px',
              cursor: isPanning
                ? 'grabbing'
                : conn
                ? 'crosshair'
                : 'default',
            }}
            onMouseMove={onMM}
            onMouseUp={onMU}
            onMouseDown={onCanvasDown}
            onWheel={handleWheel}

            onMouseLeave={() => {
              setDrag(null);
              setConn(null);
              setIsPanning(false);
              isDraggingRef.current = false;
              isMouseDownRef.current = false;
            }}

            onDragOver={handleCanvasDragOver}
            onDrop={handleCanvasDrop}
          >
            {/* ★ 淡入动效容器 */}
            <div
              data-canvas-bg="true"
              style={{
                opacity: canvasOpacity,
                transition: 'opacity 0.2s ease',
                position: 'absolute',
                inset: 0,
              }}
            >
              {/* Transform wrapper for panning */}
              <div
                data-canvas-bg="true"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                  transformOrigin: '0 0',
                  position: 'absolute',
                  inset: 0,
                }}
              >
              {/* SVG layer */}
<svg
  style={{
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    overflow: 'visible',
    zIndex: 24,
  }}
>
                <defs>
                  {[
                    ['a', '#94a3b8'],
                    ['as', '#3d5cf5'],
                    ['a_for', '#4f6ef7'],
                    ['al', '#ef4444'],
                    ['aj', '#f59e0b'],
                  ].map(([id, col]) => (
                    <marker
                      key={id}
                      id={id}
                      markerWidth="8"
                      markerHeight="6"
                      refX="7"
                      refY="3"
                      orient="auto"
                    >
                      <polygon points="0 0, 8 3, 0 6" fill={col} />
                    </marker>
                  ))}
                </defs>

                {sortedEdges.map((e) => {
                  const s = nm.get(e.src),
                    t = nm.get(e.tgt);
                  if (!s || !t) return null;

                  const isBack = backEdges.has(e.id);
                  const isCycleEdge = allCycleEdges.has(e.id);
                  
                  // 自环边特殊处理（不走 computeEdgeGeometry）
                  if (e.src === e.tgt) {
                    const ss = getNodeSize(s);
                    const cx = s.x + ss.w / 2;
                    const cy = s.y + ss.h / 2;
                    const startX = s.x + ss.w;
                    const startY = cy;
                    const endX = cx;
                    const endY = s.y;
                    const midX = cx + ss.w * 0.8;
                    const midY = s.y - ss.h * 0.4;
                    const pathD = `M${startX},${startY} C${midX},${midY} ${midX},${midY} ${endX},${endY}`;
                    const isSel = sel?.type === 'edge' && sel.id === e.id;
                    console.log('[SVG self-loop] edge.id=', e.id, 'pathD=', pathD);
                    return (
                      <g key={e.id}>
                        <path
                          d={pathD}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={12}
                          style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                          onMouseDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setSel({ type: 'edge', id: e.id });
                          }}
                        />
                        <path
                          d={pathD}
                          fill="none"
                          stroke={isSel ? '#3d5cf5' : '#4f6ef7'}
                          strokeWidth={isSel ? 2.5 : 2}
                          markerEnd="url(#a)"
                        />
                      </g>
                    );
                  }

                  // ── PAR 边判断 ──
                  const isParCycle = parCycleEdges.has(e.id);
                  const isParBroken = parBrokenEdges.has(e.id);
                  const isParEdge = isParCycle || isParBroken;

                  // ── 统一几何计算 ──
                  const geo = computeEdgeGeometry(e, s, t, {
                    isCycleEdge,
                    isParEdge,
                    parLineCount: 5,
                    parGap: 6,
                    portEdgeGroupMap,
                  });
                  if (!geo) return null;

                  // console.log('[SVG edge]', e.id, 'cond=', e.cond, 'isBack=', isBack,
                  //  'labelPos=', geo.labelPos, 'srcDir=', geo.srcDir, 'tgtDir=', geo.tgtDir,
                  //   'pathDs count=', geo.pathDs.length, 'midIdx=', geo.midIdx);

                  // ── 颜色与样式 ──
                  const isSel = sel?.type === 'edge' && sel.id === e.id;
                  const isForBroken = forBrokenEdges.has(e.id) && !isCycleEdge;
                  const isForOutEdge = nodes.some(n => (n.type === 'for_out' || n.type === 'par_out') && (n.id === e.src || n.id === e.tgt));
                  const isForBrokenFinal = isForBroken && !isForOutEdge;

                  const col = isParBroken ? '#ef4444' :
                              isParCycle ? '#4f6ef7' :
                              isForOutEdge ? '#4f6ef7' :
                              isCycleEdge ? '#4f6ef7' :
                              isForBrokenFinal ? '#ef4444' :
                              isSel ? '#3d5cf5' :
                              '#94a3b8';
                  const mkr = isParBroken ? 'al' :
                              isParCycle ? 'a_for' :
                              isForBrokenFinal ? 'al' :
                              isSel ? 'as' :
                              (isForOutEdge || isCycleEdge) ? 'a_for' :
                              'a';
                  const dashArray = (isParBroken || isForBrokenFinal) ? '5,3' : 'none';

                  return (
                    <g key={e.id}>
                      {/* 透明点击区域：使用中间那条线 */}
                      <path
                        d={geo.pathDs[geo.midIdx]}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={isParEdge ? 18 : 12}
                        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSel({ type: 'edge', id: e.id });
                        }}
                      />
                      {/* 可见线条：多条平行 */}
                      {geo.pathDs.map((pathD, i) => (
                        <path
                          key={i}
                          d={pathD}
                          fill="none"
                          stroke={col}
                          strokeWidth={isSel ? 2.5 : 1.8}
                          strokeDasharray={dashArray}
                          markerEnd={`url(#${mkr})`}
                          style={{ pointerEvents: 'none' }}
                        />
                      ))}
                      {/* 条件标签：所有边都显示（包括回边），无白色背景框，用贝塞尔中点 */}
                      {e.cond && (
                        <text
                          x={geo.labelPos.x}
                          y={geo.labelPos.y + 4.5}
                          textAnchor="middle"
                          fontSize={9.5}
                          fontWeight={700}
                          fill={col}
                          fontFamily="JetBrains Mono, monospace"
                          style={{ pointerEvents: 'none' }}
                        >
                          {e.cond}
                        </text>
                      )}
                      {/* 源点圆点：多边同源时显示 */}
                      {!isBack &&
                        edges.filter((x) => x.src === e.src).length > 1 && (() => {
                          const sp = geo.srcPorts[geo.midIdx];
                          return sp ? (
                            <circle
                              cx={sp.x}
                              cy={sp.y}
                              r={4}
                              fill="#3d5cf5"
                              style={{ pointerEvents: 'none' }}
                            />
                          ) : null;
                        })()}
                    </g>
                  );
                })}

                {/* Temp connecting line */}
                {conn &&
                  (() => {
                    const pathD = getTempConnLine();
                    return pathD ? (
                      <path
                        d={pathD}
                        fill="none"
                        stroke="#3d5cf5"
                        strokeWidth={2}
                        strokeDasharray="6,3"
                        style={{ pointerEvents: 'none' }}
                      />
                    ) : null;
                  })()}
              </svg>

              {/* Nodes */}
              {nodes.map((n) => {
                const enrichedNode = n.type === 'action'
                  ? { ...n, action: actionMap.get(n.actionId) }
                  : n;
                const commonProps = {
                  sel: sel?.type === 'node' && sel.id === enrichedNode.id,
                  onBody: (e) => {
                    e.stopPropagation();
                    // 如果鼠标上正粘着拖拽/连线/平移状态，单击任意节点直接清除
                    if (drag || isPanning || conn) {
                      setDrag(null);
                      setIsPanning(false);
                      setConn(null);
                      return;
                    }
                    setSel({ type: 'node', id: enrichedNode.id });
                    setDrag({
                      id: enrichedNode.id,
                      sx: e.clientX,
                      sy: e.clientY,
                      ox: enrichedNode.x,
                      oy: enrichedNode.y,
                    });
                  },
                  onPortDown: (e, dir) => handlePortDown(e, enrichedNode.id, dir),
                  onPortUp: (e, dir) => handlePortUp(e, enrichedNode.id, dir),
                  onBodyMouseUp: (e) => handleBodyMouseUp(e, enrichedNode.id),
                };

                if (enrichedNode.type === 'special') {
                  return (
                    <SpecialNodeView
                      key={enrichedNode.id}
                      node={enrichedNode}
                      {...commonProps}
                      isActive={activeNodeIds.has(enrichedNode.id)}
                    />
                  );
                }
// --- 原有 for_out 逻辑 ---
if (enrichedNode.type === 'for_out') {
  const isSel = sel?.type === 'node' && sel.id === enrichedNode.id;
  const motherNode = enrichedNode.forNodeId ? nm.get(enrichedNode.forNodeId) : null;
  return (
    <ForOutNodeView
      key={enrichedNode.id}
      node={enrichedNode}
      sel={isSel}
      forSpecialType={motherNode?.specialType || 'FOR'}
      onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)}
      onBubbleClick={(nodeId) => {
        setDrag(null);
        setConn(null);
        setIsPanning(false);
        setSel({ type: 'node', id: nodeId });
      }}
      onPortDown={(e, dir, x, y) => handlePortDown(e, enrichedNode.id, dir, x, y)}
      onPortUp={(e, dir, x, y) => handlePortUp(e, enrichedNode.id, dir)}
    />
  );
}

// --- 新增 par_out 逻辑 ---
if (enrichedNode.type === 'par_out') {
  const isSel = sel?.type === 'node' && sel.id === enrichedNode.id;
  return (
    <ParOutNodeView
      key={enrichedNode.id}
      node={enrichedNode}
      sel={isSel}
      onBody={(e) => {
        e.stopPropagation();
        if (drag || isPanning || conn) {
          setDrag(null); setIsPanning(false); setConn(null);
          return;
        }
        setSel({ type: 'node', id: enrichedNode.id });
        setDrag({ id: enrichedNode.id, sx: e.clientX, sy: e.clientY, ox: enrichedNode.x, oy: enrichedNode.y });
      }}
      onPortDown={(e, dir) => handlePortDown(e, enrichedNode.id, dir)}
      onPortUp={(e, dir) => handlePortUp(e, enrichedNode.id, dir)}
      onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)}
    />
  );
}
                if (enrichedNode.type === 'position') {
                  return (
                    <PositionNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} />
                  );
                }
                return (
                  <ActionNodeView
                    key={enrichedNode.id}
                    node={enrichedNode}
                    {...commonProps}
                    onBubbleClick={handleBubbleClick}
                    nodeState={nodeStates[enrichedNode.id]}
                    isActive={activeNodeIds.has(enrichedNode.id)}
                    errorNodeIds={errorNodeIds}
                    onDbl={() => {
                      if (enrichedNode.type === 'action' && enrichedNode.action) {
                        setModal({
                          type: 'editNode',
                          action: enrichedNode.action,
                          nodeId: enrichedNode.id,
                        });
                      } else if (enrichedNode.type === 'module') {
                        const mod = enrichedNode.modDef;
                        if (mod) editModule(mod);
                      }
                    }}
                  />
                );
              })}

              {/* Empty state hint */}
              {nodes.filter((n) => n.type !== 'special').length === 0 &&
                !conn && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        color: '#94a3b8',
                        fontWeight: 600,
                      }}
                    >
                      从组件库添加 Action 到画布
                    </div>
                    <div
                      style={{ fontSize: 11.5, color: '#c4d0e0', marginTop: 6 }}
                    >
                      点击节点端口连线 · 双击编辑 · Space+拖动平移画布 · Del
                      删除 · 拖拽组件到画布
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div
          style={{
            width: rightPanelWidth,
            background: 'white',
            borderLeft: '1px solid #e4ecf7',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            position: 'relative',
          }}
        >
          {/* 拖拽手柄 */}
          <div
            onMouseDown={() => setIsResizingRight(true)}
            style={{
              position: 'absolute',
              left: -4,
              top: 0,
              bottom: 0,
              width: 8,
              cursor: 'col-resize',
              zIndex: 20,
            }}
          />
          <div
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid #e4ecf7',
              minHeight: 160,
            }}
          >
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 800,
                color: '#9aaccb',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 13,
              }}
            >
              {selNode ? '节点属性' : selEdge ? '连线属性' : '属性面板'}
            </div>

            {selNode ? (
              <>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: '#1b2540',
                    marginBottom: 10,
                  }}
                >
                  {selNode.label}
                </div>
                {selNode.type === 'special' ? (
                  <>
                    <PR k="类型" v={selNode.specialType} />
                    <PR k="类别" v="特殊节点" />
                    {(selNode.specialType === 'FOR' || selNode.specialType === 'PAR') && (
                      <Field label="变化元素" hint={selNode.specialType === 'PAR' ? '并行遍历列表' : '列表全部循环一遍后走出口'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 12.5, color: '#5a6a8a', fontWeight: 600 }}>
                            {selNode.specialType === 'PAR' ? 'par' : 'for'}
                          </span>
                          <input
                            value={selNode.forCondition || ''}
                            onChange={(e) =>
                              setNodes((p) =>
                                p.map((n) =>
                                  n.id === selNode.id
                                    ? { ...n, forCondition: e.target.value }
                                    : n
                                )
                              )
                            }
                            placeholder={selNode.specialType === 'PAR' ? '@coder in coders' : '@wolf in allWolves'}
                            style={{ ...inp, flex: 1 }}
                          />
                        </div>
                      </Field>
                    )}
                    {(selNode.specialType === 'START' ||
                      selNode.specialType === 'IN') && (
                      <div
                        style={{
                          margin: '8px 0',
                          padding: '5px 8px',
                          background: '#ecfdf5',
                          borderRadius: 6,
                          fontSize: 11,
                          color: '#10b981',
                          fontWeight: 700,
                        }}
                      >
                        入口节点（唯一）
                      </div>
                    )}
                    {SINK_ONLY.has(selNode.specialType) && (
                      <div
                        style={{
                          margin: '8px 0',
                          padding: '5px 8px',
                          background: '#fef2f2',
                          borderRadius: 6,
                          fontSize: 11,
                          color: '#ef4444',
                          fontWeight: 700,
                        }}
                      >
                        终端节点（仅入）
                      </div>
                    )}
                  </>
                ) : selNode.type === 'position' ? (
                  <>
                    <PR k="类别" v="空节点 (POSITION)" />
                    <div
                      style={{
                        margin: '8px 0',
                        padding: '5px 8px',
                        background: '#f8fafc',
                        borderRadius: 6,
                        fontSize: 11,
                        color: '#94a3b8',
                        fontWeight: 700,
                      }}
                    >
                      仅占位，无内容
                    </div>
                  </>
                ) : (
                  <>
                    {selNode.action ? (
                      <>
                        <PR k="名称" v={selNode.action.name || '?'} />
                        <PR
                          k="类型"
                          v={`@${selNode.action.executorType || 'ai'}`}
                        />
                        {selNode.action.executorActor && (
                          <PR k="执行者" v={selNode.action.executorActor} />
                        )}
                        {selNode.action.scope && (
                          <PR k="Scope" v={selNode.action.scope} />
                        )}
                        {selNode.action.outVars && (
                          <PR k="out" v={selNode.action.outVars} />
                        )}
                      </>
                    ) : null}
                    {selNode.type === 'module' && (
                      <PR k="引用" v={`&${selNode.modRef}`} />
                    )}
                  </>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  {selNode.type === 'action' && selNode.action && (
                    <button
                      onClick={() =>
                        setModal({
                          type: 'editNode',
                          action: selNode.action,
                          nodeId: selNode.id,
                        })
                      }
                      style={{
                        ...btnS,
                        flex: 1,
                        padding: '5px 0',
                        fontSize: 11.5,
                      }}
                    >
                      编辑
                    </button>
                  )}
                  {!(
                    selNode.type === 'special' &&
                    (selNode.specialType === 'START' ||
                      selNode.specialType === 'IN')
                  ) && (
                    <button
                      onClick={() => {
                        if (
                          selNode.type === 'special' &&
                          (selNode.specialType === 'END' ||
                            selNode.specialType === 'OUT')
                        ) {
                          const sameType = nodes.filter(
                            (n) =>
                              n.type === 'special' &&
                              n.specialType === selNode.specialType
                          );
                          if (sameType.length <= 1) return;
                        }
                        deleteNode(selNode.id);
                      }}
                      style={{
                        ...btnS,
                        flex: 1,
                        padding: '5px 0',
                        fontSize: 11.5,
                        color:
                          selNode.type === 'special' &&
                          (selNode.specialType === 'START' ||
                            selNode.specialType === 'IN')
                            ? '#c4d0e0'
                            : '#ef4444',
                        borderColor:
                          selNode.type === 'special' &&
                          (selNode.specialType === 'START' ||
                            selNode.specialType === 'IN')
                            ? '#e4ecf7'
                            : '#fecaca',
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              </>
            ) : selEdge ? (
              <>
                <PR k="来源" v={nm.get(selEdge.src)?.label || '?'} />
                <PR k="目标" v={nm.get(selEdge.tgt)?.label || '?'} />
                {backEdges.has(selEdge.id) && (
                  <div
                    style={{
                      margin: '8px 0',
                      padding: '5px 8px',
                      background: '#fff0f0',
                      borderRadius: 6,
                      fontSize: 11,
                      color: '#ef4444',
                      fontWeight: 700,
                    }}
                  >
                    回环检测 -- while 循环
                  </div>
                )}
                {(() => {
                  const inEdges = edges.filter(
                    (e) => e.tgt === selEdge.tgt && !backEdges.has(e.id)
                  );
                  if (inEdges.length > 1) {
                    return (
                      <div
                        style={{
                          margin: '8px 0',
                          padding: '5px 8px',
                          background: '#fffbeb',
                          borderRadius: 6,
                          fontSize: 11,
                          color: '#f59e0b',
                          fontWeight: 700,
                        }}
                      >
                        Join 节点 ({inEdges.length} 入口)
                      </div>
                    );
                  }
                  return null;
                })()}
                <Field label="if 条件" hint="如 game_over == false">
                  <input
                    value={selEdge.cond || ''}
                    onChange={(e) =>
                      setEdges((p) =>
                        p.map((ed) =>
                          ed.id === selEdge.id
                            ? { ...ed, cond: e.target.value }
                            : ed
                        )
                      )
                    }
                    placeholder="留空 = 无条件"
                    style={inp}
                  />
                </Field>
                <button
                  onClick={() => {
                    setEdges((p) => p.filter((e) => e.id !== selEdge.id));
                    setSel(null);
                  }}
                  style={{
                    ...btnS,
                    width: '100%',
                    color: '#ef4444',
                    borderColor: '#fecaca',
                    fontSize: 11.5,
                    padding: '5px 0',
                  }}
                >
                  删除连线
                </button>
              </>
            ) : libSel ? (
              (() => {
                let item = null;
                if (libSel.type === 'action') {
                  item =
                    lib.actions.find((a) => a.id === libSel.id) ||
                    lib.modules
                      .flatMap((m) => m.internalActions || [])
                      .find((a) => a.id === libSel.id);
                } else if (libSel.type === 'module') {
                  item = lib.modules.find((m) => m.id === libSel.id);
                }
                if (!item)
                  return <div style={{ color: '#c4d0e0' }}>未找到项</div>;
                return (
                  <>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        marginBottom: 10,
                        color: '#1b2540',
                      }}
                    >
                      {libSel.type === 'module' ? `&${item.name}` : item.name}
                    </div>
                    {libSel.type === 'action' ? (
                      <>
                        <PR k="类型" v={`@${item.executorType}`} />
                        {item.executorActor && (
                          <PR k="执行者" v={item.executorActor} />
                        )}
                        {item.scope && <PR k="Scope" v={item.scope} />}
                        {item.outVars && <PR k="out" v={item.outVars} />}
                      </>
                    ) : (
                      <PR k="模块" v={item.name} />
                    )}
                    <button
                      onClick={() => {
                        if (libSel.type === 'action')
                          setModal({ type: 'edit', action: item });
                        else editModule(item);
                      }}
                      style={{ ...btnS, marginTop: 8, width: '100%' }}
                    >
                      编辑
                    </button>
                  </>
                );
              })()
            ) : (
              <div
                style={{ color: '#c4d0e0', fontSize: 11.5, lineHeight: 1.7 }}
              >
                点击节点或连线查看属性
                <br />
                <span style={{ fontSize: 10.5 }}>双击节点可编辑 Action</span>
              </div>
            )}
          </div>

      {/* FEM Preview */}
      <FemPreview
        value={femText}
        onChange={(v) => { setFemText(v); setFemDirty(true); }}
        error={femError}
        dirty={femDirty}
        onApply={handleApplyFem}
        onRestore={handleRestoreFem}
        onGraphToFem={handleGraphToFem}
      />
      </div> {/* 闭合右侧面板 */}

      {/* ── MODAL ── */}
      {modal && (
        <ActionModal
          init={modal.type !== 'new' ? modal.action : null}
          existingNames={[...allNames]}
          isModuleInternal={mode === 'module'}
          onSave={(action) => {
            const actionWithPath = {
              ...action,
              path: action.path || [...locationPath],
            };
            if (modal.type === 'editNode') {
              setNodes((p) =>
                p.map((n) =>
                  n.id === modal.nodeId
                    ? { ...n, label: `[${actionWithPath.name}]` }
                    : n
                )
              );
            } else if (modal.type === 'edit') {
              setNodes((p) =>
                p.map((n) =>
                  n.actionId === actionWithPath.id
                    ? { ...n, label: `[${actionWithPath.name}]` }
                    : n
                )
              );
            } else {
              addNode(actionWithPath);
            }
            // 更新 actionStore
            setActionStore((prev) => {
              const idx = prev.findIndex((a) => a.id === actionWithPath.id);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = actionWithPath;
                return updated;
              } else {
                return [...prev, actionWithPath];
              }
            });
            // ⚡ 已删除 setFemDirty(false)：原架构下这行是竞态触发点，
            //    现在不再有 autoFem 自动同步机制，此处无需操作 dirty 状态。
            console.log('[ActionModal onSave] action 已更新, name:', actionWithPath.name);
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
      <BubbleOverlay
        bubbleOverlay={bubbleOverlay}
        nodes={nodes}
        nodeStates={nodeStates}
        actionStore={actionStore}
        onClose={handleBubbleClose}
        submitHumanInput={submitHumanInput}
      />

      {/* ── API Key 设置浮层（插件模式：key 走 dsh credentials，不渲染）── */}
      {!plugin && (
      <ApiKeyModal
        open={apiKeyModalOpen}
        apiKeyInput={apiKeyInput}
        setApiKeyInput={setApiKeyInput}
        apiProviderSelect={apiProviderSelect}
        setApiProviderSelect={setApiProviderSelect}
        apiUrlInput={apiUrlInput}
        setApiUrlInput={setApiUrlInput}
        apiModelInput={apiModelInput}
        setApiModelInput={setApiModelInput}
        rememberKey={rememberKey}
        setRememberKey={setRememberKey}
        userApiKey={userApiKey}
        onSave={handleSaveApiKey}
        onClear={handleClearApiKey}
        onClose={() => setApiKeyModalOpen(false)}
      />
      )}

      {/* ── 新建 SOUL ID 浮层（插件模式暂不提供 souls 管理入口）── */}
      {!plugin && (
      <SoulModal
        open={soulModalOpen}
        onClose={() => setSoulModalOpen(false)}
        onCreated={(data) => {
          setSoulModalOpen(false);
        }}
      />
      )}
      {!plugin && (
      <BackendUrlModal
        open={backendModalOpen}
        onClose={() => setBackendModalOpen(false)}
        onSaveComplete={() => setBackendRefreshTrigger(t => t + 1)}
      />
      )}
    </div> {/* 闭合最外层 flex 容器 */}
    </ErrorBoundary>
  );
}
