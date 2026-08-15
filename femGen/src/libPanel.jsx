// ═══════════════════════════════════════════════════════════════
// ═══ libPanel.jsx ═══
// ═══════════════════════════════════════════════════════════════
import React, { useState } from 'react';
import { TYPES, ti, inp, btnP, btnS, NW, NH, MW, MH } from './common';


function LibPanel({
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
  onSelectLib,
  onNewModule,
  onLibTouchStart = null,
  onLibTouchMove = null,
  onLibTouchEnd = null,
}) {
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
          { t: 'FOR', lbl: 'FOR', c: '#4f6ef7', bg: '#eef1ff' },
          { t: 'PAR', lbl: 'PAR', c: '#7e22ce', bg: '#f3e8ff' },
          { t: 'END', lbl: 'END', c: '#ef4444', bg: '#fef2f2' },
        ]
      : [
          { t: 'FOR', lbl: 'FOR', c: '#4f6ef7', bg: '#eef1ff' },
          { t: 'PAR', lbl: 'PAR', c: '#7e22ce', bg: '#f3e8ff' },
          { t: 'BREAK', lbl: 'BREAK', c: '#f59e0b', bg: '#fffbeb' },
          { t: 'OUT', lbl: 'OUT', c: '#ef4444', bg: '#fef2f2' },
        ];

  return (
    <div>
      {/* Actions section */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 11,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: '#9aaccb',
            textTransform: 'uppercase',
            letterSpacing: '0.09em',
          }}
        >
          Actions
        </span>
        <button
          onClick={onNew}
          style={{
            padding: '4px 11px',
            fontSize: 11,
            background: '#3d5cf5',
            color: 'white',
            border: 'none',
            borderRadius: 7,
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          + 新建
        </button>
      </div>
      {displayActions.length === 0 ? (
        <div
          style={{ textAlign: 'center', padding: '18px 0', color: '#c4d0e0' }}
        >
          <div style={{ fontSize: 22, marginBottom: 6, opacity: 0.5 }}>*</div>
          <div style={{ fontSize: 11.5 }}>
            {mode === 'module' ? '无可用 Actions' : '还没有 Action'}
          </div>
        </div>
      ) : (
        displayActions.map((a) => {
          const { c, bg } = ti(a.executorType);
          return (
            <div
              key={a.id}
              draggable
              onDragStart={(e) => onDragStart(e, 'action', a.id)}
              onClick={() => onSelectLib && onSelectLib('action', a.id)}
              onDoubleClick={() => onEdit && onEdit(a)}
              onTouchStart={onLibTouchStart ? (e) => onLibTouchStart(e, 'action', a) : undefined}
              onTouchMove={onLibTouchMove || undefined}
              onTouchEnd={onLibTouchEnd || undefined}
              style={{
                background: bg,
                borderRadius: 8,
                border: `1.5px solid ${c}18`,
                borderLeft: `3px solid ${c}`,
                padding: '9px 11px',
                marginBottom: 7,
                cursor: 'grab',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: '#1b2540',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 110,
                  }}
                >
                  {a.name}
                </span>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(a);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      color: '#9aaccb',
                      padding: '1px 3px',
                    }}
                  >
                    E
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd(a);
                    }}
                    style={{
                      padding: '2px 9px',
                      fontSize: 10,
                      background: c,
                      color: 'white',
                      border: 'none',
                      borderRadius: 7,
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    + 画布
                  </button>
                </div>
              </div>
              <span
                style={{
                  fontSize: 10.5,
                  fontFamily: 'JetBrains Mono, monospace',
                  fontWeight: 700,
                  color: c,
                }}
              >
                @{a.executorType}
              </span>
              {a.executorActor && (
                <span
                  style={{
                    fontSize: 10,
                    color: '#94a3b8',
                    marginLeft: 5,
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                >
                  {a.executorActor}
                </span>
              )}
            </div>
          );
        })
      )}
      {/* New Module creation */}
      <div style={{ marginTop: 14, marginBottom: 10 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: '#9aaccb',
            textTransform: 'uppercase',
            letterSpacing: '0.09em',
            marginBottom: 6,
          }}
        >
          新建模块
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <input
            placeholder="模块名"
            style={{
              width: '100%',
              padding: '5px 8px',
              borderRadius: 7,
              border: '1.5px solid #dde4ef',
              fontSize: 11.5,
              color: '#1b2540',
              background: '#f8fafc',
              outline: 'none',
              fontFamily: 'DM Sans, sans-serif',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              flex: 1,
            }}
          />
          <button
            onClick={(e) => {
              const input = e.target.parentNode.querySelector('input');
              const name = input.value.trim();
if (name && (!allNames || !allNames.has || !allNames.has(name))) {
                onNewModule(name);
                input.value = '';
              }
            }}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              background: '#475569',
              color: 'white',
              border: 'none',
              borderRadius: 7,
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            创建
          </button>
        </div>
      </div>
      {/* Modules section */}
      {displayModules.length > 0 && (
        <>
          <div
            style={{
              marginTop: 16,
              marginBottom: 11,
              fontSize: 10,
              fontWeight: 800,
              color: '#9aaccb',
              textTransform: 'uppercase',
              letterSpacing: '0.09em',
            }}
          >
            Modules
          </div>
          {displayModules.map((m) => (
            <div
              key={m.id}
              draggable
              onDragStart={(e) => onDragStart(e, 'module', m.id)}
              onClick={() => onSelectLib && onSelectLib('module', m.id)}
              onDoubleClick={() => onEditModule && onEditModule(m)}
              onTouchStart={onLibTouchStart ? (e) => onLibTouchStart(e, 'module', m) : undefined}
              onTouchMove={onLibTouchMove || undefined}
              onTouchEnd={onLibTouchEnd || undefined}
              style={{
                background: '#f1f5f9',
                borderRadius: 8,
                border: '1.5px solid #47556918',
                borderLeft: '3px solid #475569',
                padding: '9px 11px',
                marginBottom: 7,
                cursor: 'grab',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span
                  style={{ fontSize: 12.5, fontWeight: 700, color: '#1b2540' }}
                >
                  &{m.name}
                </span>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditModule(m);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#475569',
                      padding: '2px 6px',
                    }}
                  >
                    编辑
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddModule(m);
                    }}
                    style={{
                      padding: '2px 9px',
                      fontSize: 10,
                      background: '#475569',
                      color: 'white',
                      border: 'none',
                      borderRadius: 7,
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    + 画布
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      {/* Special nodes section */}
      <div
        style={{
          marginTop: 16,
          marginBottom: 11,
          fontSize: 10,
          fontWeight: 800,
          color: '#9aaccb',
          textTransform: 'uppercase',
          letterSpacing: '0.09em',
        }}
      >
        特殊节点
      </div>
{specialNodes.map((s) => (
          <div
            key={s.t}
            draggable
            onDragStart={(e) => onDragStart(e, 'special', s.t)}
onTouchStart={onLibTouchStart ? (e) => onLibTouchStart(e, 'special', s.t) : undefined}
            onTouchMove={onLibTouchMove || undefined}
            onTouchEnd={onLibTouchEnd || undefined}
            style={{
            background: s.bg,
            borderRadius: 8,
            border: `1.5px solid ${s.c}28`,
            borderLeft: `3px solid ${s.c}`,
            padding: '9px 11px',
            marginBottom: 7,
            cursor: 'grab',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: '#1b2540',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              [{s.lbl}]
            </span>
            <button
              onClick={() => onAddSpecial(s.t)}
              style={{
                padding: '2px 9px',
                fontSize: 10,
                background: s.c,
                color: 'white',
                border: 'none',
                borderRadius: 7,
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              + 画布
            </button>
          </div>
        </div>
      ))}
      {/* POSITION node */}
      <div
        draggable
        onDragStart={(e) => onDragStart(e, 'position', 'POSITION')}
        onTouchStart={onLibTouchStart ? (e) => onLibTouchStart(e, 'position', 'POSITION') : undefined}
        onTouchMove={onLibTouchMove || undefined}
        onTouchEnd={onLibTouchEnd || undefined}
        style={{
          background: '#f8fafc',
          borderRadius: 8,
          border: '1.5px solid #94a3b828',
          borderLeft: '3px solid #94a3b8',
          padding: '9px 11px',
          marginBottom: 7,
          cursor: 'grab',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: '#1b2540',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            POSITION
          </span>
          <button
            onClick={onAddPosition}
            style={{
              padding: '2px 9px',
              fontSize: 10,
              background: '#94a3b8',
              color: 'white',
              border: 'none',
              borderRadius: 7,
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            + 画布
          </button>
        </div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
          空节点，仅占位
        </div>
      </div>
    </div>
  );
}

export { LibPanel };
