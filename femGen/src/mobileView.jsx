// ═══════════════════════════════════════════════════════════════
// ═══ mobileView.jsx  ───  手机端统一视图管理
// ═══════════════════════════════════════════════════════════════
//
// 布局（固定，不可整体滚动/缩放）：
//   ┌─────────────────────────────────┐
//   │ TitleBar  (5vh)                 │
//   ├─────────────────────────────────┤
//   │                                 │
//   │  Canvas  (75vh)                 │
//   │                                 │
//   ├─────────────────────────────────┤
//   │  BottomPanel  (20vh)            │
//   │  [Library | Project | Props]    │
//   └─────────────────────────────────┘
//
// 手势：
//   单指拖动  →  平移画布
//   双指捏合  →  缩放画布
//   单击      →  选中节点/边
//   双击      →  打开节点编辑
//   长按      →  调出节点上下文菜单（预留）
//
// ═══════════════════════════════════════════════════════════════

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import { ti, inp, btnP, btnS } from './common';
import { LibPanel } from './libPanel';
import { ProjPanel } from './projectPanel';
import { BubbleOverlay } from './bubbleOverlay';
import { FemPreview } from './femPreview';

// ─────────────────────────────────────────────
// 颜色 / 主题 token
// ─────────────────────────────────────────────
const T = {
  bg: '#0d1117',
  surface: '#161b27',
  surfaceHover: '#1e2535',
  border: '#2a3347',
  borderLight: '#3a4560',
  accent: '#3d5cf5',
  accentGlow: 'rgba(61,92,245,0.25)',
  textPrimary: '#e8edf8',
  textSecondary: '#7a8aaa',
  textMuted: '#4a5568',
  tabActive: '#3d5cf5',
  tabInactive: '#2a3347',
  danger: '#ef4444',
  success: '#22c55e',
  warning: '#f59e0b',
};

// ─────────────────────────────────────────────
// 全局样式注入（仅手机端追加）
// ─────────────────────────────────────────────
const MobileGlobalStyle = () => (
  <style>{`
    /* 禁止整体页面缩放 / 滚动 */
    html, body {
      overscroll-behavior: none;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    /* 画布区允许自定义 touch-action */
    .fem-canvas-zone {
      touch-action: none;
    }
    /* 底部面板允许垂直滚动 */
    .fem-bottom-scroll {
      touch-action: pan-y;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* 输入框恢复 touch */
    .fem-bottom-scroll input,
    .fem-bottom-scroll textarea,
    .fem-bottom-scroll select {
      touch-action: auto;
      user-select: text;
      -webkit-user-select: text;
    }
    /* 侧边菜单遮罩淡入 */
    @keyframes fadeInOverlay {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* 侧边菜单滑入 */
    @keyframes slideInMenu {
      from { transform: translateX(-100%); }
      to   { transform: translateX(0); }
    }
    /* FEM 面板滑入 */
    @keyframes slideInFem {
      from { transform: translateX(100%); }
      to   { transform: translateX(0); }
    }
    /* 底部面板切换淡入 */
    @keyframes fadePanel {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    /* 气泡弹出 */
    @keyframes popIn {
      from { opacity: 0; transform: translate(-50%, -46%) scale(0.92); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    /* 标题栏闪光扫描 */
    @keyframes scanLine {
      0%   { left: -60%; }
      100% { left: 110%; }
    }
    /* 状态指示灯脉冲 */
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.6; transform: scale(0.85); }
    }
    /* 流式光标 */
    .mob-cursor { animation: blink 0.75s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }
  `}</style>
);

