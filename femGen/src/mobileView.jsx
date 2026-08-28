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
import { ti, inp, btnP, btnS, getNodeSize, applyForLinkage } from './common';
import { LibPanel } from './libPanel';
import { ProjPanel, useModelList, sourceOptions } from './projectPanel';
import { BubbleOverlay } from './bubbleOverlay';
import { FemPreview } from './femPreview';

// ─────────────────────────────────────────────
// 颜色 / 主题 token
// ─────────────────────────────────────────────
const T = {
  bg: 'var(--fem-mobile-bg)',
  surface: 'var(--fem-mobile-surface)',
  surfaceHover: 'var(--fem-mobile-surface-hover)',
  border: 'var(--fem-mobile-border)',
  borderLight: 'var(--fem-mobile-border-light)',
  accent: 'var(--fem-primary)',
  accentGlow: 'var(--fem-primary-glow)',
  textPrimary: 'var(--fem-mobile-text-1)',
  textSecondary: 'var(--fem-text-3)',
  textMuted: 'var(--fem-mobile-text-3)',
  tabActive: 'var(--fem-primary)',
  tabInactive: 'var(--fem-mobile-border)',
  danger: 'var(--fem-danger)',
  success: 'var(--fem-success)',
  warning: 'var(--fem-warning)',
};

