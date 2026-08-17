// ═══════════════════════════════════════════════════════════════
// ═══ bubbleOverlay.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ti, inp, btnP } from './common';

function BubbleSection({ title, content, streaming }) {
  if (!content && !streaming) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {title && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#7a8aaa',
            marginBottom: 4,
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          fontSize: 12.5,
          color: '#1b2540',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          maxHeight: streaming ? 'none' : 'auto',
        }}
      >
        {content}
        {streaming && <span className="streaming-cursor">|</span>}
      </div>
    </div>
  );
}

function HumanInputSection({ nodeId, onSubmit, outVars, inputError }) {
  const [chatText, setChatText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [varValues, setVarValues] = useState({});

  const handleVarChange = (varName, value) => {
    setVarValues((prev) => ({ ...prev, [varName]: value }));
  };

  const handleSend = () => {
    const hasChat = chatText.trim();
    const hasVars = Object.values(varValues).some((v) => v && v.trim());
    if (!hasChat && !hasVars) return;
    const assignments = {};
    for (const [k, v] of Object.entries(varValues)) {
      if (v && v.trim()) {
        assignments[k] = v.trim();
      }
    }
    console.log('[HumanInputSection] handleSend:', { nodeId, chatText: chatText.trim(), assignments });
    onSubmit(nodeId, chatText.trim(), assignments);
    setChatText('');
    setVarValues({});
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    let combined = chatText;
    let readCount = 0;
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target.result;
        if (combined.length > 0 && !combined.endsWith('\n')) combined += '\n';
        combined += `\n====== ${file.name} ======\n${content}\n`;
        readCount++;
        if (readCount === files.length) {
          setChatText(combined);
        }
      };
      reader.onerror = () => {
        readCount++;
        if (readCount === files.length) {
          setChatText(combined);
        }
      };
      reader.readAsText(file);
    });
  };

  const vars = Array.isArray(outVars) ? outVars : [];
  const hasVars = vars.length > 0;
  const VAR_INPUT_WIDTH = 120;

  return (
    <div style={{ marginTop: 8, flexShrink: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#f59e0b',
          marginBottom: 4,
        }}
      >
        ⏳ 等待人类输入
      </div>
      {inputError && (
        <div
          style={{
            fontSize: 11,
            color: '#dc2626',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            padding: '6px 8px',
            marginBottom: 6,
            whiteSpace: 'pre-wrap',
          }}
        >
          ❌ 输入被拒绝：{inputError}
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          border: dragOver ? '2px dashed #f59e0b' : '2px solid transparent',
          borderRadius: 8,
          transition: 'border 0.15s',
        }}
      >
        <textarea
          data-field="chatText"
          value={chatText}
          onChange={(e) => setChatText(e.target.value)}
          placeholder="输入回复，或拖拽文件到此处..."
          rows={4}
          style={{
            ...inp,
            resize: 'vertical',
            width: '100%',
            boxSizing: 'border-box',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 6,
          flexWrap: 'wrap',
        }}
      >
        <button style={{ ...btnP }} onClick={handleSend}>
          发送
        </button>
        {hasVars && vars.map((varName) => (
          <div
            key={varName}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#7a8aaa',
                fontFamily: 'JetBrains Mono, monospace',
                whiteSpace: 'nowrap',
              }}
            >
              {varName}:
            </span>
            <input
              data-var={varName}
              value={varValues[varName] || ''}
              onChange={(e) => handleVarChange(varName, e.target.value)}
              placeholder="值/+=1/add(@x)"
              style={{
                ...inp,
                width: `${VAR_INPUT_WIDTH}px`,
                fontSize: 12,
                padding: '3px 6px',
                flexShrink: 0,
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function BubbleOverlay({ bubbleOverlay, nodes, nodeStates, actionStore, onClose, submitHumanInput }) {
  if (!bubbleOverlay) return null;
  const node = nodes.find((n) => n.id === bubbleOverlay.nodeId);
  if (!node || node.type !== 'action') return null;
  const action = actionStore?.find(a => a.id === node.actionId);
  const ns = nodeStates[node.id] || {};
  // mind 节点按运行时 node_type 判断（node_start 事件写入 ns.type）：
  // 执行者运行时才确定（可能是变量赋值），静态 executorType 无法预判；
  // 未运行（ns.type 空）时回退到静态 executorType。
  const runType = ns.type || action?.executorType;
  const isAI = runType === 'ai';
  const isHuman = runType === 'human';
  const isStreaming = ns.status === 'ai_streaming';
  const c = ti(action?.executorType)?.c || '#94a3b8';
  const scrollRef = useRef(null);
  const userScrolledUpRef = useRef(false);

  // 用户滚动监听：判断是否在底部
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    userScrolledUpRef.current = !atBottom;
  }, []);

  // 自动滚动：仅当用户没有主动上滚时才跟随流式输出
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [ns.streamingText, ns.output, ns.context]);

  // 切换节点或新对话时重置滚动状态并滚到底部
  useEffect(() => {
    userScrolledUpRef.current = false;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbleOverlay?.nodeId]);

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.3)',
          zIndex: 2999,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: Math.min(window.innerWidth * 0.6, 640),
          maxHeight: '80vh',
          background: 'white',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
          border: `2px solid ${c}`,
          fontFamily: 'DM Sans, sans-serif',
          zIndex: 3000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* 关闭按钮行 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 20px',
            borderBottom: '1px solid #edf0f8',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                background: c + '18',
                color: c,
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              @{action?.executorType || '?'}
            </span>
            <span style={{ fontWeight: 800, color: '#1b2540', fontSize: 16 }}>
              {action?.name || 'Node'}
            </span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              background: '#f1f5f9',
              border: 'none',
              fontSize: 16,
              cursor: 'pointer',
              color: '#64748b',
              borderRadius: 8,
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.target.style.background = '#e2e8f0')}
            onMouseLeave={(e) => (e.target.style.background = '#f1f5f9')}
          >
            ✕
          </button>
        </div>

        {/* 可滚动内容区域 */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
            lineHeight: 1.6,
            fontSize: 13,
            color: '#1b2540',
          }}
        >
          {/* 上下文 */}
          {ns.context && (
            <div style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
              {ns.context}
            </div>
          )}

          {/* 节点提示（showprompt）—— 仅当存在时显示 */}
          {ns.showprompt && (
            <div style={{ marginBottom: 12, background: '#f8fafc', padding: '8px 12px', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, color: '#7a8aaa', marginBottom: 4 }}>[节点提示]</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{ns.showprompt}</div>
            </div>
          )}

          {/* 人类 prompt（独立显示，与 showprompt 分开） */}
          {isHuman && ns.prompt && !ns.showprompt && (
            <div style={{ marginBottom: 12, background: '#f8fafc', padding: '8px 12px', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, color: '#7a8aaa', marginBottom: 4 }}>[提示]</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{ns.prompt}</div>
            </div>
          )}
          {isHuman && ns.prompt && ns.showprompt && (
            <div style={{ marginBottom: 12, background: '#f8fafc', padding: '8px 12px', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, color: '#7a8aaa', marginBottom: 4 }}>[补充说明]</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{ns.prompt}</div>
            </div>
          )}

          {/* AI 输出区域 */}
          {isAI && (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                [{ns.ai_name || 'AI'}]:
              </div>
              {isStreaming ? (
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {ns.streamingText || ''}
                  <span className="streaming-cursor">|</span>
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {ns.output || '（等待输出）'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 人类输入框（固定在底部） */}
        {isHuman && ns.status === 'human_wait' && (
          <div
            style={{
              flexShrink: 0,
              padding: '12px 20px 20px',
              borderTop: '1px solid #edf0f8',
            }}
          >
            <HumanInputSection
              nodeId={node.id}
              onSubmit={submitHumanInput}
              outVars={ns.outVars || []}
              inputError={ns.inputError}
            />
          </div>
        )}
      </div>
    </>
  );
}

export { BubbleOverlay, HumanInputSection, BubbleSection };