// ─────────────────────────────────────────────
// TitleBar
// ─────────────────────────────────────────────
function MobileTitleBar({
  projName,
  flowStatus,
  femVisible,
  onMenuOpen,
  onToggleFem,
  onRun,
  onPause,
  onResume,
  hasActiveRunningNodes,
}) {
  const statusDot = {
    idle:    { c: T.textMuted,  label: '' },
    running: { c: T.success,    label: '运行中' },
    paused:  { c: T.warning,    label: '已暂停' },
  }[flowStatus] || { c: T.textMuted, label: '' };

  return (
    <div
      style={{
        position: 'relative',
        height: '5vh',
        minHeight: 40,
        maxHeight: 56,
        background: T.surface,
        borderBottom: `1px solid ${T.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        flexShrink: 0,
        zIndex: 100,
        overflow: 'hidden',
      }}
    >
      {/* 扫光效果 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          width: '60%',
          height: '100%',
          background:
            'linear-gradient(90deg,transparent,rgba(61,92,245,0.06),transparent)',
          pointerEvents: 'none',
          animation: 'scanLine 4s linear infinite',
        }}
      />

      {/* 左侧：菜单键 */}
      <button
        onClick={onMenuOpen}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '6px 8px 6px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          flexShrink: 0,
        }}
        aria-label="菜单"
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              display: 'block',
              width: i === 1 ? 16 : 22,
              height: 2,
              background: T.textSecondary,
              borderRadius: 2,
              transition: 'width 0.2s',
            }}
          />
        ))}
      </button>

      {/* 中间：项目名 + 状态 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          overflow: 'hidden',
          padding: '0 8px',
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: T.textPrimary,
            fontFamily: 'DM Sans, sans-serif',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '0.01em',
          }}
        >
          {projName || 'FEM Flow'}
        </span>
        {flowStatus !== 'idle' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: statusDot.c,
                display: 'block',
                animation: flowStatus === 'running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 10, color: statusDot.c, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
              {statusDot.label}
            </span>
          </div>
        )}
      </div>

      {/* 右侧：运行控制 + FEM 切换 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {/* 运行/暂停/继续 按钮 */}
        {flowStatus === 'idle' && (
          <MobileIconBtn
            onClick={onRun}
            label="▶"
            color={T.success}
            title="运行"
          />
        )}
        {flowStatus === 'running' && hasActiveRunningNodes && (
          <MobileIconBtn
            onClick={onPause}
            label="⏸"
            color={T.warning}
            title="暂停"
          />
        )}
        {((flowStatus === 'running' && !hasActiveRunningNodes) || flowStatus === 'paused') && (
          <MobileIconBtn
            onClick={onResume}
            label="▶"
            color={T.accent}
            title="继续"
          />
        )}

        {/* FEM 预览切换 */}
        <button
          onClick={onToggleFem}
          style={{
            background: femVisible ? T.accent : T.tabInactive,
            border: 'none',
            borderRadius: 6,
            padding: '4px 8px',
            cursor: 'pointer',
            fontSize: 9.5,
            fontWeight: 800,
            color: femVisible ? 'white' : T.textSecondary,
            fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.04em',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          FEM
        </button>
      </div>
    </div>
  );
}

function MobileIconBtn({ onClick, label, color, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: color + '22',
        border: `1px solid ${color}44`,
        borderRadius: 6,
        width: 30,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: 13,
        color: color,
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────
// SideMenu（侧边滑出菜单）
// ─────────────────────────────────────────────
function MobileSideMenu({ open, onClose, onOpenApiKey, onOpenSoul }) {
  if (!open) return null;
  const items = [
    {
      icon: '🔑',
      label: 'API 密钥',
      sub: '配置模型接口',
      action: onOpenApiKey,
    },
    {
      icon: '👤',
      label: '新建 Soul',
      sub: '创建角色身份',
      action: onOpenSoul,
    },
  ];
  return (
    <>
      {/* 遮罩 */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 400,
          animation: 'fadeInOverlay 0.18s ease',
        }}
      />
      {/* 菜单板 */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          width: '72vw',
          maxWidth: 300,
          background: T.surface,
          borderRight: `1px solid ${T.border}`,
          zIndex: 401,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideInMenu 0.22s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: '8px 0 32px rgba(0,0,0,0.4)',
        }}
      >
        {/* 菜单头 */}
        <div
          style={{
            padding: '20px 18px 14px',
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 800, color: T.accent, letterSpacing: '0.12em', fontFamily: 'JetBrains Mono, monospace', marginBottom: 4 }}>
            FEM WORKFLOW
          </div>
          <div style={{ fontSize: 9, color: T.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>
            VISUAL EDITOR
          </div>
        </div>

        {/* 菜单项 */}
        <div style={{ padding: '10px 10px', flex: 1 }}>
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => { item.action?.(); onClose(); }}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                borderRadius: 10,
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                cursor: 'pointer',
                textAlign: 'left',
                marginBottom: 4,
                transition: 'background 0.12s',
              }}
              onTouchStart={(e) => e.currentTarget.style.background = T.surfaceHover}
              onTouchEnd={(e) => e.currentTarget.style.background = 'none'}
            >
              <span style={{ fontSize: 20, flexShrink: 0 }}>{item.icon}</span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: T.textPrimary, fontFamily: 'DM Sans, sans-serif' }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 10.5, color: T.textMuted, marginTop: 1 }}>
                  {item.sub}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* 底部版本 */}
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 9, color: T.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>
            FEM EDITOR · MOBILE
          </div>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// FEM 预览侧板（右侧全高滑出）
// ─────────────────────────────────────────────
function MobileFemPanel({ visible, femText, onChange, femError, femDirty, onApply, onRestore, onGraphToFem, onClose }) {
  if (!visible) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 300,
          animation: 'fadeInOverlay 0.18s ease',
        }}
      />
      <div
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: '88vw',
          maxWidth: 420,
          background: '#0c1428',
          borderLeft: `1px solid ${T.border}`,
          zIndex: 301,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideInFem 0.22s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: '14px 16px 10px',
            borderBottom: '1px solid #1e2d45',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 800, color: '#9aaccb', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'JetBrains Mono, monospace' }}>
            FEM 预览
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {femError && (
              <button onClick={onRestore} style={{ ...mobBtnS, fontSize: 10, color: T.warning, borderColor: T.warning }}>恢复</button>
            )}
            <button onClick={onGraphToFem} style={{ ...mobBtnS, fontSize: 10 }}>图→文</button>
            <button
              onClick={onApply}
              style={{
                ...mobBtnP,
                fontSize: 10,
                padding: '4px 10px',
                background: femDirty ? T.accent : '#475569',
              }}
            >
              文→图
            </button>
            <button
              onClick={onClose}
              style={{
                background: '#1e2d45',
                border: 'none',
                borderRadius: 6,
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: '#9aaccb',
                fontSize: 14,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {femError && (
          <div style={{ margin: '8px 12px 0', padding: '6px 10px', background: '#300', border: '1px solid #622', borderRadius: 6, fontSize: 10, color: '#f87171', lineHeight: 1.5 }}>
            {femError}
          </div>
        )}

        {/* 编辑器 */}
        <textarea
          value={femText}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            padding: '12px 14px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10.5,
            lineHeight: 1.8,
            color: '#8fa8c8',
            touchAction: 'auto',
            userSelect: 'text',
            WebkitUserSelect: 'text',
          }}
        />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// Bottom Panel — Library / Project / Properties
// ─────────────────────────────────────────────

// Tab 定义
const BOTTOM_TABS = [
  { id: 'library', label: '仓库' },
  { id: 'project', label: '项目' },
  { id: 'props', label: '属性' },
];

function MobileBottomPanel({
  activeTab,
  onTabChange,
  // Library props
  lib,
  mode,
  locationPath,
  allNames,
  onNew,
  onAdd,
  onAddModule,
  onAddSpecial,
  onAddPosition,
  onEdit,
  onEditModule,
  onDragStart,
  onLibTouchStart,
  onLibTouchMove,
  onLibTouchEnd,
  onSelectLib,
  onNewModule,
  // Project props
  proj,
  actorNames,
  onProjChange,
  // Props
  sel,
  selNode,
  selEdge,
  selAction,
  nodes,
  edges,
  backEdges,
  nodeStates,
  actionStore,
  onDeleteNode,
  onDeleteEdge,
  onCondChange,
  onEditAction,
  libSel,
}) {
  const scrollRef = useRef(null);
  const WIN_H = typeof window !== 'undefined' ? window.innerHeight : 700;
  const MIN_H = 100;
  const MAX_H = Math.round(WIN_H * 0.72);
  const DEFAULT_H = Math.round(WIN_H * 0.28);
  const [panelH, setPanelH] = useState(DEFAULT_H);
  const dragHandleRef = useRef(null);
  const dragStartRef = useRef(null); // { y, h }

  // 切换 tab 时滚回顶部
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeTab]);

  // 鼠标拖拽（桌面调试用）
  const onHandleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, h: panelH };
    const onMove = (mv) => {
      const delta = dragStartRef.current.y - mv.clientY;
      setPanelH(Math.max(MIN_H, Math.min(MAX_H, dragStartRef.current.h + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelH]);

  // 触摸拖拽
  const onHandleTouchStart = useCallback((e) => {
    e.stopPropagation();
    const t = e.touches[0];
    dragStartRef.current = { y: t.clientY, h: panelH };
  }, [panelH]);

  const onHandleTouchMove = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    const t = e.touches[0];
    const delta = dragStartRef.current.y - t.clientY;
    setPanelH(Math.max(MIN_H, Math.min(MAX_H, dragStartRef.current.h + delta)));
  }, []);

  const onHandleTouchEnd = useCallback((e) => {
    e.stopPropagation();
    dragStartRef.current = null;
  }, []);

  return (
    <div
      style={{
        height: panelH,
        background: T.surface,
        borderTop: `1px solid ${T.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        position: 'relative',
        zIndex: 50,
        transition: dragStartRef.current ? 'none' : 'height 0.12s ease',
      }}
    >
      {/* 拖拽手柄 */}
      <div
        ref={dragHandleRef}
        onMouseDown={onHandleMouseDown}
        onTouchStart={onHandleTouchStart}
        onTouchMove={onHandleTouchMove}
        onTouchEnd={onHandleTouchEnd}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'ns-resize',
          zIndex: 10,
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            background: T.borderLight,
            opacity: 0.7,
            marginTop: 6,
          }}
        />
      </div>

      {/* Tab bar（留出手柄空间）*/}
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
          background: T.bg,
          marginTop: 18,
        }}
      >
        {BOTTOM_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              borderBottom: activeTab === t.id ? `2px solid ${T.accent}` : '2px solid transparent',
              padding: '7px 0',
              fontSize: 11.5,
              fontWeight: activeTab === t.id ? 800 : 500,
              color: activeTab === t.id ? T.accent : T.textMuted,
              cursor: 'pointer',
              fontFamily: 'DM Sans, sans-serif',
              letterSpacing: '0.02em',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {t.label}
            {t.id === 'props' && (sel || libSel) && (
              <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: T.accent, marginLeft: 4, verticalAlign: 'middle' }} />
            )}
          </button>
        ))}
      </div>

      {/* Scrollable content — 直接复用桌面端原有组件 */}
      <div
        ref={scrollRef}
        className="fem-bottom-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '10px 14px 12px',
          animation: 'fadePanel 0.15s ease',
          minHeight: 0,
          // 让桌面端组件在深色背景下可读
          '--text-primary': T.textPrimary,
          color: '#1b2540',
          background: 'white',
          borderRadius: '8px 8px 0 0',
        }}
      >
        {activeTab === 'library' && (
          <LibPanel
            lib={lib}
            mode={mode}
            locationPath={locationPath}
            allNames={allNames}
            onNew={onNew}
            onAdd={onAdd}
            onAddModule={onAddModule}
            onAddSpecial={onAddSpecial}
            onAddPosition={onAddPosition}
            onEdit={onEdit}
            onEditModule={onEditModule}
            onDragStart={onDragStart}
            onLibTouchStart={onLibTouchStart}
            onLibTouchMove={onLibTouchMove}
            onLibTouchEnd={onLibTouchEnd}
            onSelectLib={onSelectLib}
            onNewModule={onNewModule}
          />
        )}
        {activeTab === 'project' && (
          <ProjPanel
            proj={proj}
            actorNames={actorNames}
            onChange={onProjChange}
          />
        )}
        {activeTab === 'props' && (
          <MobilePropsPanel
            sel={sel}
            selNode={selNode}
            selEdge={selEdge}
            selAction={selAction}
            nodes={nodes}
            edges={edges}
            backEdges={backEdges}
            nodeStates={nodeStates}
            actionStore={actionStore}
            onDeleteNode={onDeleteNode}
            onDeleteEdge={onDeleteEdge}
            onCondChange={onCondChange}
            onEditAction={onEditAction}
            libSel={libSel}
            lib={lib}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MobileLibPanel — 仓库面板（横向卡片列表）
// ─────────────────────────────────────────────
function MobileLibPanel({ lib, mode, locationPath, allNames, onNew, onAdd, onAddModule, onAddSpecial, onAddPosition, onEdit, onEditModule, onSelectLib, onNewModule }) {
  const [newModName, setNewModName] = useState('');

  const displayActions = (lib.actions || []).filter((a) => {
    if (!a.path) return false;
    if (a.path.length === 1 && a.path[0] === 'mainflow') return true;
    return locationPath.every((seg, i) => a.path[i] === seg);
  });
  const displayModules = (lib.modules || []).filter(
    (m) =>
      m.path &&
      locationPath.every((seg, i) => m.path[i] === seg) &&
      m.path.length === locationPath.length + 1
  );
  const specialNodes =
    mode === 'mainflow'
      ? [
          { t: 'FOR', c: '#4f6ef7' },
          { t: 'PAR', c: '#7e22ce' },
          { t: 'END', c: '#ef4444' },
        ]
      : [
          { t: 'FOR', c: '#4f6ef7' },
          { t: 'PAR', c: '#7e22ce' },
          { t: 'BREAK', c: '#f59e0b' },
          { t: 'OUT', c: '#ef4444' },
        ];

  return (
    <div>
      {/* Actions 行 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={sectionLabel}>Actions</span>
        <button onClick={onNew} style={{ ...mobBtnP, padding: '3px 10px', fontSize: 10 }}>+ 新建</button>
      </div>
      <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
        {displayActions.length === 0 ? (
          <div style={{ fontSize: 11, color: T.textMuted, padding: '4px 0' }}>暂无 Action</div>
        ) : displayActions.map((a) => {
          const { c, bg } = ti(a.executorType);
          return (
            <div
              key={a.id}
              onClick={() => onSelectLib?.('action', a.id)}
              style={{
                background: '#1a2236',
                borderRadius: 8,
                border: `1.5px solid ${c}30`,
                borderLeft: `3px solid ${c}`,
                padding: '6px 9px',
                minWidth: 100,
                maxWidth: 140,
                flexShrink: 0,
                cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 700, color: T.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
                {a.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: c, fontFamily: 'JetBrains Mono, monospace' }}>@{a.executorType}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onAdd(a); }}
                  style={{ background: c, border: 'none', borderRadius: 4, color: 'white', fontSize: 9, fontWeight: 700, padding: '1px 6px', cursor: 'pointer' }}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modules */}
      {displayModules.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 10, marginBottom: 6 }}>Modules</div>
          <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4 }}>
            {displayModules.map((m) => (
              <div
                key={m.id}
                onClick={() => onSelectLib?.('module', m.id)}
                style={{
                  background: '#1a2236',
                  borderRadius: 8,
                  border: '1.5px solid #475569',
                  borderLeft: '3px solid #475569',
                  padding: '6px 9px',
                  minWidth: 100,
                  flexShrink: 0,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textPrimary, marginBottom: 5 }}>&{m.name}</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); onAddModule(m); }}
                    style={{ background: '#475569', border: 'none', borderRadius: 4, color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', flex: 1 }}
                  >
                    +画布
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onEditModule?.(m); }}
                    style={{ background: '#3d5cf5', border: 'none', borderRadius: 4, color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', flex: 1 }}
                  >
                    进入
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 新建模块 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
        <input
          value={newModName}
          onChange={(e) => setNewModName(e.target.value)}
          placeholder="新模块名"
          style={{ ...mobInp, flex: 1, fontSize: 11 }}
        />
        <button
          onClick={() => {
            const name = newModName.trim();
            if (name && (!allNames?.has || !allNames.has(name))) {
              onNewModule(name);
              setNewModName('');
            }
          }}
          style={{ ...mobBtnP, padding: '5px 10px', fontSize: 10, flexShrink: 0 }}
        >
          创建
        </button>
      </div>

      {/* 特殊节点 + POSITION */}
      <div style={{ marginTop: 10 }}>
        <div style={sectionLabel}>特殊节点</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {specialNodes.map((s) => (
            <button
              key={s.t}
              onClick={() => onAddSpecial(s.t)}
              style={{
                background: s.c + '18',
                border: `1px solid ${s.c}44`,
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 10.5,
                fontWeight: 800,
                color: s.c,
                cursor: 'pointer',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              [{s.t}]
            </button>
          ))}
          <button
            onClick={onAddPosition}
            style={{
              background: '#94a3b818',
              border: '1px solid #94a3b844',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 10.5,
              fontWeight: 700,
              color: '#94a3b8',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            POSITION
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MobileProjPanel — 精简项目信息
// ─────────────────────────────────────────────
function MobileProjPanel({ proj, actorNames, onChange }) {
  if (!proj) return null;
  const u = (x) => onChange({ ...proj, ...x });
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 2 }}>
          <div style={fieldLabel}>项目名称</div>
          <input value={proj.name || ''} onChange={(e) => u({ name: e.target.value })} style={mobInp} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={fieldLabel}>Version</div>
          <input value={proj.version || ''} onChange={(e) => u({ version: e.target.value })} placeholder="1.0" style={mobInp} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={fieldLabel}>Database</div>
          <input value={proj.database || ''} onChange={(e) => u({ database: e.target.value })} placeholder="memory/..." style={mobInp} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={fieldLabel}>Session</div>
          <input value={proj.session || ''} onChange={(e) => u({ session: e.target.value })} placeholder="new" style={mobInp} />
        </div>
      </div>

      {/* Actors */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={sectionLabel}>Actors</span>
        <button
          onClick={() => u({ actors: [...(proj.actors || []), { name: '', type: 'ai', soul: '1', source: 'deepseek', tools: [] }] })}
          style={{ ...mobBtnP, padding: '2px 8px', fontSize: 10 }}
        >
          +
        </button>
      </div>
      {(proj.actors || []).map((a, i) => {
        const upd = (x) => u({ actors: proj.actors.map((p, j) => (j === i ? { ...p, ...x } : p)) });
        return (
          <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
            <select value={a.type} onChange={(e) => upd({ type: e.target.value })} style={{ ...mobInp, width: 60, fontSize: 10 }}>
              <option value="ai">ai</option>
              <option value="human">human</option>
            </select>
            <input
              value={a.name}
              onChange={(e) => { let v = e.target.value.trim(); if (v && !v.startsWith('@')) v = '@' + v; upd({ name: v }); }}
              placeholder="@Alice"
              style={{ ...mobInp, flex: 1, fontSize: 11 }}
            />
            <input value={a.source} onChange={(e) => upd({ source: e.target.value })} placeholder="deepseek" style={{ ...mobInp, flex: 1, fontSize: 11 }} />
            <button onClick={() => u({ actors: proj.actors.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 2 }}>×</button>
          </div>
        );
      })}

      {/* Vars */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, marginTop: 8 }}>
        <span style={sectionLabel}>Vars</span>
        <button onClick={() => u({ vars: [...(proj.vars || []), { name: '', defaultValue: '' }] })} style={{ ...mobBtnP, padding: '2px 8px', fontSize: 10 }}>+</button>
      </div>
      {(proj.vars || []).map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
          <input value={v.name} onChange={(e) => { const upd = [...proj.vars]; upd[i] = { ...upd[i], name: e.target.value }; u({ vars: upd }); }} placeholder="变量名" style={{ ...mobInp, flex: 1 }} />
          <input value={v.defaultValue} onChange={(e) => { const upd = [...proj.vars]; upd[i] = { ...upd[i], defaultValue: e.target.value }; u({ vars: upd }); }} placeholder="默认值" style={{ ...mobInp, flex: 2 }} />
          <button onClick={() => u({ vars: proj.vars.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 2 }}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// MobilePropsPanel — 节点/边属性
// ─────────────────────────────────────────────
function MobilePropsPanel({ sel, selNode, selEdge, selAction, nodes, edges, backEdges, nodeStates, actionStore, onDeleteNode, onDeleteEdge, onCondChange, onEditAction, libSel, lib }) {
  if (sel?.type === 'node' && selNode) {
    const ns = nodeStates?.[selNode.id] || {};
    const action = selAction;
    const { c } = action ? ti(action.executorType) : { c: '#94a3b8' };
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
          {action && (
            <span style={{ background: c + '22', color: c, borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 800, fontFamily: 'JetBrains Mono, monospace' }}>
              @{action.executorType}
            </span>
          )}
          <span style={{ fontSize: 13.5, fontWeight: 800, color: T.textPrimary }}>{action?.name || selNode.specialType || selNode.label || '节点'}</span>
        </div>
        {action && (
          <>
            {action.executorActor && <MobPropRow k="执行者" v={action.executorActor} />}
            {action.scope && <MobPropRow k="Scope" v={action.scope} />}
            {action.outVars && <MobPropRow k="出参" v={String(action.outVars)} />}
          </>
        )}
        {ns.status && <MobPropRow k="状态" v={ns.status} />}
        <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
          {action && (
            <button onClick={onEditAction} style={{ ...mobBtnP, flex: 1, fontSize: 11, padding: '6px 0' }}>编辑 Action</button>
          )}
          <button onClick={onDeleteNode} style={{ ...mobBtnDanger, flex: 1, fontSize: 11, padding: '6px 0' }}>删除节点</button>
        </div>
      </div>
    );
  }
  if (sel?.type === 'edge' && selEdge) {
    const isBack = backEdges?.has(selEdge.id);
    const inEdges = edges.filter((e) => e.tgt === selEdge.tgt && !backEdges?.has(e.id));
    return (
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textPrimary, marginBottom: 8 }}>连线属性</div>
        {isBack && <div style={{ fontSize: 10, color: '#4f6ef7', fontWeight: 700, background: '#eef1ff22', borderRadius: 5, padding: '3px 7px', marginBottom: 6 }}>回环检测</div>}
        {inEdges.length > 1 && <div style={{ fontSize: 10, color: T.warning, fontWeight: 700, marginBottom: 6 }}>Join 节点 ({inEdges.length} 入口)</div>}
        <div style={fieldLabel}>if 条件</div>
        <input
          value={selEdge.cond || ''}
          onChange={(e) => onCondChange(e.target.value)}
          placeholder="留空 = 无条件"
          style={{ ...mobInp, marginBottom: 10 }}
        />
        <button onClick={onDeleteEdge} style={{ ...mobBtnDanger, width: '100%', fontSize: 11, padding: '6px 0' }}>删除连线</button>
      </div>
    );
  }
  if (libSel) {
    let item = null;
    if (libSel.type === 'action') item = lib?.actions?.find((a) => a.id === libSel.id);
    else if (libSel.type === 'module') item = lib?.modules?.find((m) => m.id === libSel.id);
    if (item) {
      return (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary, marginBottom: 8 }}>
            {libSel.type === 'module' ? `&${item.name}` : item.name}
          </div>
          {libSel.type === 'action' && (
            <>
              <MobPropRow k="类型" v={`@${item.executorType}`} />
              {item.executorActor && <MobPropRow k="执行者" v={item.executorActor} />}
            </>
          )}
        </div>
      );
    }
  }
  return (
    <div style={{ color: T.textMuted, fontSize: 12, lineHeight: 1.8, paddingTop: 4 }}>
      点击节点或连线查看属性
      <br />
      <span style={{ fontSize: 10.5, color: T.textMuted }}>双击节点可编辑</span>
    </div>
  );
}

function MobPropRow({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11.5, marginBottom: 5 }}>
      <span style={{ color: T.textMuted, minWidth: 44, flexShrink: 0 }}>{k}</span>
      <span style={{ color: T.textPrimary, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
}

// ─────────────────────────────────────────────
// BubbleOverlay 手机适配版
// ─────────────────────────────────────────────
function MobileBubbleOverlay({ bubbleOverlay, nodes, nodeStates, actionStore, onClose, submitHumanInput }) {
  if (!bubbleOverlay) return null;
  const node = nodes.find((n) => n.id === bubbleOverlay.nodeId);
  if (!node || node.type !== 'action') return null;
  const action = actionStore?.find((a) => a.id === node.actionId);
  const ns = nodeStates[node.id] || {};
  const isAI = action?.executorType === 'ai';
  const isHuman = action?.executorType === 'human';
  const isStreaming = ns.status === 'ai_streaming';
  const { c } = ti(action?.executorType) || { c: '#94a3b8' };
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [ns.streamingText, ns.output]);

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 500, animation: 'fadeInOverlay 0.18s ease' }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(92vw, 460px)',
          maxHeight: '78vh',
          background: 'white',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          border: `2px solid ${c}`,
          fontFamily: 'DM Sans, sans-serif',
          zIndex: 501,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'popIn 0.2s cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        {/* 头部 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #edf0f8', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ background: c + '18', color: c, borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 800, fontFamily: 'JetBrains Mono, monospace' }}>
              @{action?.executorType || '?'}
            </span>
            <span style={{ fontWeight: 800, color: '#1b2540', fontSize: 15 }}>{action?.name || 'Node'}</span>
          </div>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ background: '#f1f5f9', border: 'none', fontSize: 15, cursor: 'pointer', color: '#64748b', borderRadius: 7, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* 内容 */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', lineHeight: 1.65, fontSize: 13, color: '#1b2540', touchAction: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {ns.context && <div style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{ns.context}</div>}
          {ns.showprompt && (
            <div style={{ marginBottom: 10, background: '#f8fafc', padding: '8px 10px', borderRadius: 7 }}>
              <div style={{ fontWeight: 700, color: '#7a8aaa', marginBottom: 3, fontSize: 10.5 }}>[节点提示]</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.showprompt}</div>
            </div>
          )}
          {isHuman && ns.prompt && (
            <div style={{ marginBottom: 10, background: '#f8fafc', padding: '8px 10px', borderRadius: 7 }}>
              <div style={{ fontWeight: 700, color: '#7a8aaa', marginBottom: 3, fontSize: 10.5 }}>[提示]</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.prompt}</div>
            </div>
          )}
          {isAI && (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>[{ns.ai_name || 'AI'}]:</div>
              {isStreaming ? (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                  {ns.streamingText || ''}
                  <span className="mob-cursor" style={{ fontWeight: 'bold', color: c }}>|</span>
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.output || '（等待输出）'}</div>
              )}
            </div>
          )}
        </div>

        {/* 人类输入 */}
        {isHuman && ns.status === 'human_wait' && (
          <MobileHumanInput nodeId={node.id} onSubmit={submitHumanInput} outVars={ns.outVars || []} />
        )}
      </div>
    </>
  );
}