// ─────────────────────────────────────────────
// 全局样式注入（仅手机端追加）
// ─────────────────────────────────────────────
const MobileGlobalStyle = () => (
  <style>{`
    /* round44：全局 touch-action:none 是仓库卡片无法滚动的元凶——
       Chrome 从触点向上累积 touch-action，body 的 none 污染整条链。
       画布区自有独立规则（.fem-canvas-zone），此处不再全局禁触。 */
    html, body {
      overscroll-behavior: none;
    }
    /* round50：防拖拽误选只作用于 fem 自己的容器，不再挂 html/body——
       user-select 沿树继承，全局 none 会把 dsh 聊天正文的选择一起杀掉
       （2026-08-28 猫猫报 3081 手机端无法选中 AI/用户消息文字的根因）。
       画布区拖节点/连线的手势保护保留在自身容器上。 */
    .fem-canvas-zone,
    .fem-bottom-scroll {
      user-select: none;
      -webkit-user-select: none;
    }
    /* 画布区禁止浏览器默认触摸行为（拖节点/连线/平移全走自定义手势） */
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
    /* round27：仓库拖拽 ghost 弹出（弹性放大+淡入，只动 opacity/transform） */
    @keyframes ghostPopIn {
      from { opacity: 0; transform: scale(0.7); }
      to   { opacity: 1; transform: scale(1.05); }
    }
    /* round27：ghost 光晕呼吸（只动 box-shadow，与 popIn 属性不相交可同列） */
    @keyframes ghostBreath {
      from { box-shadow: 0 4px 16px var(--fem-primary-glow); }
      to   { box-shadow: 0 6px 26px var(--fem-primary-glow-x); }
    }
    /* round27：画布"可放置"提示浮现 */
    @keyframes dropHintIn {
      from { opacity: 0; transform: scale(0.985); }
      to   { opacity: 1; transform: scale(1); }
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
  onBack,
  onExpand,
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
        borderBottom: `var(--fem-border-w) solid ${T.border}`,
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
            'linear-gradient(90deg,transparent,var(--fem-primary-glow-weak),transparent)',
          pointerEvents: 'none',
          animation: 'scanLine 4s linear infinite',
        }}
      />

      {/* 左侧：插件模式 ←返回（全屏，开 dsh 边栏）/ →全屏（容器内，回沉浸）；独立模式无左侧键 */}
      {onExpand ? (
        <button
          onClick={onExpand}
          aria-label="全屏"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px 10px 6px 2px',
            display: 'flex',
            alignItems: 'center',
            color: T.textSecondary,
            fontSize: 22,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          →
        </button>
      ) : onBack ? (
        <button
          onClick={onBack}
          aria-label="返回"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px 10px 6px 2px',
            display: 'flex',
            alignItems: 'center',
            color: T.textSecondary,
            fontSize: 22,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ←
        </button>
      ) : null}

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
            fontFamily: 'var(--fem-font-sans)',
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
                borderRadius: 'var(--fem-radius-pill)',
                background: statusDot.c,
                display: 'block',
                animation: flowStatus === 'running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 10, color: statusDot.c, fontWeight: 700, fontFamily: 'var(--fem-font-mono)' }}>
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
            borderRadius: 'var(--fem-radius-sm)',
            padding: '4px 8px',
            cursor: 'pointer',
            fontSize: 9.5,
            fontWeight: 800,
            color: femVisible ? 'white' : T.textSecondary,
            fontFamily: 'var(--fem-font-mono)',
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
        border: `var(--fem-border-w) solid ${color}44`,
        borderRadius: 'var(--fem-radius-sm)',
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
          background: 'var(--fem-mask)',
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
          background: 'var(--fem-mobile-bg-2)',
          borderLeft: `var(--fem-border-w) solid ${T.border}`,
          zIndex: 301,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideInFem 0.22s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: '-8px 0 32px var(--fem-mask)',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: '14px 16px 10px',
            borderBottom: 'var(--fem-border-w) solid var(--fem-mobile-border-strong)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--fem-neutral)', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--fem-font-mono)' }}>
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
                background: femDirty ? T.accent : 'var(--fem-tag-bg)',
              }}
            >
              文→图
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'var(--fem-mobile-border-strong)',
                border: 'none',
                borderRadius: 'var(--fem-radius-sm)',
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--fem-neutral)',
                fontSize: 14,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {femError && (
          <div style={{ margin: '8px 12px 0', padding: '6px 10px', background: 'var(--fem-mobile-danger-soft)', border: 'var(--fem-border-w) solid var(--fem-mobile-danger-border)', borderRadius: 'var(--fem-radius-sm)', fontSize: 10, color: 'var(--fem-danger-weak)', lineHeight: 1.5 }}>
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
            fontFamily: 'var(--fem-font-mono)',
            fontSize: 10.5,
            lineHeight: 1.8,
            color: 'var(--fem-mobile-text-2-alt)',
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
  { id: 'settings', label: '设置' },
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
  // round49：四个触摸处理器全部面板级（挂在滚动容器上），落点无关——
  // touchstart 用 closest('[data-fem-lib-drag]') 找拖拽目标；move/end 负责仲裁与拖拽。
  onPanelTouchStart,
  onLibTouchMove,
  onLibTouchEnd,
  onLibTouchCancel = null,
  libArmedKey, // round27：长按激活拖拽的条目 key（点亮被按卡片）
  htmlDraggable = false, // 手机端恒 false——draggable 卡片阻止触摸滚动
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
  // Settings（设置 tab：主题切换 + 新建 SOUL）
  themeName,
  onCycleTheme,
  onOpenSoul,
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
    if (scrollRef.current) scrollRef.current.scrollTop = 0;  }, [activeTab]);

  // round46/49：仓库触摸四事件全挂**原生**监听——React 根级委派是 passive 的，
  // armed 状态的 preventDefault 在那里无效。touchstart 用 passive:true（我们从不
  // 在 start 阶段拦截，主动向 WebKit 声明"不挡滚动"，换取最快滚动启动路径）；
  // move/end 保持非 passive（armed 拖拽需要 preventDefault）。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onLibTouchMove || !onLibTouchEnd) return;
    if (onPanelTouchStart) el.addEventListener('touchstart', onPanelTouchStart, { passive: true });
    el.addEventListener('touchmove', onLibTouchMove, { passive: false });
    el.addEventListener('touchend', onLibTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onLibTouchCancel || (() => {}), { passive: true });
    return () => {
      if (onPanelTouchStart) el.removeEventListener('touchstart', onPanelTouchStart);
      el.removeEventListener('touchmove', onLibTouchMove);
      el.removeEventListener('touchend', onLibTouchEnd);
      el.removeEventListener('touchcancel', onLibTouchCancel || (() => {}));
    };
  }, [onPanelTouchStart, onLibTouchMove, onLibTouchEnd, onLibTouchCancel]);

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
        borderTop: `var(--fem-border-w) solid ${T.border}`,
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
            borderRadius: 'var(--fem-radius-xs)',
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
          borderBottom: `var(--fem-border-w) solid ${T.border}`,
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
              borderBottom: activeTab === t.id ? `var(--fem-border-w-selected) solid ${T.accent}` : 'var(--fem-border-w-selected) solid transparent',
              padding: '7px 0',
              fontSize: 11.5,
              fontWeight: activeTab === t.id ? 800 : 500,
              color: activeTab === t.id ? T.accent : T.textMuted,
              cursor: 'pointer',
              fontFamily: 'var(--fem-font-sans)',
              letterSpacing: '0.02em',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {t.label}
            {t.id === 'props' && (sel || libSel) && (
              <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 'var(--fem-radius-pill)', background: T.accent, marginLeft: 4, verticalAlign: 'middle' }} />
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
          color: 'var(--fem-text-1)',
          background: 'transparent', /* round12/15：去掉圆角卡片底，融入壳背景 */
        }}
      >
        {activeTab === 'library' && (
          <LibPanel
            cardLayout="grid3"
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
            armedKey={libArmedKey}
            htmlDraggable={htmlDraggable}
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
        {activeTab === 'settings' && (
          <div>
            <div style={sectionLabel}>设置</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                onClick={onCycleTheme}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  padding: '7px 12px', borderRadius: 'var(--fem-radius-md)',
                  fontSize: 12, fontWeight: 600,
                  fontFamily: 'var(--fem-font-sans)',
                  cursor: 'pointer',
                  border: 'var(--fem-border-w) solid var(--fem-border-strong)',
                  background: 'var(--fem-bg)',
                  color: 'var(--fem-text-2)',
                  flex: '0 0 auto',
                }}
              >
                🎨 {themeName}
              </button>
              <button
                onClick={onOpenSoul}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '7px 12px', borderRadius: 'var(--fem-radius-md)',
                  fontSize: 12, fontWeight: 600,
                  fontFamily: 'var(--fem-font-sans)',
                  cursor: 'pointer',
                  border: 'var(--fem-border-w) solid var(--fem-border-strong)',
                  background: 'var(--fem-bg)',
                  color: 'var(--fem-text-2)',
                  flex: 1,
                }}
              >
                新建 SOUL
              </button>
            </div>
          </div>
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
          { t: 'FOR', c: 'var(--fem-primary-strong)' },
          { t: 'PAR', c: 'var(--fem-special-par)' },
          { t: 'END', c: 'var(--fem-danger)' },
        ]
      : [
          { t: 'FOR', c: 'var(--fem-primary-strong)' },
          { t: 'PAR', c: 'var(--fem-special-par)' },
          { t: 'BREAK', c: 'var(--fem-warning)' },
          { t: 'OUT', c: 'var(--fem-danger)' },
        ];

  return (
    <div>
      {/* Actions 行 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={sectionLabel}>Actions</span>
        <button onClick={onNew} style={{ ...mobBtnP, padding: '3px 10px', fontSize: 10 }}>+ 新建</button>
      </div>
      <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, WebkitOverflowScrolling: 'touch', touchAction: 'pan-x' }}>
        {displayActions.length === 0 ? (
          <div style={{ fontSize: 11, color: T.textMuted, padding: '4px 0' }}>暂无 Action</div>
        ) : displayActions.map((a) => {
          const { c, bg } = ti(a.executorType);
          return (
            <div
              key={a.id}
              onClick={() => onSelectLib?.('action', a.id)}
              style={{
                background: 'var(--fem-node-bg)',
                borderRadius: 'var(--fem-radius-md)',
                border: `var(--fem-node-border-w) solid var(--fem-node-border)`,
                borderLeft: `var(--fem-border-w-accent) solid ${c}`,
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
                <span style={{ fontSize: 9.5, fontWeight: 700, color: c, fontFamily: 'var(--fem-font-mono)' }}>@{a.executorType}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onAdd(a); }}
                  style={{ background: 'var(--fem-btn-primary)', border: 'none', borderRadius: 'var(--fem-radius-sm)', color: 'var(--fem-on-accent)', fontSize: 9, fontWeight: 700, padding: '1px 6px', cursor: 'pointer' }}
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
          <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, touchAction: 'pan-x' }}>
            {displayModules.map((m) => (
              <div
                key={m.id}
                onClick={() => onSelectLib?.('module', m.id)}
                style={{
                  background: 'var(--fem-node-bg)',
                  borderRadius: 'var(--fem-radius-md)',
                  border: `var(--fem-node-border-w) solid var(--fem-node-border)`,
                  borderLeft: 'var(--fem-border-w-accent) solid var(--fem-tag-bg)',
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
                    style={{ background: 'var(--fem-btn-primary)', border: 'none', borderRadius: 'var(--fem-radius-sm)', color: 'var(--fem-on-accent)', fontSize: 9, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', flex: 1 }}
                  >
                    +画布
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onEditModule?.(m); }}
                    style={{ background: 'var(--fem-primary)', border: 'none', borderRadius: 'var(--fem-radius-sm)', color: 'var(--fem-on-accent)', fontSize: 9, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', flex: 1 }}
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
          {specialNodes.map((s) => {
            const spKey = { START: 'start', IN: 'start', END: 'end', OUT: 'end', BREAK: 'break', FOR: 'for', PAR: 'par' }[s.t] || 'for';
            return (
              <button
                key={s.t}
                onClick={() => onAddSpecial(s.t)}
                style={{
                  background: `var(--fem-sp-${spKey}-bg)`,
                  border: `var(--fem-border-w) solid color-mix(in srgb, ${s.c} 50%, var(--fem-node-bg))`,
                  borderRadius: 'var(--fem-radius-sm)',
                  padding: '4px 10px',
                  fontSize: 10.5,
                  fontWeight: 800,
                  color: s.c,
                  cursor: 'pointer',
                  fontFamily: 'var(--fem-font-mono)',
                }}
              >
                [{s.t}]
              </button>
            );
          })}
          <button
            onClick={onAddPosition}
            style={{
              background: 'var(--fem-neutral-faint)',
              border: 'var(--fem-border-w) solid var(--fem-neutral-border)',
              borderRadius: 'var(--fem-radius-sm)',
              padding: '4px 10px',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--fem-neutral)',
              cursor: 'pointer',
              fontFamily: 'var(--fem-font-mono)',
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
  // dsh 可用模型列表（source 下拉数据源）
  const [models, modelErr] = useModelList();
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
          onClick={() => u({ actors: [...(proj.actors || []), { name: '', type: 'ai', soul: '', source: '', tools: [] }] })}
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
            {a.type === 'ai' && models ? (
              <select
                value={a.source || ''}
                onChange={(e) => upd({ source: e.target.value })}
                style={{ ...mobInp, flex: 1, fontSize: 10 }}
              >
                {sourceOptions(models, a.source).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={a.source}
                onChange={(e) => upd({ source: e.target.value })}
                placeholder={a.type === 'ai' ? (modelErr || 'deepseek') : '数字ID'}
                style={{ ...mobInp, flex: 1, fontSize: 11 }}
              />
            )}
            <button onClick={() => u({ actors: proj.actors.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', color: 'var(--fem-danger-weak)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 2 }}>×</button>
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
          <button onClick={() => u({ vars: proj.vars.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', color: 'var(--fem-danger-weak)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 2 }}>×</button>
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
    const { c } = action ? ti(action.executorType) : { c: 'var(--fem-neutral)' };
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
          {action && (
            <span style={{ background: `var(--fem-badge-bg-${['ai','human','mind','func','assign'].includes(action.executorType) ? action.executorType : 'ai'})`, color: `var(--fem-badge-fg-${['ai','human','mind','func','assign'].includes(action.executorType) ? action.executorType : 'ai'})`, borderRadius: 'var(--fem-radius-sm)', padding: '2px 7px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--fem-font-mono)' }}>
              @{action.executorType}
            </span>
          )}
          <span style={{ fontSize: 13.5, fontWeight: 800, color: T.textPrimary }}>{action?.name || selNode.specialType || selNode.label || '节点'}</span>
        </div>
        {selNode.label && <MobPropRow k="节点名" v={String(selNode.label).replace(/[\[\]]/g, '')} />}
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
        {isBack && <div style={{ fontSize: 10, color: 'var(--fem-primary-strong)', fontWeight: 700, background: 'var(--fem-primary-soft-faint)', borderRadius: 'var(--fem-radius-sm)', padding: '3px 7px', marginBottom: 6 }}>回环检测</div>}
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
      <span style={{ color: T.textPrimary, fontFamily: 'var(--fem-font-mono)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
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
  // mind 节点按运行时 node_type 判断（node_start 事件写入 ns.type）：
  // 执行者运行时才确定（可能是变量赋值），静态 executorType 无法预判；
  // 未运行（ns.type 空）时回退到静态 executorType。
  const runType = ns.type || action?.executorType;
  const isAI = runType === 'ai';
  const isHuman = runType === 'human';
  const isStreaming = ns.status === 'ai_streaming';
  const { c } = ti(action?.executorType) || { c: 'var(--fem-neutral)' };
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
        style={{ position: 'fixed', inset: 0, background: 'var(--fem-mask-heavy)', zIndex: 500, animation: 'fadeInOverlay 0.18s ease' }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(92vw, 460px)',
          maxHeight: '78vh',
          background: 'var(--fem-surface)',
          borderRadius: 'var(--fem-radius-xl)',
          boxShadow: '0 24px 64px var(--fem-mask-soft)',
          border: `var(--fem-border-w-selected) solid ${c}`,
          fontFamily: 'var(--fem-font-sans)',
          zIndex: 501,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'popIn 0.2s cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        {/* 头部 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: 'var(--fem-border-w) solid var(--fem-border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ background: c + '18', color: c, borderRadius: 'var(--fem-radius-sm)', padding: '2px 7px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--fem-font-mono)' }}>
              @{action?.executorType || '?'}
            </span>
            <span style={{ fontWeight: 800, color: 'var(--fem-text-1)', fontSize: 15 }}>{action?.name || 'Node'}</span>
          </div>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ background: 'var(--fem-bg-2)', border: 'none', fontSize: 15, cursor: 'pointer', color: 'var(--fem-text-2-alt)', borderRadius: 'var(--fem-radius-md)', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* 内容 */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', lineHeight: 1.65, fontSize: 13, color: 'var(--fem-text-1)', touchAction: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {ns.context && <div style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{ns.context}</div>}
          {ns.showprompt && (
            <div style={{ marginBottom: 10, background: 'var(--fem-bg)', padding: '8px 10px', borderRadius: 'var(--fem-radius-md)' }}>
              <div style={{ fontWeight: 700, color: 'var(--fem-text-3)', marginBottom: 3, fontSize: 10.5 }}>[节点提示]</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.showprompt}</div>
            </div>
          )}
          {isHuman && ns.prompt && (
            <div style={{ marginBottom: 10, background: 'var(--fem-bg)', padding: '8px 10px', borderRadius: 'var(--fem-radius-md)' }}>
              <div style={{ fontWeight: 700, color: 'var(--fem-text-3)', marginBottom: 3, fontSize: 10.5 }}>[提示]</div>
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
    <div style={{ flexShrink: 0, padding: '10px 14px 16px', borderTop: 'var(--fem-border-w) solid var(--fem-border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--fem-warning)', marginBottom: 6 }}>⏳ 等待人类输入</div>
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
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--fem-text-3)', fontFamily: 'var(--fem-font-mono)' }}>{varName}:</span>
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
// ── round49 仓库触摸仲裁 v2 常量：落点不参与裁决，只认位移与静止 ──
const LIB_LONG_PRESS_MS = 300;    // 长按武装时限（比画布略长，区分"点选"与"拖"意图）
const LIB_SCROLL_COMMIT_PX = 8;   // 位移防抖阈值：任一轴累计 ≥8px → 永判滚动，本手势绝不再拦截
const LIB_DRAG_SLOP_PX = 4;       // 武装允许的累计漂移上限
const LIB_STILL_MS = 120;         // 武装前要求最近 N ms 完全没动——慢速滚动必然被拒，根治"滑着滑着被劫持"
const LIB_ARM_RECHECK_MS = 150;   // 未达静止条件的顺延复查间隔
const LIB_ARM_MAX_WAIT_MS = 900;  // 顺延武装总上限（超时放弃，交还原生滚动）
const MOVE_THRESHOLD = 5;
const NODE_TOUCH_PAD = 12;     // 画布节点命中判定外扩（屏幕像素）——小节点更好碰

function useMobileCanvasGesture({
  cvRef, pan, setPan, scale, setScale,
  handlePortDown, handlePortUp, setConn,
  nodes, setNodes, setDrag, setSel,
  onBubbleClick,
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

  // DOM hit-test：找节点体、端口、连线热区或运行时小气泡
  const hitTest = (cx, cy) => {
    const el = document.elementFromPoint(cx, cy);
    if (el) {
      const portEl = el.closest('[data-port-node]');
      if (portEl) return {
        type: 'port',
        nodeId: portEl.dataset.portNode,
        portDir: portEl.dataset.portDir || 'right',
        portX: portEl.dataset.portX ? parseFloat(portEl.dataset.portX) : undefined,
        portY: portEl.dataset.portY ? parseFloat(portEl.dataset.portY) : undefined,
      };
      // 运行时小气泡（节点上方）——须在 node 之前判（气泡是节点的 DOM 后代，closest 都会命中 node-id）
      const bubbleEl = el.closest('[data-bubble-node]');
      if (bubbleEl) return { type: 'bubble', nodeId: bubbleEl.dataset.bubbleNode };
      const nodeEl = el.closest('[data-node-id]');
      if (nodeEl) return { type: 'node', nodeId: nodeEl.dataset.nodeId };
      // round26：连线热区路径带 data-edge-id，手机端点边不再依赖合成 click
      const edgeEl = el.closest('[data-edge-id]');
      if (edgeEl) return { type: 'edge', id: edgeEl.dataset.edgeId };
    }
    // round25：扩大命中——节点矩形外扩 NODE_TOUCH_PAD（屏幕像素转画布坐标），小节点更好碰
    const rect = cvRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const s = scaleRef.current || 1;
    const p = panRef.current;
    const wx = (cx - rect.left - p.x) / s;
    const wy = (cy - rect.top - p.y) / s;
    const pad = NODE_TOUCH_PAD / s;
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i];
      const { w, h } = getNodeSize(n);
      if (wx >= n.x - pad && wx <= n.x + w + pad && wy >= n.y - pad && wy <= n.y + h + pad) {
        return { type: 'node', nodeId: n.id };
      }
    }
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

      if (hit?.type === 'port') {
        stateRef.current = { phase: 'conn', srcNodeId: hit.nodeId };
        navigator.vibrate?.(12);
        handlePortDown(fakeEv(cx, cy), hit.nodeId, hit.portDir, hit.portX, hit.portY);

      // 长按在节点体或其小气泡上 = 拖动该节点（气泡视觉上属于节点，桌面端按住气泡同样触发节点拖拽）
      } else if (hit?.type === 'node' || hit?.type === 'bubble') {
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

    // 节点拖拽：直接算 delta，调 setNodes（FOR↔for_out 联动与桌面端共用一份定义）
    if (phase === 'nodeDrag') {
      setDragReady(null);
      const s  = stateRef.current;
      const sc = scaleRef.current;
      const newX = s.startNx + (t.clientX - s.startCx) / sc;
      const newY = s.startNy + (t.clientY - s.startCy) / sc;
      setNodes(prev => {
        const draggedNode = prev.find(n => n.id === s.nodeId);
        if (!draggedNode) return prev;
        return applyForLinkage(prev, draggedNode, newX, newY);
      });
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

    // 连线结束：在抬起处 hit-test 找目标节点
    if (phase === 'conn' && t) {
      const hit = hitTest(t.clientX, t.clientY);
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

    // pending 抬手 = 短按（点击）：开气泡 / 选中节点/连线 / 取消选中
    if (phase === 'pending' && t) {
      clearTimer();
      const hit = hitTest(t.clientX, t.clientY);
      if (hit?.type === 'bubble') {
        // 轻点运行时小气泡 = 打开气泡弹层（对齐桌面端 onClick→onBubbleClick；不改 sel，与桌面一致）
        onBubbleClick?.(hit.nodeId);
      } else if (hit?.type === 'node') {
        setSel({ type: 'node', id: hit.nodeId });
      } else if (hit?.type === 'edge') {
        setSel({ type: 'edge', id: hit.id });
      } else {
        setSel(null);
      }
    }

    stateRef.current = remaining.length === 0
      ? { phase: 'idle' }
      : { phase: 'canvasPan', cx: remaining[0].clientX, cy: remaining[0].clientY };
  }, [handlePortUp, setConn, setDrag, setSel, onBubbleClick]);

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
  // Theme
  theme = 'dsh',
  // 全屏层（插件模式手机端全屏沉浸用）：fixedMode=false 时降级为容器内 absolute
  zIndex,
  fixedMode = true,
  // 返回键（插件模式：打开 dsh 边栏；独立模式不传）
  onBack,
  // 全屏键（插件模式容器内态：回全屏沉浸；独立模式不传）
  onExpand,
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
  onBubbleClick,
  // FEM
  femText, onFemChange, femError, femDirty,
  onApplyFem, onRestoreFem, onGraphToFem,
  // Modals
  onOpenSoul,
  // 设置（设置 tab：主题切换 + 新建 SOUL）
  themeName, onCycleTheme,
  // Selection helpers
  backEdges,
  onDeleteNode, onDeleteEdge, onCondChange, onEditAction,
}) {
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
    onBubbleClick,
  });
  // ── 从仓库触摸拖拽放置节点（round49 仲裁 v2：落点不参与裁决） ──
  // 手势状态机：pending →（任一轴累计 ≥8px）scroll：彻底放手给原生 pan-y，绝不再拦截
  //                    →（静止满 300ms：累计 ≤4px 且最近 120ms 无位移）drag：preventDefault 拖 ghost
  // 落点仅用于 touchstart 时 closest('[data-fem-lib-drag]') 找"拖哪个"；
  // 空白处/输入框/按钮落点连计时器都不启动，行为与纯原生滚动完全一致。
  // 根因注记（v1 卡死）：旧版按落点逐卡挂监听，300ms 内位移 ≤4px 即武装——轻缓起手的
  // 滚动被误判成长按，armed 后 preventDefault 把进行中的原生滚动当场掐死（列表冻结）。
  const libDragRef = useRef(null); // { phase:'pending'|'drag', type, item, startX, startY, lastX, lastY, lastMoveAt, bornAt }
  const libTimerRef = useRef(null);
  // round47：ghost 改为 **ref 直写 DOM**——touchmove 里 setState 会重渲染
  // 整棵编辑器树（主线程卡死，WebKit 来不及启动滚动=卡片滑不动的重要共犯）。
  // 只有"armed 开关"保留 state 变更（驱动画布放置提示 + 抓起卡片高亮）。
  const [libDragActive, setLibDragActive] = useState(false);
  const ghostRef = useRef(null);
  const ghostLabelRef = useRef(null);
  // round27：长按激活视觉反馈——当前被抓起条目的 key（"type:id"），null=无。
  // 激活瞬间 set，touchEnd/取消清；透传 LibPanel 点亮被按卡片 + 画布浮现可放置提示。
  const [libArmedKey, setLibArmedKey] = useState(null);
  // round49：item 对象经 ref 解析（lib 数组常变，避免闭包陈旧）
  const libRef = useRef(lib);
  useEffect(() => { libRef.current = lib; }, [lib]);

  // 面板级 touchstart（passive，绝不 preventDefault）：
  // 找拖拽候选并启动长按武装计时；非候选落点零干预。
  const handlePanelTouchStart = useCallback((e) => {
    if (libDragRef.current) return; // 已有手势在途（多指），不覆盖
    const t = e.touches[0];
    if (!t || !t.target) return;
    // 打字/按钮落点：与拖拽无关，保持纯原生行为
    if (t.target.closest && t.target.closest('input, textarea, select, button')) return;
    const card = t.target.closest ? t.target.closest('[data-fem-lib-drag]') : null;
    if (!card) return; // 空白处：无候选，纯滚动路径
    const raw = card.getAttribute('data-fem-lib-drag') || '';
    const sep = raw.indexOf(':');
    if (sep <= 0) return;
    const type = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    let item = null;
    if (type === 'action') item = (libRef.current?.actions || []).find((x) => x.id === id);
    else if (type === 'module') item = (libRef.current?.modules || []).find((x) => x.id === id);
    else if (type === 'special' || type === 'position') item = id; // 特殊节点/POSITION 的 item 是字符串
    if (!item) return;
    clearTimeout(libTimerRef.current);
    libDragRef.current = {
      phase: 'pending', type, item,
      startX: t.clientX, startY: t.clientY,
      lastX: t.clientX, lastY: t.clientY,
      lastMoveAt: performance.now(), bornAt: performance.now(),
    };
    // 长按武装判定（可顺延）：到点复核"漂移小 + 最近确实没动"，慢速滚动会被正确拒绝
    const tryArm = () => {
      const st = libDragRef.current;
      if (!st || st.phase !== 'pending') return;
      const now = performance.now();
      const driftX = Math.abs(st.lastX - st.startX);
      const driftY = Math.abs(st.lastY - st.startY);
      const stillLongEnough = now - st.lastMoveAt >= LIB_STILL_MS;
      if (driftX > LIB_DRAG_SLOP_PX || driftY > LIB_DRAG_SLOP_PX || !stillLongEnough) {
        if (now - st.bornAt < LIB_ARM_MAX_WAIT_MS) {
          libTimerRef.current = setTimeout(tryArm, LIB_ARM_RECHECK_MS);
        } else {
          libDragRef.current = null; // 放弃武装，交还原生滚动（本手势不再有拖拽）
        }
        return;
      }
      st.phase = 'drag';
      navigator.vibrate?.(15); // iOS Safari 不支持 vibrate；iPhone 靠下方视觉反馈
      const label = typeof st.item === 'string' ? st.item : (st.item?.name || st.type);
      setLibArmedKey(`${st.type}:${typeof st.item === 'string' ? st.item : st.item?.id}`);
      setLibDragActive(true); // round49：补回 round47 丢失的调用——画布虚线放置提示恢复
      if (ghostRef.current && ghostLabelRef.current) {
        ghostLabelRef.current.textContent = label;
        ghostRef.current.style.display = 'block';
        ghostRef.current.style.left = `${st.startX - 50}px`;
        ghostRef.current.style.top = `${st.startY - 20}px`;
      }
    };
    libTimerRef.current = setTimeout(tryArm, LIB_LONG_PRESS_MS);
  }, []);

  // 面板级 touchmove（非 passive）：
  // drag 相位才 preventDefault；pending 相位只记账，≥8px 即承诺滚动并永久放手。
  const handleLibTouchMove = useCallback((e) => {
    const st = libDragRef.current;
    if (!st) return;
    const t = e.touches[0];
    if (st.phase === 'drag') {
      e.preventDefault();
      e.stopPropagation();
      if (ghostRef.current) {
        ghostRef.current.style.left = `${t.clientX - 50}px`;
        ghostRef.current.style.top = `${t.clientY - 20}px`;
      }
      return;
    }
    // pending：零拦截记账。任一轴累计 ≥LIB_SCROLL_COMMIT_PX → 判滚动意图，
    // 清掉一切拖拽状态，本手势剩余时间与原生 pan-y 完全无关。
    st.lastX = t.clientX; st.lastY = t.clientY;
    st.lastMoveAt = performance.now();
    const dx = Math.abs(t.clientX - st.startX);
    const dy = Math.abs(t.clientY - st.startY);
    if (dx >= LIB_SCROLL_COMMIT_PX || dy >= LIB_SCROLL_COMMIT_PX) {
      clearTimeout(libTimerRef.current);
      libDragRef.current = null;
    }
  }, []);

  const handleLibTouchCancel = useCallback((e) => {
    // 浏览器接管手势（原生滚动/系统语义），JS 事件流到此终止——全量复位
    clearTimeout(libTimerRef.current);
    if (ghostRef.current) ghostRef.current.style.display = 'none';
    setLibArmedKey(null);
    setLibDragActive(false);
    libDragRef.current = null;
  }, []);

  const handleLibTouchEnd = useCallback((e) => {
    clearTimeout(libTimerRef.current);
    setLibArmedKey(null); // 无论放置/取消，抓起态视觉必须回落
    setLibDragActive(false);
    if (ghostRef.current) ghostRef.current.style.display = 'none';
    const st = libDragRef.current;
    libDragRef.current = null;
    if (!st || st.phase !== 'drag') return;
    const t = e.changedTouches[0];
    // 判断落点是否在画布区域内
    const cvRect = cvRef.current?.getBoundingClientRect();
    if (!cvRect) return;
    if (t.clientX < cvRect.left || t.clientX > cvRect.right || t.clientY < cvRect.top || t.clientY > cvRect.bottom) {
      return;
    }
    // 转换为画布世界坐标
    const worldX = (t.clientX - cvRect.left - pan.x) / scale - 50;
    const worldY = (t.clientY - cvRect.top  - pan.y) / scale - 20;
    const { type, item } = st;
    if (type === 'action') onAdd(item, worldX, worldY);
    else if (type === 'module') onAddModule(item, worldX, worldY);
    else if (type === 'special') onAddSpecial(item, worldX, worldY);  // item 此时是字符串如 'OUT'
    else if (type === 'position') onAddPosition(worldX, worldY);       // position 不需要 item
  }, [pan, scale, cvRef, onAdd, onAddModule, onAddSpecial, onAddPosition]);

  // 当前选中实体
  const selNode = sel?.type === 'node' ? nodes.find((n) => n.id === sel.id) : null;
  const selEdge = sel?.type === 'edge' ? edges.find((e) => e.id === sel.id) : null;
  const selAction = selNode?.type === 'action' ? actionStore?.find((a) => a.id === selNode.actionId) : null;

  return (
    <div
      data-fem-theme={theme}
      style={{
        position: fixedMode ? 'fixed' : 'absolute',
        inset: 0,
        zIndex: zIndex,
        display: 'flex',
        flexDirection: 'column',
        background: T.bg,
        fontFamily: 'var(--fem-font-sans)',
        overflow: 'hidden',
      }}
    >
      <MobileGlobalStyle />

      {/* ── 标题栏 ── */}
      <MobileTitleBar
        projName={proj?.name}
        flowStatus={flowStatus}
        femVisible={femVisible}
        onBack={fixedMode ? onBack : undefined}
        onExpand={fixedMode ? undefined : onExpand}
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
          backgroundImage: 'var(--fem-mobile-canvas-dots)',
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
            <div style={{ fontSize: 13, color: 'var(--fem-mobile-border-light)', fontWeight: 600 }}>从仓库添加 Action</div>
            <div style={{ fontSize: 11, color: 'var(--fem-mobile-border)', marginTop: 5 }}>长按节点拖动 · 长按端口连线 · 双指缩放</div>
          </div>
        )}

        {/* round27：仓库拖拽激活中——画布浮现虚线可放置提示 + 顶部胶囊 */}
        {libDragActive && (
          <>
            <div style={{
              position: 'absolute',
              inset: 8,
              borderRadius: 'var(--fem-radius-lg)',
              border: 'var(--fem-border-w-selected) dashed var(--fem-primary-glow-x)',
              background: 'var(--fem-primary-soft-faint)',
              pointerEvents: 'none',
              zIndex: 150,
              animation: 'dropHintIn 0.22s ease-out',
            }} />
            <div style={{
              position: 'absolute',
              top: 18,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--fem-primary-overlay)',
              color: 'var(--fem-on-accent)',
              padding: '3px 11px',
              borderRadius: 'var(--fem-radius-md)',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.02em',
              pointerEvents: 'none',
              zIndex: 151,
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 14px var(--fem-primary-glow-strong)',
              animation: 'dropHintIn 0.25s ease-out',
            }}>
              松手放置到画布
            </div>
          </>
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
              borderRadius: 'var(--fem-radius-pill)',
              border: 'var(--fem-border-w-selected) solid var(--fem-primary-glow-x)',
              boxShadow: '0 0 12px 4px var(--fem-primary-glow)',
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
            background: 'var(--fem-mobile-mask)',
            borderRadius: 'var(--fem-radius-sm)',
            padding: '2px 7px',
            fontSize: 9.5,
            color: T.textMuted,
            fontFamily: 'var(--fem-font-mono)',
            fontWeight: 700,
            pointerEvents: 'none',
            backdropFilter: 'blur(4px)',
          }}
        >
          {Math.round(scale * 100)}%
        </div>
      </div>

      {/* 拖拽幽灵预览（round27：弹出动画 + 光晕呼吸，明确"已激活"）——round47 改常驻+ref 直写 */}
      <div
        ref={ghostRef}
        style={{
          display: 'none',
          position: 'fixed',
          background: 'var(--fem-primary-overlay)',
          color: 'var(--fem-on-accent)',
          borderRadius: 'var(--fem-radius-md)',
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 700,
          pointerEvents: 'none',
          zIndex: 999,
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px var(--fem-primary-glow-strong)',
        }}
      >
        <span ref={ghostLabelRef} />
      </div>

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
        onPanelTouchStart={handlePanelTouchStart}
        onLibTouchMove={handleLibTouchMove}
        onLibTouchEnd={handleLibTouchEnd}
        onLibTouchCancel={handleLibTouchCancel}
        libArmedKey={libArmedKey}
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
        themeName={themeName}
        onCycleTheme={onCycleTheme}
        onOpenSoul={onOpenSoul}
        htmlDraggable={false}
      />

      {/* ── FEM 预览面板 — 直接复用桌面原版，包裹在滑出容器里 ── */}
      {femVisible && (
        <>
          <div
            onClick={() => setFemVisible(false)}
            style={{ position: 'fixed', inset: 0, background: 'var(--fem-mask)', zIndex: 300 }}
          />
          <div style={{
            position: 'fixed', right: 0, top: 0, bottom: 0,
            width: '88vw', maxWidth: 460,
            background: 'var(--fem-mobile-bg-2)',
            borderLeft: `var(--fem-border-w) solid ${T.border}`,
            zIndex: 301,
            display: 'flex', flexDirection: 'column',
            animation: 'slideInFem 0.22s cubic-bezier(0.4,0,0.2,1)',
            boxShadow: '-8px 0 32px var(--fem-mask)',
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
  fontFamily: 'var(--fem-font-sans)',
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
  borderRadius: 'var(--fem-radius-sm)',
  border: `var(--fem-border-w-strong) solid ${T.border}`,
  fontSize: 11.5,
  color: T.textPrimary,
  background: 'var(--fem-mobile-bg)',
  outline: 'none',
  fontFamily: 'var(--fem-font-sans)',
  transition: 'border-color 0.15s',
  boxSizing: 'border-box',
  touchAction: 'auto',
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

const mobBtnP = {
  padding: '6px 14px',
  borderRadius: 'var(--fem-radius-sm)',
  background: 'var(--fem-btn-primary)',
  color: 'var(--fem-on-accent)',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 700,
  fontFamily: 'var(--fem-font-sans)',
};

const mobBtnS = {
  padding: '5px 12px',
  borderRadius: 'var(--fem-radius-sm)',
  background: 'transparent',
  color: T.textSecondary,
  border: `var(--fem-border-w-strong) solid ${T.border}`,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 600,
  fontFamily: 'var(--fem-font-sans)',
};

const mobBtnDanger = {
  padding: '6px 14px',
  borderRadius: 'var(--fem-radius-sm)',
  background: 'transparent',
  color: T.danger,
  border: `var(--fem-border-w-strong) solid ${T.danger}44`,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 700,
  fontFamily: 'var(--fem-font-sans)',
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
  MobileFemPanel,
  MobileBubbleOverlay,
  MobileHumanInput,
  MobileTitleBar,
  MobileBottomPanel,
  useMobileCanvasGesture,
  useMobile,
};
