// ═══════════════════════════════════════════════════════════════
// ═══ canvasNodes.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React from 'react';
import { PortCircle, TYPES, SPECIAL_COLORS, NW, NH, MW, MH, SPW, SPH, PSW, PSH, ti, SINK_ONLY, getNodeSize } from './common';


function ActionNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
  onDbl,
  onBubbleClick,
  nodeState,
  isActive,
  errorNodeIds,
}) {
  const isMod = node.type === 'module';
  const w = isMod ? MW : NW,
    h = isMod ? MH : NH;
  const { c, bg } = isMod
    ? { c: '#475569', bg: '#f1f5f9' }
    : ti(node.action?.executorType);
  const border = sel ? c : '#e4ecf7';

  // 是否显示气泡：有 nodeState（运行中或已完成）时显示
  //console.log(
  //  `[ActionNodeView] node.id="${node.id}" node.label="${node.label}" node.type="${node.type}" nodeState=`,
  //  nodeState
  //);
  const hasState = !!nodeState?.status;
  const isStreaming = nodeState?.status === 'ai_streaming';
  const isHumanWait = nodeState?.status === 'human_wait';
  const isDone = ['ai_done', 'human_done', 'done'].includes(nodeState?.status);

  const ports = {
    top: { x: w / 2, y: 0 },
    bottom: { x: w / 2, y: h },
    left: { x: 0, y: h / 2 },
    right: { x: w, y: h / 2 },
  };

  // 呼吸灯动画样式
  const isErrorExplicit = errorNodeIds?.has(node.id) ?? false;
  const isError = nodeState?.status === 'error' || isErrorExplicit;
  const glowStyle = (isActive || isError)
    ? {
        animation: isError
          ? 'nodeGlowError 1.5s ease-in-out infinite'
          : 'nodeGlow 1.5s ease-in-out infinite',
      }
    : {};

  return (
<div
      data-node-id={node.id}
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      onDoubleClick={onDbl}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: 'white',
        borderRadius: 10,
        borderTop: `1.5px solid ${border}`,
        borderRight: `1.5px solid ${border}`,
        borderBottom: `1.5px solid ${border}`,
        borderLeft: `4px solid ${c}`,
        boxShadow: sel
          ? `0 0 0 3px ${c}22, 0 8px 24px rgba(0,0,0,0.1)`
          : '0 2px 10px rgba(20,40,90,0.07)',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        fontFamily: 'DM Sans, sans-serif',
        ...glowStyle,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -11,
          left: 10,
          background: c,
          color: 'white',
          borderRadius: 5,
          padding: '1px 7px',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.05em',
          fontFamily: 'JetBrains Mono, monospace',
          whiteSpace: 'nowrap',
        }}
      >
        {node.label}
      </div>

      <div style={{ padding: '14px 14px 10px' }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: '#1b2540',
            marginBottom: 5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isMod
            ? `&${node.modRef || 'Module'}`
            : node.action?.name || '未命名'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              background: bg,
              color: c,
              border: `1px solid ${c}28`,
              borderRadius: 4,
              padding: '1px 6px',
              fontSize: 10.5,
              fontWeight: 700,
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {isMod
              ? 'module'
              : node.action?.executorType
              ? `@${node.action.executorType}`
              : '?'}
          </span>
          {!isMod && node.action?.executorActor && (
            <span
              style={{
                fontSize: 10.5,
                color: '#94a3b8',
                fontFamily: 'JetBrains Mono, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {node.action.executorActor}
            </span>
          )}
        </div>
      </div>







      {/* 小气泡 - 有状态时自动显示，运行完不消失 */}
      {hasState && node.type === 'action' && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onBubbleClick && onBubbleClick(node.id);
          }}
          style={{
            position: 'absolute',
            top: -28,
            right: -8,
            maxWidth: 180,
            minWidth: 32,
            background: isStreaming ? '#f0f4ff' : isHumanWait ? '#fffbeb' : '#f0fdf4',
            borderRadius: '10px 10px 10px 2px',
            border: `1.5px solid ${isStreaming ? c : isHumanWait ? '#f59e0b' : '#22c55e'}`,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            zIndex: 5,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            padding: '3px 8px',
            overflow: 'hidden',
            transition: 'all 0.2s ease',
          }}
        >
          {isStreaming ? (
            <span
              style={{
                fontSize: 10,
                color: '#1b2540',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
                lineHeight: '14px',
              }}
            >
              {nodeState.streamingText?.slice(-30) || '...'}
              <span style={{ animation: 'blink 0.7s infinite' }}>|</span>
            </span>
          ) : isHumanWait ? (
            <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600, whiteSpace: 'nowrap' }}>
              ⏳ 等待输入
            </span>
          ) : isDone ? (
            <span
              style={{
                fontSize: 10,
                color: '#16a34a',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
              }}
            >
              {typeof nodeState.output === 'string'
                ? nodeState.output.length > 20
                  ? nodeState.output.slice(0, 20) + '...'
                  : nodeState.output
                : '✓ 完成'}
            </span>
          ) : (
            <span style={{ fontSize: 10, color: c, fontWeight: 600 }}>运行中...</span>
          )}
        </div>
      )}









      {/* 4 Ports */}
      {sel && (
        <>
          <PortCircle
            x={ports.top.x}
            y={ports.top.y}
            color={c}
            nodeId={node.id} portDir="top"
            portX={node.x + w/2} portY={node.y}
            onMouseDown={(e) => onPortDown(e, 'top', node.x + w/2, node.y)}
            onMouseUp={(e) => onPortUp(e, 'top', node.x + w/2, node.y)}
          />
          <PortCircle
            x={ports.bottom.x}
            y={ports.bottom.y}
            color={c}
            nodeId={node.id} portDir="bottom"
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={ports.left.x}
            y={ports.left.y}
            color={c}
            nodeId={node.id} portDir="left"
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={ports.right.x}
            y={ports.right.y}
            color={c}
            nodeId={node.id} portDir="right"
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}


function PositionNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
}) {
  const w = PSW,
    h = PSH;
  const c = '#94a3b8',
    bg = '#f8fafc';
  const border = sel ? c : '#e4ecf7';

  const ports = {
    top: { x: w / 2, y: 0 },
    bottom: { x: w / 2, y: h },
    left: { x: 0, y: h / 2 },
    right: { x: w, y: h / 2 },
  };

  return (
    <div
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: bg,
        borderRadius: 18,
        border: `2px solid ${border}`,
        boxShadow: sel
          ? `0 0 0 3px ${c}22, 0 4px 12px rgba(0,0,0,0.08)`
          : '0 1px 6px rgba(20,40,90,0.06)',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: c,
          letterSpacing: '0.06em',
        }}
      >
        {node.label.replace(/[\[\]]/g, '')}
      </span>

      {sel && (
        <>
          <PortCircle
            x={ports.top.x}
            y={ports.top.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'top')}
            onMouseUp={(e) => onPortUp(e, 'top')}
          />
          <PortCircle
            x={ports.bottom.x}
            y={ports.bottom.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={ports.left.x}
            y={ports.left.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={ports.right.x}
            y={ports.right.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}


function SpecialNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
  isActive = false,
}) {
  const sc = SPECIAL_COLORS[node.specialType] || SPECIAL_COLORS.START;
  const size = getNodeSize(node);
  const w = size.w,
    h = size.h;
  const border = sel ? sc.c : '#e4ecf7';
  const isSink = SINK_ONLY.has(node.specialType);

  const ports = {
    top: { x: w / 2, y: 0 },
    bottom: { x: w / 2, y: h },
    left: { x: 0, y: h / 2 },
    right: { x: w, y: h / 2 },
  };

  return (
    <div
      data-node-id={node.id}
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: sc.bg,
        borderRadius: 18,
        border: `2px solid ${border}`,
        boxShadow: isActive
          ? `0 0 12px 4px ${sc.c}66, 0 0 24px 8px ${sc.c}33`
          : sel
            ? `0 0 0 3px ${sc.c}22, 0 4px 12px rgba(0,0,0,0.08)`
            : '0 1px 6px rgba(20,40,90,0.06)',
        animation: isActive ? 'nodeGlow 1.5s ease-in-out infinite' : 'none',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: sc.c,
          letterSpacing: '0.06em',
        }}
      >
        {node.specialType}
      </span>

      {sel && !isSink && (
        <>
          <PortCircle
            x={ports.top.x} y={ports.top.y} color={sc.c}
            nodeId={node.id} portDir="top"
            onMouseDown={(e) => onPortDown(e, 'top')}
            onMouseUp={(e) => onPortUp(e, 'top')}
          />
          <PortCircle
            x={ports.bottom.x} y={ports.bottom.y} color={sc.c}
            nodeId={node.id} portDir="bottom"
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={ports.left.x} y={ports.left.y} color={sc.c}
            nodeId={node.id} portDir="left"
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={ports.right.x} y={ports.right.y} color={sc.c}
            nodeId={node.id} portDir="right"
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}



function ForOutNodeView({ node, sel, onBodyMouseUp, onBubbleClick, onPortDown, onPortUp, forSpecialType = 'FOR' }) {
  const sc = SPECIAL_COLORS[forSpecialType] || SPECIAL_COLORS.FOR;
  const w = 22, h = 22;
  const centerX = node.x + w / 2;
  const centerY = node.y + h / 2;

  const handleMouseDown = (e) => {
    if (onPortDown) {
      onPortDown(e, 'center', centerX, centerY);
    }
  };

  const handleMouseUp = (e) => {
    if (onPortUp) {
      onPortUp(e, 'center', centerX, centerY);
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    onBubbleClick && onBubbleClick(node.id);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        borderRadius: '50%',
        background: sc.bg,
        border: `${sel ? 2.5 : 1.5}px solid ${sc.c}`,  // 👈 只有选中才变粗
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 800,
        color: sc.c,
        fontFamily: 'JetBrains Mono, monospace',
        cursor: sel ? 'grabbing' : 'crosshair',
        userSelect: 'none',
        zIndex: 23,
        boxShadow: sel ? `0 0 0 3px ${sc.c}44, 0 0 12px ${sc.c}55` : 'none',
        transition: 'border-width 0.12s, box-shadow 0.12s',
      }}
    >
      <span>出</span>
    </div>
  );
}


function ParOutNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
}) {
  const sc = SPECIAL_COLORS['PAR'] || SPECIAL_COLORS.FOR;
  const size = getNodeSize(node);
  const w = size.w, h = size.h;
  const border = sel ? sc.c : '#e4ecf7';

  const rightPort = { x: w, y: h / 2 };

  return (
    <div
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: sc.bg,
        borderRadius: 18,
        border: `2px solid ${border}`,
        boxShadow: sel
          ? `0 0 0 3px ${sc.c}22, 0 4px 12px rgba(0,0,0,0.08)`
          : '0 1px 6px rgba(20,40,90,0.06)',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: sc.c,
          letterSpacing: '0.06em',
        }}
      >
        PAR_OUT
      </span>

      {sel && (
        <>
          <PortCircle
            x={w / 2}
            y={0}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'top')}
            onMouseUp={(e) => onPortUp(e, 'top')}
          />
          <PortCircle
            x={w / 2}
            y={h}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={0}
            y={h / 2}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={w}
            y={h / 2}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}
export { ActionNodeView, PositionNodeView, SpecialNodeView, ForOutNodeView, ParOutNodeView };
