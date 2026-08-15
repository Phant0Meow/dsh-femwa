// ════════════════════════════════════════
// ═══════    soulModal.jsx       ═════════
// ════════════════════════════════════════


import React, { useState } from 'react';
import { inp, btnP, btnS } from './common';

function SoulModal({ open, onClose, onCreated }) {
  const [soulForm, setSoulForm] = useState({
    soul_id: '',
    soul_name: '',
    description: '',
    user_id: '',
    password: '',
  });
  const [soulFormError, setSoulFormError] = useState('');
  const [soulFormSubmitting, setSoulFormSubmitting] = useState(false);

  if (!open) return null;

  const handleCreateSoul = async () => {
    if (!soulForm.soul_id.trim()) {
      setSoulFormError('Soul ID 不能为空');
      return;
    }
    if (!soulForm.user_id.trim()) {
      setSoulFormError('User ID 不能为空');
      return;
    }
    setSoulFormSubmitting(true);
    setSoulFormError('');
    try {
      const res = await fetch('/api/souls/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(soulForm),
      });
      const data = await res.json();
      if (data.error) {
        setSoulFormError(data.error);
      } else {
        onCreated && onCreated(data);
        onClose();
      }
    } catch (e) {
      setSoulFormError(e.message);
    } finally {
      setSoulFormSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 14,
          padding: '28px 32px',
          width: 420,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, color: '#1b2540', marginBottom: 18 }}>
          🆔 新建 SOUL ID
        </div>

        {/* soul_id */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#3d5cf5', marginBottom: 4 }}>
            Soul ID <span style={{ color: '#ef4444' }}>*</span>
          </div>
          <input
            value={soulForm.soul_id}
            onChange={(e) => setSoulForm({ ...soulForm, soul_id: e.target.value.replace(/[^a-zA-Z0-9]/g, '') })}
            placeholder="英文+数字，不可重复"
            style={{ ...inp, width: '100%' }}
            autoFocus
          />
        </div>

        {/* soul_name */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#3d5cf5', marginBottom: 4 }}>
            Soul Name
          </div>
          <input
            value={soulForm.soul_name}
            onChange={(e) => setSoulForm({ ...soulForm, soul_name: e.target.value })}
            placeholder="角色名称，可重复"
            style={{ ...inp, width: '100%' }}
          />
        </div>

        {/* description */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#3d5cf5', marginBottom: 4 }}>
            Description
          </div>
          <textarea
            value={soulForm.description}
            onChange={(e) => setSoulForm({ ...soulForm, description: e.target.value })}
            placeholder="角色的 System Prompt，定义角色的行为和人格..."
            style={{ ...inp, width: '100%', minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        {/* user_id */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#3d5cf5', marginBottom: 4 }}>
            User ID <span style={{ color: '#ef4444' }}>*</span>
          </div>
          <input
            value={soulForm.user_id}
            onChange={(e) => setSoulForm({ ...soulForm, user_id: e.target.value.replace(/[^a-zA-Z0-9]/g, '') })}
            placeholder="英文+数字，重复时需验证密码"
            style={{ ...inp, width: '100%' }}
          />
        </div>

        {/* password */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#3d5cf5', marginBottom: 4 }}>
            Password
          </div>
          <input
            type="password"
            value={soulForm.password}
            onChange={(e) => setSoulForm({ ...soulForm, password: e.target.value })}
            placeholder="用户ID重复时需验证密码，新用户请设置密码"
            style={{ ...inp, width: '100%' }}
          />
        </div>

        {/* 错误提示 */}
        {soulFormError && (
          <div
            style={{
              background: '#fef2f2',
              color: '#991b1b',
              padding: '8px 12px',
              borderRadius: 7,
              fontSize: 12,
              marginBottom: 12,
              border: '1px solid #fecaca',
            }}
          >
            {soulFormError}
          </div>
        )}

        {/* 按钮 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button
            onClick={() => {
              onClose();
              setSoulFormError('');
            }}
            style={btnS}
          >
            取消
          </button>
          <button
            onClick={handleCreateSoul}
            disabled={soulFormSubmitting}
            style={{
              ...btnP,
              background: '#3d5cf5',
              opacity: soulFormSubmitting ? 0.6 : 1,
              cursor: soulFormSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            {soulFormSubmitting ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { SoulModal };
