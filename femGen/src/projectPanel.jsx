// ════════════════════════════════════════
// ═══════.  projectPanel.jsx     ═════════
// ════════════════════════════════════════

import React, { useState } from 'react';
import { Field, PR, inp, btnP, btnS, TYPES } from './common';

function ProjPanel({ proj, actorNames, onChange }) {
  const u = (x) => onChange({ ...proj, ...x });
  return (
    <div>
      <Field label="项目名称">
        <input
          value={proj.name}
          onChange={(e) => u({ name: e.target.value })}
          style={inp}
        />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Version" hint="">
          <input
            value={proj.version}
            onChange={(e) => u({ version: e.target.value })}
            placeholder="1.0"
            style={{ ...inp }}
          />
        </Field>
        <Field label="Owner" hint="user_id">
          <input
            value={proj.owner}
            onChange={(e) => u({ owner: e.target.value })}
            placeholder="1"
            style={{ ...inp }}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Database">
          <input
            value={proj.database}
            onChange={(e) => u({ database: e.target.value })}
            placeholder="memory/Chronica.wor"
            style={{ ...inp }}
          />
        </Field>
        <Field label="Session">
          <input
            value={proj.session}
            onChange={(e) => u({ session: e.target.value })}
            placeholder="new"
            style={{ ...inp }}
          />
        </Field>
      </div>
      <Field label="节点延迟(s)" hint="每个节点执行前的等待秒数">
        <input
          type="number"
          value={proj.delay ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            u({ delay: v === '' ? undefined : Number(v) });
          }}
          style={{ ...inp, width: '100%' }}
          step="0.1"
          min="0"
          placeholder="例如 10"
        />
      </Field>
      <Field label="System Safety">
        <textarea
          value={proj.system_safety}
          onChange={(e) => u({ system_safety: e.target.value })}
          rows={2}
          placeholder="安全须知..."
          style={{ ...inp, resize: 'vertical', lineHeight: 1.55 }}
        />
      </Field>
      <Field label="Output Style">
        <textarea
          value={proj.output_style}
          onChange={(e) => u({ output_style: e.target.value })}
          rows={2}
          placeholder="输出风格要求..."
          style={{ ...inp, resize: 'vertical', lineHeight: 1.55 }}
        />
      </Field>

      <div style={{ marginTop: 2 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 9,
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
            Actors
          </span>
          <button
            onClick={() =>
              u({
                actors: [
                  ...(proj.actors || []),
                  {
                    name: '',
                    type: 'ai',
                    soul: '1',
                    source: 'deepseek',
                    tools: [],
                  },
                ],
              })
            }
            style={{ ...btnP, padding: '4px 11px', fontSize: 11 }}
          >
            +
          </button>
        </div>
        {(proj.actors || []).map((a, i) => {
          const upd = (x) =>
            u({
              actors: proj.actors.map((p, j) => (j === i ? { ...p, ...x } : p)),
            });
          const actorName = a.name.replace('@', '');
          const nameConflict =
            actorName &&
            actorNames.includes(actorName) &&
            proj.actors.findIndex(
              (p, j) => j !== i && p.name.replace('@', '') === actorName
            ) !== -1;
          return (
            <div
              key={i}
              style={{
                background: '#f8fafc',
                border: `1px solid ${nameConflict ? '#ef4444' : '#e4ecf7'}`,
                borderRadius: 8,
                padding: '9px 10px',
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 5,
                  marginBottom: 5,
                  alignItems: 'center',
                }}
              >
                <select
                  value={a.type}
                  onChange={(e) => upd({ type: e.target.value })}
                  style={{
                    ...inp,
                    // 宽度自适应内容（ai/human），不随栏宽收缩
                    width: 'auto',
                    flex: '0 0 auto',
                    padding: '5px 6px',
                    fontSize: 11,
                  }}
                >
                  <option value="ai">ai</option>
                  <option value="human">human</option>
                </select>
                <input
                  value={a.name}
                  onChange={(e) => {
                    let v = e.target.value.trim();
                    if (v && !v.startsWith('@')) v = '@' + v;
                    upd({ name: v });
                  }}
                  placeholder="@Alice"
                  style={{
                    ...inp,
                    flex: 1,
                    padding: '5px 8px',
                    fontSize: 11.5,
                    borderColor: nameConflict ? '#ef4444' : undefined,
                  }}
                />
                <button
                  onClick={() =>
                    u({ actors: proj.actors.filter((_, j) => j !== i) })
                  }
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#f87171',
                    fontSize: 17,
                    lineHeight: 1,
                  }}
                >
                  x
                </button>
              </div>
              {nameConflict && (
                <div
                  style={{ fontSize: 10, color: '#ef4444', marginBottom: 4 }}
                >
                  名称 "{actorName}" 与 action/module 重名
                </div>
              )}
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  value={a.soul}
                  onChange={(e) => upd({ soul: e.target.value })}
                  placeholder="soul:1"
                  style={{ ...inp, flex: 1, padding: '4px 7px', fontSize: 11 }}
                />
                <input
                  value={a.source}
                  onChange={(e) => upd({ source: e.target.value })}
                  placeholder="deepseek"
                  style={{ ...inp, flex: 1, padding: '4px 7px', fontSize: 11 }}
                />
              </div>
              {a.type === 'ai' && (
                <div style={{ marginTop: 5 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#7a8aaa',
                      marginBottom: 4,
                    }}
                  >
                    Tools
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[
                      'deep_think',
                      'web_search',
                      'shell',
                      'weather',
                      'web_fetch',
                    ].map((t) => {
                      // 布尔 tools：true=全部（全勾选），false=禁用（全不勾）；数组=白名单
                      const toolsList = Array.isArray(a.tools)
                        ? a.tools
                        : (a.tools === true
                          ? ['deep_think', 'web_search', 'shell', 'weather', 'web_fetch']
                          : []);
                      const checked = toolsList.includes(t);
                      return (
                        <label
                          key={t}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 3,
                            fontSize: 10.5,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const newTools = e.target.checked
                                ? [...toolsList, t]
                                : toolsList.filter((x) => x !== t);
                              upd({ tools: newTools });
                            }}
                          />
                          {t}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#9aaccb', textTransform: 'uppercase', letterSpacing: '0.09em' }}>
            Vars
          </span>
          <button
            onClick={() => u({ vars: [...(proj.vars || []), { name: '', defaultValue: '' }] })}
            style={{ ...btnP, padding: '4px 11px', fontSize: 11 }}
          >
            +
          </button>
        </div>
        {(proj.vars || []).map((v, i) => (
          <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
            <input
              value={v.name}
              onChange={(e) => {
                const upd = [...proj.vars];
                upd[i] = { ...upd[i], name: e.target.value };
                u({ vars: upd });
              }}
              placeholder="变量名"
              style={{ ...inp, flex: 1, padding: '5px 8px', fontSize: 11.5 }}
            />
            <input
              value={v.defaultValue}
              onChange={(e) => {
                const upd = [...proj.vars];
                upd[i] = { ...upd[i], defaultValue: e.target.value };
                u({ vars: upd });
              }}
              placeholder="默认值"
              style={{ ...inp, flex: 2, padding: '5px 8px', fontSize: 11.5 }}
            />
            <button
              onClick={() => u({ vars: proj.vars.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 17, lineHeight: 1 }}
            >
              x
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 9,
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
            Code
          </span>
          <button
            onClick={() =>
              u({ code: [...(proj.code || []), { name: '', value: '' }] })
            }
            style={{ ...btnP, padding: '4px 11px', fontSize: 11 }}
          >
            +
          </button>
        </div>
        {(proj.code || []).map((c, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 5,
              marginBottom: 5,
              alignItems: 'center',
            }}
          >
            <input
              value={c.name}
              onChange={(e) => {
                const upd = [...proj.code];
                upd[i] = { ...upd[i], name: e.target.value };
                u({ code: upd });
              }}
              placeholder="名称"
              style={{ ...inp, flex: 1, padding: '5px 8px', fontSize: 11.5 }}
            />
            <input
              value={c.value}
              onChange={(e) => {
                const upd = [...proj.code];
                upd[i] = { ...upd[i], value: e.target.value };
                u({ code: upd });
              }}
              placeholder="文件路径（如 utils.py）"
              style={{ ...inp, flex: 2, padding: '5px 8px', fontSize: 11.5 }}
            />
            <button
              onClick={() => u({ code: proj.code.filter((_, j) => j !== i) })}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#f87171',
                fontSize: 17,
                lineHeight: 1,
              }}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


export { ProjPanel };
