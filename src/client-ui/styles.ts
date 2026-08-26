/**
 * client-ui/styles.ts — fem-stream 样式表（一次性注入）。
 *
 * 官方 ReasoningRow.module.css 的 .fem-rr-* 转写（--dsw-alias-* token 同款，
 * 浅色/深色自适应；rc 升级需对照重放）+ 直播容器与光标。不走 css module
 * （构建链不注入插件侧 css），沿用母名黑化的 style 元素路线。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 *
 * 2026-08-26 追加 FEM_COMPOSER_CSS：投影窗 composer 官方同款胶囊卡片
 * （ui-conversation InputBar.module.css 逐属性转写，fem-comp-* 前缀），
 * 全 --dsw/--dsh token 零写死色值 → 深浅色与第三方主题自动跟随主窗口。
 */

const FEM_STREAM_CSS = `
.fem-stream-root{display:flex;flex-direction:column;margin:2px 0 10px}
.fem-stream-toolline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0}
.fem-stream-caret{display:inline-block;width:8px;height:15px;margin-top:2px;background:var(--dsw-alias-label-secondary,#888);animation:fem-caret-blink 1s steps(2,start) infinite}
@keyframes fem-caret-blink{50%{opacity:0}}
/* 官方 ChatView TurnStatus 同款转写（2026-08-26）：品牌蓝流光 "Deep diving..."
   （rc.2 ChatView.module.css .turnStatus/.turnStatusClock 逐属性重放，类名换
   fem- 前缀——构建链不注入插件侧 css module，沿用 style 元素路线）。 */
.fem-turn-status{align-self:flex-start;flex:none;display:inline-flex;align-items:center;height:26px;font:var(--dsw-font-s-strong-14);white-space:nowrap;background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);background-position:100% 0;background-size:250% 100%;background-clip:text;color:transparent;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:fem-turn-status-shimmer 1.8s linear infinite}
.fem-turn-status-clock{margin-left:8px;font:var(--dsw-font-xs-13);font-weight:400;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);-webkit-text-fill-color:var(--dsw-alias-label-caption)}
@keyframes fem-turn-status-shimmer{to{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.fem-turn-status{background-position:0 0;background-size:100% 100%;animation:none}}
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

/** 投影窗 composer：官方 InputBar 视觉的逐属性转写（rc.2 InputBar.module.css，
 * 类名换 fem-comp-* 前缀；rc 升级需对照重放）。布局 token 定义在
 * ConversationRoot 的祖先链上（.root / .composerSeat），槽位内继承可得；
 * fallback 值仅兜变量缺失，不改变正常主题下的解析。 */
const FEM_COMPOSER_CSS = `
.fem-comp-root{display:flex;flex-direction:column;align-items:center;padding:0 var(--dsh-composer-side-clearance,16px) 8px}
.fem-comp-notice{width:100%;max-width:var(--dsh-composer-card-max-width,780px);margin-bottom:6px;padding:4px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.fem-comp-card{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:12px;width:100%;max-width:var(--dsh-composer-card-max-width,780px);padding-top:10px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:22px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);font-family:var(--dsw-font-family);font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.fem-comp-scroll{max-height:var(--dsh-composer-text-max-height,336px);overflow-y:auto}
.fem-comp-grow{position:relative}
/* 官方 mirror 自增高技术（无 backdrop 层）：mirror 流内定高、textarea 绝对
   覆盖；两层共享同一套度量与换行规则，高度才不会分叉。 */
.fem-comp-mirror,.fem-comp-input{box-sizing:border-box;padding:4px 12px 0 16px;font-family:inherit;font-size:inherit;line-height:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.fem-comp-mirror{visibility:hidden;pointer-events:none}
.fem-comp-input{position:absolute;inset:0;width:100%;height:100%;display:block;border:none;outline:none;resize:none;overflow:hidden;background:transparent;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary)}
.fem-comp-input[readonly]{color:var(--dsw-alias-label-tertiary)}
.fem-comp-input::placeholder{color:var(--dsw-alias-label-caption);-webkit-text-fill-color:var(--dsw-alias-label-caption);user-select:none}
/* 工具行：官方 .row 同款（左组预留空、右组发送钮）；2px 顶移补偿同官方。 */
.fem-comp-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:2px 8px 6px;min-width:0}
.fem-comp-trailing{display:flex;align-items:center;min-width:0;margin-left:auto;gap:12px}
.fem-comp-primary{display:grid;place-items:center;flex:none;width:34px;height:34px;border:none;border-radius:999px;background:var(--dsw-alias-button-info-fill,#3964FE);color:#fff;cursor:pointer;transition:background-color 100ms ease;transform:translateY(-2px)}
.fem-comp-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.fem-comp-primary:disabled{opacity:.4;cursor:default}
/* 权限菜单 trigger：官方 PermissionSelect.module.css .trigger 家族逐属性转写
   （fem-comp-perm-*）；菜单体与风险确认弹窗用 ui-primitives 的 Menu /
   RiskConfirmation 官方组件，无需自绘。 */
.fem-comp-perm-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;font-family:inherit;cursor:pointer}
.fem-comp-perm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fem-comp-perm-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.fem-comp-perm-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.fem-comp-perm-icon{display:inline-flex;flex:0 0 auto}
.fem-comp-perm-icon svg{width:14px;height:14px}
.fem-comp-perm-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fem-comp-perm-chevron{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}
.fem-comp-perm-chevron[data-open='true']{transform:rotate(180deg)}
/* 统计行：官方 StatsLine.module.css 逐属性转写（fem-comp-stats-*），
   对齐共享消息列轴（--dsh-chat-content-width）。 */
.fem-comp-stats{display:block;text-align:center;max-width:var(--dsh-chat-content-width,748px);width:100%;margin:0 auto;box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance,16px) + 16px) 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fem-comp-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px}
`

export function ensureFemStreamStyles(): void {
  if (document.getElementById('fem-stream-style') !== null) return
  const el = document.createElement('style')
  el.id = 'fem-stream-style'
  el.textContent = FEM_STREAM_CSS + FEM_COMPOSER_CSS
  document.head.appendChild(el)
}
