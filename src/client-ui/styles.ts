/**
 * client-ui/styles.ts — fem-stream 样式表（一次性注入）。
 *
 * 官方 ReasoningRow.module.css 的 .fem-rr-* 转写（--dsw-alias-* token 同款，
 * 浅色/深色自适应；rc 升级需对照重放）+ 直播容器与光标。不走 css module
 * （构建链不注入插件侧 css），沿用母名黑化的 style 元素路线。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

const FEM_STREAM_CSS = `
.fem-stream-root{display:flex;flex-direction:column;margin:2px 0 10px}
.fem-stream-toolline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0}
.fem-stream-caret{display:inline-block;width:8px;height:15px;margin-top:2px;background:var(--dsw-alias-label-secondary,#888);animation:fem-caret-blink 1s steps(2,start) infinite}
@keyframes fem-caret-blink{50%{opacity:0}}
.fem-rr-root{display:flex;flex-direction:column}
.fem-rr-row{position:relative;overflow:hidden}
.fem-rr-root[data-state='running'] .fem-rr-row::after{content:'';position:absolute;inset-block:0;left:0;width:300px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent) 55%,transparent 100%);animation:fem-rr-sweep 2.6s ease-out infinite;pointer-events:none}
@keyframes fem-rr-sweep{0%{left:-300px}90%,100%{left:100%}}
.fem-rr-leading{flex-shrink:0}
.fem-rr-chevron{color:var(--dsw-alias-label-secondary)}
.fem-rr-title{font-weight:400}
.fem-rr-separator{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.fem-rr-summary{min-width:0;overflow:hidden;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;text-overflow:ellipsis;white-space:nowrap}
.fem-rr-summary[data-follow-end]{text-overflow:clip}
.fem-rr-think-body{padding:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:pre-wrap;word-break:break-word}
.fem-a11y-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.fem-rr-root[data-state='running'] .fem-rr-row::after{animation:none}}
`

export function ensureFemStreamStyles(): void {
  if (document.getElementById('fem-stream-style') !== null) return
  const el = document.createElement('style')
  el.id = 'fem-stream-style'
  el.textContent = FEM_STREAM_CSS
  document.head.appendChild(el)
}
