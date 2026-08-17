// ════════════════════════════════════════
// ═══════.  femPreview.jsx       ═════════
// ════════════════════════════════════════


import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { btnP, btnS } from './common';

function FemPreview({ value, onChange, error, dirty, onApply, onRestore, onGraphToFem }) {
  const lineNumbersRef = useRef(null);
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const [lineCount, setLineCount] = useState(1);

  // 从错误信息提取行号（支持 "第 12 行:" 格式）
  const errorLine = useMemo(() => {
    if (!error) return null;
    const match = error.match(/第\s*(\d+)\s*行/);
    return match ? parseInt(match[1], 10) : null;
  }, [error]);

  useEffect(() => {
    setLineCount(value.split('\n').length);
  }, [value]);

  const handleScroll = useCallback(() => {
    if (lineNumbersRef.current && textareaRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
    // 同步高亮条的位置
    if (highlightRef.current && textareaRef.current && errorLine != null) {
      const scrollTop = textareaRef.current.scrollTop;
      const lineHeight = 18.9; // 10.5px * 1.8
      highlightRef.current.style.top =
        11 + (errorLine - 1) * lineHeight - scrollTop + 'px';
    }
  }, [errorLine]);

  // 当错误行号或内容变化时，更新高亮条位置（基于当前滚动位置）
  useEffect(() => {
    if (textareaRef.current && highlightRef.current && errorLine != null) {
      const scrollTop = textareaRef.current.scrollTop;
      const lineHeight = 18.9;
      highlightRef.current.style.top =
        11 + (errorLine - 1) * lineHeight - scrollTop + 'px';
    }
  }, [errorLine, value]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: '14px 14px 14px',
      }}
    >
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
            fontSize: 9.5,
            fontWeight: 800,
            color: '#9aaccb',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          FEM 预览
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {error && (
            <button
              onClick={onRestore}
              style={{
                ...btnS,
                padding: '3px 10px',
                fontSize: 10,
                color: '#f59e0b',
                borderColor: '#f59e0b',
              }}
            >
              恢复
            </button>
          )}
          <button
            onClick={onGraphToFem}
            style={{
              ...btnS,
              padding: '3px 10px',
              fontSize: 10,
            }}
          >
            图到文本
          </button>
          <button
            onClick={onApply}
            style={{
              ...btnP,
              padding: '3px 10px',
              fontSize: 10,
              background: dirty ? '#3d5cf5' : '#94a3b8',
            }}
          >
            文本到图
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 8,
            padding: '6px 9px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            fontSize: 10,
            color: '#ef4444',
            lineHeight: 1.5,
            maxHeight: 60,
            overflow: 'auto',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden' }}>
        <div
          ref={lineNumbersRef}
          style={{
            // 行号区整体缩为原 75%（30 → 22.5），左侧空间同步收紧
            width: 22.5,
            background: '#0a0f1e',
            color: '#4a5568',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10.5,
            lineHeight: 1.8,
            padding: '11px 3px 11px 6px',
            textAlign: 'right',
            userSelect: 'none',
            overflow: 'hidden',
            whiteSpace: 'pre',
            borderRight: '1px solid #2d3748',
          }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1}>{i + 1}</div>
          ))}
        </div>

        {/* 带高亮覆盖层的文本区 */}
        <div style={{ position: 'relative', flex: 1 }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            onScroll={handleScroll}
            spellCheck={false}
            style={{
              width: '100%',
              height: '100%',
              background: '#0c1428',
              // 左 padding 归零：顶格代码紧贴行号区边缘
              padding: '11px 0',
              overflow: 'auto',
              resize: 'none',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10.5,
              lineHeight: 1.8,
              color: '#8fa8c8',
              border: 'none',
              outline: 'none',
              whiteSpace: 'pre',
              display: 'block', // 确保覆盖层可以正确定位
            }}
          />
          {errorLine != null && (
            <div
              ref={highlightRef}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: 18.9,
                background: 'rgba(239, 68, 68, 0.18)',
                borderLeft: '3px solid #ef4444',
                pointerEvents: 'none',
                zIndex: 1,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export { FemPreview };
