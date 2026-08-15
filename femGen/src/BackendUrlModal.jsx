// ═══════════════════════════════════════════════════════════════
// ═══ BackendUrlModal.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React, { useState, useEffect } from 'react';
import { Field, inp, btnP, btnS } from './common';

// 存储 key 名称
const STORAGE_HOST = 'fem_backend_host';
const STORAGE_PORT = 'fem_backend_port';

/** 从 sessionStorage/localStorage 读取初始 host 和 port */
function getInitialHost() {
  try {
    const val = sessionStorage.getItem(STORAGE_HOST) || localStorage.getItem(STORAGE_HOST);
    return val || 'http://localhost';
  } catch {
    return 'http://localhost';
  }
}
function getInitialPort() {
  try {
    return sessionStorage.getItem(STORAGE_PORT) || '';
  } catch { return ''; }
}

function BackendUrlModal({ open, onClose, onSaveComplete }) {
  const [host, setHost] = useState(getInitialHost);
  const [port, setPort] = useState(getInitialPort);

  // 测试连接相关状态
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { success: boolean, message: string }

  // 每次打开时，重新读取存储中的值，并清空测试结果
  useEffect(() => {
    if (open) {
      setHost(getInitialHost());
      setPort(getInitialPort());
      setTestResult(null);
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    // 清理：去掉首尾空白、末尾斜杠和冒号
    let cleanHost = host.trim().replace(/\/+$/, '').replace(/:+$/, '');
    let cleanPort = port.trim();

    // 若 host 为空，使用默认值
    if (!cleanHost) cleanHost = 'http://localhost';
    // 若 port 为空，使用默认 8000
    if (!cleanPort) cleanPort = '8000';

    // 保存到 sessionStorage（当前标签页）
    try {
      sessionStorage.setItem(STORAGE_HOST, cleanHost);
      sessionStorage.setItem(STORAGE_PORT, cleanPort);
    } catch (e) {}

    // 若 host 发生变化，同步更新 localStorage 作为默认值
    try {
      const oldDefault = localStorage.getItem(STORAGE_HOST) || '';
      if (cleanHost !== oldDefault) {
        localStorage.setItem(STORAGE_HOST, cleanHost);
      }
    } catch (e) {}

    // 回调通知父组件
    if (onSaveComplete) {
      onSaveComplete(cleanHost, cleanPort);
    }
    onClose();
  };

  const handleClear = () => {
    setHost('http://localhost');
    setPort('8000');
    try {
      sessionStorage.removeItem(STORAGE_HOST);
      sessionStorage.removeItem(STORAGE_PORT);
      localStorage.removeItem(STORAGE_HOST);
    } catch (e) {}
    setTestResult(null);
  };

  // ── 测试连接逻辑 ──
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    let cleanHost = host.trim().replace(/\/+$/, '').replace(/:+$/, '');
    let cleanPort = port.trim();
    if (!cleanHost) cleanHost = 'http://localhost';
    if (!cleanPort) {
      cleanPort = '8000';
      setPort('8000');
    }
    const baseUrl = `${cleanHost}:${cleanPort}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5秒超时
      const resp = await fetch(`${baseUrl}/api/ping`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (resp.ok) {
        setTestResult({ success: true, message: `✅ 连接成功！后端版本：${baseUrl}` });
      } else {
        setTestResult({ success: false, message: `⚠️ 服务器返回状态 ${resp.status}` });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setTestResult({ success: false, message: '⏱️ 连接超时，请检查地址和后端是否启动' });
      } else {
        setTestResult({ success: false, message: `❌ 连接失败：${err.message}` });
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 16,
          width: 420,
          padding: '24px 24px 20px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
          fontFamily: 'DM Sans, sans-serif',
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 16, color: '#1b2540', marginBottom: 4 }}>
          设置本地后端地址
        </div>
        <div style={{ fontSize: 12, color: '#7a8aaa', marginBottom: 18, lineHeight: 1.5 }}>
          每个浏览器标签页可独立设置后端地址，互不影响。
          <br />
          修改 host 后，仅新打开的标签页会继承新地址，当前页面不受影响。
        </div>

        <Field label="基础地址 (host)">
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="http://localhost"
            style={{ ...inp, width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
            autoFocus
          />
        </Field>

        <Field label="端口 (port)">
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="8000"
            style={{ ...inp, width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
          />
        </Field>

        {/* 测试按钮与结果 */}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={handleTestConnection}
            disabled={testing}
            style={{
              ...btnS,
              padding: '6px 14px',
              fontSize: 12,
              opacity: testing ? 0.6 : 1,
              cursor: testing ? 'not-allowed' : 'pointer',
            }}
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
          {testResult && (
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: testResult.success ? '#10b981' : '#ef4444',
                whiteSpace: 'nowrap',
              }}
            >
              {testResult.message}
            </span>
          )}
        </div>

        <div style={{ fontSize: 11, color: '#9aaccb', marginTop: 4 }}>
          <span role="img" aria-label="info">💡</span> host 保存在本地存储，新标签页可自动填入；端口仅当前标签页有效。
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <button onClick={handleClear} style={{ ...btnS, color: '#ef4444', borderColor: '#fecaca' }}>
            恢复默认
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onClose()} style={btnS}>
              取消
            </button>
            <button onClick={handleSave} style={{ ...btnP, background: '#3d5cf5' }}>
              保存并连接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { BackendUrlModal };