function MobileHumanInput({ nodeId, onSubmit, outVars }) {
  const [chatText, setChatText] = useState('');
  const [varValues, setVarValues] = useState({});

  const handleSend = () => {
    if (!chatText.trim() && !Object.values(varValues).some((v) => v?.trim())) return;
    const assignments = {};
    for (const [k, v] of Object.entries(varValues)) {
      if (v?.trim()) assignments[k] = v.trim();
    }
    onSubmit(nodeId, chatText.trim(), assignments);
    setChatText('');
    setVarValues({});
  };

  return (
    <div style={{ flexShrink: 0, padding: '10px 14px 16px', borderTop: '1px solid #edf0f8' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>⏳ 等待人类输入</div>
      <textarea
        value={chatText}
        onChange={(e) => setChatText(e.target.value)}
        placeholder="输入回复..."
        rows={3}
        style={{
          ...inp,
          resize: 'none',
          width: '100%',
          boxSizing: 'border-box',
          fontSize: 13,
          touchAction: 'auto',
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      />
      <div style={{ display: 'flex', gap: 7, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={handleSend} style={{ ...mobBtnP, padding: '7px 18px', fontSize: 12 }}>发送</button>
        {outVars.map((varName) => (
          <div key={varName} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#7a8aaa', fontFamily: 'JetBrains Mono, monospace' }}>{varName}:</span>
            <input
              value={varValues[varName] || ''}
              onChange={(e) => setVarValues((p) => ({ ...p, [varName]: e.target.value }))}
              placeholder="值"
              style={{ ...inp, width: 90, fontSize: 11, padding: '4px 7px' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// useMobileCanvasGesture
// 状态机：pending → nodeDrag / conn / canvasPan / pinch
// 节点拖拽直接操作 setNodes，不经过依赖闭包的 onMM
// ─────────────────────────────────────────────
const LONG_PRESS_MS = 200;
const MOVE_THRESHOLD = 5;

function useMobileCanvasGesture({
  cvRef, pan, setPan, scale, setScale,
  handlePortDown, handlePortUp, setConn,
  nodes, setNodes, setDrag, setSel,
}) {
  const stateRef  = useRef({ phase: 'idle' });
  const pinchRef  = useRef({ dist: 0, x: 0, y: 0 });
  const startRef  = useRef({ x: 0, y: 0 });
  const timerRef  = useRef(null);
  const [dragReady, setDragReady] = useState(null);

  // 用 ref 持有最新 pan/scale/nodes，彻底避免闭包陈旧
  const panRef   = useRef(pan);
  const scaleRef = useRef(scale);
  const nodesRef = useRef(nodes);
  useEffect(() => { panRef.current = pan; },    [pan]);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid2  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const clearTimer = () => { clearTimeout(timerRef.current); timerRef.current = null; };

  // DOM hit-test：找节点体或端口
  const hitTest = (cx, cy) => {
    const el = document.elementFromPoint(cx, cy);
    if (!el) return null;
    const portEl = el.closest('[data-port-node]');
    if (portEl) return {
      type: 'port',
      nodeId: portEl.dataset.portNode,
      portDir: portEl.dataset.portDir || 'right',
      portX: portEl.dataset.portX ? parseFloat(portEl.dataset.portX) : undefined,
      portY: portEl.dataset.portY ? parseFloat(portEl.dataset.portY) : undefined,
    };
    const nodeEl = el.closest('[data-node-id]');
    if (nodeEl) return { type: 'node', nodeId: nodeEl.dataset.nodeId };
    return null;
  };

  const fakeEv = (cx, cy) => ({
    clientX: cx, clientY: cy, button: 0,
    stopPropagation: () => {}, preventDefault: () => {}, target: null,
  });

  const onTouchStart = useCallback((e) => {
    const ts = Array.from(e.touches);
    if (ts.length >= 2) {
      clearTimer();
      stateRef.current = { phase: 'pinch' };
      pinchRef.current = { dist: dist2(ts[0], ts[1]), ...mid2(ts[0], ts[1]) };
      setDragReady(null);
      return;
    }
    const t = ts[0];
    startRef.current = { x: t.clientX, y: t.clientY };
    stateRef.current = { phase: 'pending', cx: t.clientX, cy: t.clientY };
    setDragReady(null);

    // 长按计时：判断命中目标后切换阶段
    timerRef.current = setTimeout(() => {
      if (stateRef.current.phase !== 'pending') return;
      const { cx, cy } = stateRef.current;
      const hit = hitTest(cx, cy);
      console.log('[touch longpress] hit:', hit);

      if (hit?.type === 'port') {
        stateRef.current = { phase: 'conn', srcNodeId: hit.nodeId };
        navigator.vibrate?.(12);
        handlePortDown(fakeEv(cx, cy), hit.nodeId, hit.portDir, hit.portX, hit.portY);

      } else if (hit?.type === 'node') {
        const node = nodesRef.current.find(n => n.id === hit.nodeId);
        if (!node) return;
        navigator.vibrate?.(18);
        setDragReady(hit.nodeId);
        setSel({ type: 'node', id: hit.nodeId });
        stateRef.current = {
          phase: 'nodeDrag',
          nodeId: hit.nodeId,
          startCx: cx, startCy: cy,
          startNx: node.x, startNy: node.y,
        };
        console.log('[touch longpress] nodeDrag start, node:', hit.nodeId, 'pos:', node.x, node.y);

      } else {
        stateRef.current = { phase: 'canvasPan', cx, cy };
      }
    }, LONG_PRESS_MS);
  }, [handlePortDown, setSel]);

  const onTouchMove = useCallback((e) => {
    e.preventDefault();
    const ts = Array.from(e.touches);

    // 双指捏合缩放 + 平移
    if (ts.length >= 2 && stateRef.current.phase === 'pinch') {
      const d    = dist2(ts[0], ts[1]);
      const m    = mid2(ts[0], ts[1]);
      const ratio = d / (pinchRef.current.dist || d);
      const rect  = cvRef.current?.getBoundingClientRect();
      if (rect) {
        const p = panRef.current, s = scaleRef.current;
        const mx = m.x - rect.left, my = m.y - rect.top;
        const wx = (mx - p.x) / s,  wy = (my - p.y) / s;
        const ns = Math.min(3, Math.max(0.2, s * ratio));
        setPan({ x: mx - wx * ns + (m.x - pinchRef.current.x), y: my - wy * ns + (m.y - pinchRef.current.y) });
        setScale(ns);
      }
      pinchRef.current = { dist: d, x: m.x, y: m.y };
      return;
    }

    if (ts.length !== 1) return;
    const t = ts[0];
    const phase = stateRef.current.phase;

    // pending：快速滑动直接进入平移，不等长按
    if (phase === 'pending') {
      const dx = t.clientX - startRef.current.x;
      const dy = t.clientY - startRef.current.y;
      if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
        clearTimer();
        stateRef.current = { phase: 'canvasPan', cx: t.clientX, cy: t.clientY };
      }
      return;
    }

    // 节点拖拽：直接算 delta，调 setNodes
    if (phase === 'nodeDrag') {
      setDragReady(null);
      const s  = stateRef.current;
      const sc = scaleRef.current;
      const newX = s.startNx + (t.clientX - s.startCx) / sc;
      const newY = s.startNy + (t.clientY - s.startCy) / sc;
      console.log('[touch nodeDrag] move to', newX, newY);
      setNodes(prev => prev.map(n => n.id === s.nodeId ? { ...n, x: newX, y: newY } : n));
      return;
    }

    // 连线：更新 conn.mx/my
    if (phase === 'conn') {
      const p   = panRef.current;
      const sc  = scaleRef.current;
      const rect = cvRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = (t.clientX - rect.left - p.x) / sc;
      const my = (t.clientY - rect.top  - p.y) / sc;
      setConn(prev => prev ? { ...prev, mx, my } : prev);
      return;
    }

    // 画布平移
    if (phase === 'canvasPan') {
      const dx = t.clientX - stateRef.current.cx;
      const dy = t.clientY - stateRef.current.cy;
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      stateRef.current = { phase: 'canvasPan', cx: t.clientX, cy: t.clientY };
      return;
    }
  }, [cvRef, setPan, setScale, setNodes, setConn]);

  const onTouchEnd = useCallback((e) => {
    e.preventDefault();
    clearTimer();
    setDragReady(null);

    const phase    = stateRef.current.phase;
    const changed  = Array.from(e.changedTouches);
    const t        = changed[0];
    const remaining = Array.from(e.touches);

    console.log('[touch end] phase:', phase);

    // 连线结束：在抬起处 hit-test 找目标节点
    if (phase === 'conn' && t) {
      const hit = hitTest(t.clientX, t.clientY);
      console.log('[touch conn end] hit:', hit);
      if (hit?.nodeId && hit.nodeId !== stateRef.current.srcNodeId) {
        handlePortUp(fakeEv(t.clientX, t.clientY), hit.nodeId, hit.portDir || 'left');
      } else {
        setConn(null);
      }
    }

    // 节点拖拽结束
    if (phase === 'nodeDrag') {
      setDrag(null);
    }

    // pending 抬手 = 短按（点击）：选中节点或取消选中
    if (phase === 'pending' && t) {
      clearTimer();
      const hit = hitTest(t.clientX, t.clientY);
      console.log('[touch tap] hit:', hit);
      if (hit?.type === 'node') {
        setSel({ type: 'node', id: hit.nodeId });
      } else {
        setSel(null);
      }
    }

    stateRef.current = remaining.length === 0
      ? { phase: 'idle' }
      : { phase: 'canvasPan', cx: remaining[0].clientX, cy: remaining[0].clientY };
  }, [handlePortUp, setConn, setDrag, setSel]);

  return { onTouchStart, onTouchMove, onTouchEnd, dragReady };
}


// ─────────────────────────────────────────────
// MobileLayout — 根组件，接收桌面端所有 props
// ─────────────────────────────────────────────
/**
 * 用法（在 FemWorAuto.jsx 内检测 isMobile 后替换渲染）：
 *
 * <MobileLayout
 *   // 项目
 *   proj={proj}
 *   actorNames={actorNames}
 *   onProjChange={setProj}
 *   // 画布
 *   cvRef={cvRef}
 *   pan={pan}   setPan={setPan}
 *   scale={scale}  setScale={setScale}
 *   nodes={nodes}  edges={edges}
 *   canvasContent={<> {svgLayer} {nodeLayer} </>}
 *   // 交互
 *   sel={sel}  setSel={setSel}
 *   drag={drag}  conn={conn}  isPanning={isPanning}
          onMM={onMM}
          onMU={onMU}
          onCanvasDown={onCanvasDown}
          handleWheel={handleWheel}
          handlePortDown={handlePortDown}
          handlePortUp={handlePortUp}
          handleBodyMouseUp={handleBodyMouseUp}
setDrag={setDrag}
          setConn={setConn}
          setNodes={setNodes}
          handleCanvasDragOver={handleCanvasDragOver}
          handleCanvasDrop={handleCanvasDrop}
 *   // 库
 *   lib={lib}  mode={mode}  locationPath={locationPath}  allNames={allNames}
 *   onNew={...}  onAdd={...}  ... (所有 LibPanel 的 props)
 *   // 运行
 *   flowStatus={flowStatus}  hasActiveRunningNodes={hasActiveRunningNodes}
 *   onRun={handleRunWorkflow}  onPause={handlePauseWorkflow}  onResume={handleResumeWorkflow}
 *   nodeStates={nodeStates}  actionStore={actionStore}  activeNodeIds={activeNodeIds}
 *   // 气泡
 *   bubbleOverlay={bubbleOverlay}  onBubbleClose={handleBubbleClose}  submitHumanInput={submitHumanInput}
 *   // FEM
 *   femText={femText}  onFemChange={...}  femError={femError}  femDirty={femDirty}
 *   onApplyFem={handleApplyFem}  onRestoreFem={handleRestoreFem}  onGraphToFem={handleGraphToFem}
 *   // 模态框触发
 *   onOpenApiKey={() => setApiKeyModalOpen(true)}
 *   onOpenSoul={() => setSoulModalOpen(true)}
 *   // 画布内容透明度
 *   canvasOpacity={canvasOpacity}
 * />
 */
function MobileLayout({
  // Project
  proj, actorNames, onProjChange,
  // Canvas core
  cvRef, pan, setPan, scale, setScale,
  nodes, edges, sel, setSel,
drag, setDrag, conn, setConn, isPanning, setNodes,
  onMM, onMU, onCanvasDown, handleWheel,
  handlePortDown, handlePortUp, handleBodyMouseUp,
  handleCanvasDragOver, handleCanvasDrop,
  canvasContent, canvasOpacity,
  // Library
  lib, mode, locationPath, allNames,
  onNew, onAdd, onAddModule, onAddSpecial, onAddPosition,
  onEdit, onEditModule, onDragStart, onSelectLib, onNewModule,
  libSel,
  // Runtime
  flowStatus, hasActiveRunningNodes,
  onRun, onPause, onResume,
  nodeStates, actionStore, activeNodeIds, errorNodeIds,
  // Bubble
  bubbleOverlay, onBubbleClose, submitHumanInput,
  // FEM
  femText, onFemChange, femError, femDirty,
  onApplyFem, onRestoreFem, onGraphToFem,
  // Modals
  onOpenApiKey, onOpenSoul,
  // Selection helpers
  backEdges,
  onDeleteNode, onDeleteEdge, onCondChange, onEditAction,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [femVisible, setFemVisible] = useState(false);
  const [bottomTab, setBottomTab] = useState('library');

  // 当选中节点/边时，自动切换到属性 tab
  useEffect(() => {
    if (sel) setBottomTab('props');
  }, [sel]);

// 触摸手势（完全复用桌面端交互回调，不重复实现逻辑）
const { onTouchStart, onTouchMove, onTouchEnd, dragReady } = useMobileCanvasGesture({
    cvRef, pan, setPan, scale, setScale,
    handlePortDown, handlePortUp, setConn,
    nodes, setNodes, setDrag, setSel,
  });
  // ── 从仓库触摸拖拽放置节点 ──
  const libDragRef = useRef(null); // { type, item, x, y }
  const [libDragGhost, setLibDragGhost] = useState(null); // { x, y, label }

  const handleLibTouchStart = useCallback((e, type, item) => {
    e.stopPropagation();
    const t = e.touches[0];
    libDragRef.current = { type, item, startX: t.clientX, startY: t.clientY, moved: false };
  }, []);

  const handleLibTouchMove = useCallback((e) => {
    if (!libDragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    const dx = t.clientX - libDragRef.current.startX;
    const dy = t.clientY - libDragRef.current.startY;
    if (!libDragRef.current.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      libDragRef.current.moved = true;
    }
    if (libDragRef.current.moved) {
      const label = typeof libDragRef.current.item === 'string'
        ? libDragRef.current.item
        : (libDragRef.current.item?.name || libDragRef.current.type);
      setLibDragGhost({ x: t.clientX, y: t.clientY, label });
    }
  }, []);

  const handleLibTouchEnd = useCallback((e) => {
    if (!libDragRef.current?.moved) { libDragRef.current = null; setLibDragGhost(null); return; }
    const t = e.changedTouches[0];
    setLibDragGhost(null);
    // 判断落点是否在画布区域内
    const cvRect = cvRef.current?.getBoundingClientRect();
    if (!cvRect) { libDragRef.current = null; return; }
    if (t.clientX < cvRect.left || t.clientX > cvRect.right || t.clientY < cvRect.top || t.clientY > cvRect.bottom) {
      libDragRef.current = null;
      return;
    }
    // 转换为画布世界坐标
    const worldX = (t.clientX - cvRect.left - pan.x) / scale - 50;
    const worldY = (t.clientY - cvRect.top  - pan.y) / scale - 20;
    const { type, item } = libDragRef.current;
    if (type === 'action') onAdd(item, worldX, worldY);
    else if (type === 'module') onAddModule(item, worldX, worldY);
    else if (type === 'special') onAddSpecial(item, worldX, worldY);  // item 此时是字符串如 'OUT'
    else if (type === 'position') onAddPosition(worldX, worldY);       // position 不需要 item
    libDragRef.current = null;
  }, [pan, scale, cvRef, onAdd, onAddModule, onAddSpecial, onAddPosition]);

  // 当前选中实体
  const selNode = sel?.type === 'node' ? nodes.find((n) => n.id === sel.id) : null;
  const selEdge = sel?.type === 'edge' ? edges.find((e) => e.id === sel.id) : null;
  const selAction = selNode?.type === 'action' ? actionStore?.find((a) => a.id === selNode.actionId) : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: T.bg,
        fontFamily: 'DM Sans, sans-serif',
        overflow: 'hidden',
      }}
    >
      <MobileGlobalStyle />

      {/* ── 标题栏 ── */}
      <MobileTitleBar
        projName={proj?.name}
        flowStatus={flowStatus}
        femVisible={femVisible}
        onMenuOpen={() => setMenuOpen(true)}
        onToggleFem={() => setFemVisible((v) => !v)}
        onRun={onRun}
        onPause={onPause}
        onResume={onResume}
        hasActiveRunningNodes={hasActiveRunningNodes}
      />

      {/* ── 画布 ── */}
      <div
        ref={cvRef}
        className="fem-canvas-zone"
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          backgroundImage: 'radial-gradient(circle, #2a3347 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          cursor: isPanning ? 'grabbing' : conn ? 'crosshair' : 'default',
          minHeight: 0,
        }}
        // Mouse events (桌面兼容)
        onMouseMove={onMM}
        onMouseUp={onMU}
        onMouseDown={onCanvasDown}
        onWheel={handleWheel}
        onMouseLeave={onMU}
        // Touch events
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        // Drag-drop
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
      >
        <div
          data-canvas-bg="true"
          style={{
            opacity: canvasOpacity,
            transition: 'opacity 0.2s ease',
            position: 'absolute',
            inset: 0,
          }}
        >
          <div
            data-canvas-bg="true"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              inset: 0,
            }}
          >
            {canvasContent}
          </div>
        </div>

{/* 空状态提示（zIndex 极低，永远不遮节点）*/}
        {nodes.filter((n) => n.type !== 'special').length === 0 && !conn && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          >
            <div style={{ fontSize: 13, color: '#3a4560', fontWeight: 600 }}>从仓库添加 Action</div>
            <div style={{ fontSize: 11, color: '#2a3347', marginTop: 5 }}>长按节点拖动 · 长按端口连线 · 双指缩放</div>
          </div>
        )}

        {/* 长按就绪视觉反馈：在 dragReady 节点上方显示小环 */}
        {dragReady && (() => {
          const n = nodes.find(nd => nd.id === dragReady);
          if (!n) return null;
          const { w, h } = { w: 200, h: 80 }; // 估算节点中心，不引入 getNodeSize
          const cx = (n.x + w / 2) * scale + pan.x;
          const cy = (n.y + h / 2) * scale + pan.y;
          return (
            <div style={{
              position: 'absolute',
              left: cx - 28,
              top: cy - 28,
              width: 56,
              height: 56,
              borderRadius: '50%',
              border: '2.5px solid rgba(61,92,245,0.7)',
              boxShadow: '0 0 12px 4px rgba(61,92,245,0.25)',
              pointerEvents: 'none',
              zIndex: 200,
              animation: 'pulse 0.6s ease-out',
            }} />
          );
        })()}

        {/* 缩放比例徽标 */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 10,
            background: 'rgba(13,17,23,0.8)',
            borderRadius: 5,
            padding: '2px 7px',
            fontSize: 9.5,
            color: T.textMuted,
            fontFamily: 'JetBrains Mono, monospace',
            fontWeight: 700,
            pointerEvents: 'none',
            backdropFilter: 'blur(4px)',
          }}
        >
          {Math.round(scale * 100)}%
        </div>
      </div>

      {/* 拖拽幽灵预览 */}
      {libDragGhost && (
        <div style={{
          position: 'fixed',
          left: libDragGhost.x - 50,
          top: libDragGhost.y - 20,
          background: 'rgba(61,92,245,0.92)',
          color: 'white',
          borderRadius: 8,
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 700,
          pointerEvents: 'none',
          zIndex: 999,
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px rgba(61,92,245,0.4)',
          transform: 'scale(1.05)',
        }}>
          {libDragGhost.label}
        </div>
      )}

      {/* ── 底部面板 ── */}
      <MobileBottomPanel
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        lib={lib}
        mode={mode}
        locationPath={locationPath}
        allNames={allNames}
        onNew={onNew}
        onAdd={onAdd}
        onAddModule={onAddModule}
        onAddSpecial={onAddSpecial}
        onAddPosition={onAddPosition}
        onEdit={onEdit}
        onEditModule={onEditModule}
        onDragStart={onDragStart}
        onLibTouchStart={handleLibTouchStart}
        onLibTouchMove={handleLibTouchMove}
        onLibTouchEnd={handleLibTouchEnd}
        onSelectLib={(type, id) => {
          onSelectLib?.(type, id);
          setBottomTab('props');
        }}
        onNewModule={onNewModule}
        proj={proj}
        actorNames={actorNames}
        onProjChange={onProjChange}
        sel={sel}
        selNode={selNode}
        selEdge={selEdge}
        selAction={selAction}
        nodes={nodes}
        edges={edges}
        backEdges={backEdges}
        nodeStates={nodeStates}
        actionStore={actionStore}
        onDeleteNode={onDeleteNode}
        onDeleteEdge={onDeleteEdge}
        onCondChange={onCondChange}
        onEditAction={onEditAction}
        libSel={libSel}
      />

      {/* ── 侧边菜单 ── */}
      <MobileSideMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onOpenApiKey={onOpenApiKey}
        onOpenSoul={onOpenSoul}
      />

{/* ── FEM 预览面板 — 直接复用桌面原版，包裹在滑出容器里 ── */}
      {femVisible && (
        <>
          <div
            onClick={() => setFemVisible(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 300 }}
          />
          <div style={{
            position: 'fixed', right: 0, top: 0, bottom: 0,
            width: '88vw', maxWidth: 460,
            background: '#0c1428',
            borderLeft: `1px solid ${T.border}`,
            zIndex: 301,
            display: 'flex', flexDirection: 'column',
            animation: 'slideInFem 0.22s cubic-bezier(0.4,0,0.2,1)',
            boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
          }}>
            <FemPreview
              value={femText}
              onChange={onFemChange}
              error={femError}
              dirty={femDirty}
              onApply={onApplyFem}
              onRestore={onRestoreFem}
              onGraphToFem={onGraphToFem}
            />
          </div>
        </>
      )}

{/* ── 气泡弹层 — 直接复用桌面原版 ── */}
      <BubbleOverlay
        bubbleOverlay={bubbleOverlay}
        nodes={nodes}
        nodeStates={nodeStates}
        actionStore={actionStore}
        onClose={onBubbleClose}
        submitHumanInput={submitHumanInput}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// 共享样式 token（模块内）
// ─────────────────────────────────────────────
const sectionLabel = {
  fontSize: 9.5,
  fontWeight: 800,
  color: T.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontFamily: 'DM Sans, sans-serif',
};

const fieldLabel = {
  fontSize: 10,
  fontWeight: 700,
  color: T.textSecondary,
  marginBottom: 4,
};

const mobInp = {
  width: '100%',
  padding: '6px 9px',
  borderRadius: 6,
  border: `1.5px solid ${T.border}`,
  fontSize: 11.5,
  color: T.textPrimary,
  background: '#0d1117',
  outline: 'none',
  fontFamily: 'DM Sans, sans-serif',
  transition: 'border-color 0.15s',
  boxSizing: 'border-box',
  touchAction: 'auto',
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

const mobBtnP = {
  padding: '6px 14px',
  borderRadius: 6,
  background: T.accent,
  color: 'white',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 700,
  fontFamily: 'DM Sans, sans-serif',
};

const mobBtnS = {
  padding: '5px 12px',
  borderRadius: 6,
  background: 'transparent',
  color: T.textSecondary,
  border: `1.5px solid ${T.border}`,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 600,
  fontFamily: 'DM Sans, sans-serif',
};

const mobBtnDanger = {
  padding: '6px 14px',
  borderRadius: 6,
  background: 'transparent',
  color: T.danger,
  border: `1.5px solid ${T.danger}44`,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 700,
  fontFamily: 'DM Sans, sans-serif',
};

// ─────────────────────────────────────────────
// Hook：检测是否为手机端
// ─────────────────────────────────────────────
function useMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return isMobile;
}

export {
  MobileLayout,
  MobileSideMenu,
  MobileFemPanel,
  MobileBubbleOverlay,
  MobileHumanInput,
  MobileTitleBar,
  MobileBottomPanel,
  useMobileCanvasGesture,
  useMobile,
};
