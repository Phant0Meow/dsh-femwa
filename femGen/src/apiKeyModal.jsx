// ═══════════════════════════════════════════════════════════════
// ═══ apiKeyModal.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React from 'react';
import { Field, inp, btnP, btnS } from './common';

function ApiKeyModal({
  open,
  apiKeyInput, setApiKeyInput,
  apiProviderSelect, setApiProviderSelect,
  apiUrlInput, setApiUrlInput,
  apiModelInput, setApiModelInput,  
  rememberKey, setRememberKey,
  userApiKey,
  onSave, onClear, onClose,
}) {
  if (!open) return null;

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
          设置大模型 API Key
        </div>
        <div style={{ fontSize: 12, color: '#7a8aaa', marginBottom: 18, lineHeight: 1.5 }}>
          你的密钥仅用于本次试用，不会上传到我们的服务器，关闭页面后即失效。
          <br />
          我们通过 HTTPS 安全传输，密钥只存在于内存中。
        </div>

        <Field label="模型提供者">
          <select
            value={apiProviderSelect}
            onChange={(e) => setApiProviderSelect(e.target.value)}
            style={{ ...inp, width: '100%' }}
          >
            <option value="mimo">MiMo (小米)</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </Field>

        <Field label="API URL (可选)">
          <input
            type="text"
            value={apiUrlInput}
            onChange={(e) => setApiUrlInput(e.target.value)}
            placeholder={
              apiProviderSelect === 'mimo'
                ? 'https://api.xiaomimimo.com/v1/chat/completions'
                : 'https://api.deepseek.com/v1/chat/completions'
            }
            style={{ ...inp, width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
          />
        </Field>

        <Field label="模型名 (可选)">
          <input
            type="text"
            value={apiModelInput}
            onChange={(e) => setApiModelInput(e.target.value)}
            placeholder={
              apiProviderSelect === 'mimo'
                ? 'mimo-v2.5-pro'
                : 'deepseek-v4-flash'
            }
            style={{ ...inp, width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
          />
        </Field>

        <Field label="API Key *">
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-xxxxxxxxxxxx"
            style={{ ...inp, width: '100%', fontFamily: 'JetBrains Mono, monospace' }}
            autoFocus
          />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5a6a8a', marginTop: 4 }}>
          <input type="checkbox" checked={rememberKey} onChange={(e) => setRememberKey(e.target.checked)} />
          记住密钥（存储在浏览器本地）
        </label>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <div>
            {userApiKey && (
              <button onClick={onClear} style={{ ...btnS, color: '#ef4444', borderColor: '#fecaca' }}>
                清除已保存密钥
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onClose()} style={btnS}>
              取消
            </button>
            <button onClick={onSave} style={{ ...btnP, background: '#3d5cf5' }}>
              保存并开始试用
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { ApiKeyModal };
