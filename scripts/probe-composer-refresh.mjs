// probe-composer-refresh.mjs — 复现「刷新后投影窗缺权限按钮/统计行」（2026-08-29）。
// 流程：打开 3081 → 写入持久化 selection（直接落到上帝窗）→ 重载触发真实启动链 →
// 检查 composer DOM（权限按钮/统计行是否存在=render null 还是 CSS 隐藏）→
// 切换视角（模拟用户修复动作）→ 再查 DOM。
// 用法：node scripts/probe-composer-refresh.mjs <godSessionId> <mainSessionId> [cdpPort]
// cdpPort 提供时外接已运行的 Edge 实例（沙箱内 node spawn 的 Edge 会因 mojo
// 命名管道被拦而 FATAL 退出，须用 Start-Process 先起好）；缺省自起 9341。
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(process.argv[4]) || 9341
const URL = 'http://127.0.0.1:3081'
const GOD = process.argv[2]
const MAIN = process.argv[3]
if (!GOD || !MAIN) { console.log('usage: node probe-composer-refresh.mjs <godSid> <mainSid> [cdpPort]'); process.exit(1) }
const PROFILE = join(tmpdir(), `femwa-probe-${Date.now()}`)

let edge = null
if (process.argv[4] === undefined) {
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let list = null
for (let i = 0; i < 40; i += 1) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length > 0) break } catch { }
  await sleep(250)
}
if (list === null) { console.log('FAIL: CDP not up'); edge?.kill(); process.exit(1) }
await sleep(1200)

// CDP 连接（带重试：近期 Edge headless 首连会被 1006 掐断，重取 target 再连）。
let ws = null
let send = null
let evalJs = null
let msgId = 0
const pending = new Map()
for (let attempt = 1; attempt <= 8; attempt += 1) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) { await sleep(500); continue }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  const opened = new Promise((res) => { ws.onopen = res; ws.onclose = res; ws.onerror = res })
  await Promise.race([opened, sleep(3000)])
  if (ws.readyState === 1) break
  ws.close()
  await sleep(500)
}
if (ws === null || ws.readyState !== 1) { console.log('FAIL: CDP ws not connected'); edge?.kill(); process.exit(1) }
// 消息监听链：CDP 拦截器/console 采集/请求分发都走这里，避免互相覆盖。
const listeners = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  for (const l of listeners) l(m)
}
send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value
await send('Page.enable')
await send('Runtime.enable')

// console 采集。
const consoleLogs = []
listeners.push((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
    consoleLogs.push(`[${m.params.type}] ${text.slice(0, 300)}`)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleLogs.push(`[exception] ${String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 300)}`)
  }
})

// ── 竞态复现模式：--delay-list N 秒延迟 session.list（CDP Fetch 拦截）──────
// 用户真实场景=热刷新（composer 早早挂载，catalog 与 list 竞速）；本探针冷启动
// composer 挂载晚于一切请求，永远赶上好次序。延迟 list 模拟「catalog 先赢」。
const DELAY_LIST_S = process.argv[5] === '--delay-list' ? Number(process.argv[6]) : 0

// 1) 先开一次页面拿到同源，再写持久化 selection，重载触发真实启动链。
await send('Page.navigate', { url: URL })
await sleep(6000)
await evalJs(`localStorage.setItem('dsh.sessions.current', JSON.stringify({
  sessionId: ${JSON.stringify(GOD)},
  subagentAddress: { parentSessionId: ${JSON.stringify(MAIN)}, childSessionId: ${JSON.stringify(GOD)}, mode: 'one-shot' },
}))`)
if (DELAY_LIST_S > 0) {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*session.list*', requestStage: 'Request' }] })
  listeners.push((m) => {
    if (m.method === 'Fetch.requestPaused' && m.params.request.url.includes('session.list')) {
      const { requestId } = m.params
      console.log(`[intercept] session.list paused, hold ${DELAY_LIST_S}s`)
      setTimeout(() => { send('Fetch.continueRequest', { requestId }).catch(() => { /* 导航后旧请求作废 */ }) }, DELAY_LIST_S * 1000)
    }
  })
}
await send('Page.navigate', { url: URL })
// 启动等待：轮询 textarea 出现（composer 挂载）或 25s 超时。
let booted = false
for (let i = 0; i < 50; i += 1) {
  const r = await evalJs(`!!document.querySelector('textarea')`)
  if (r === true) { booted = true; break }
  await sleep(500)
}
console.log('booted(textarea):', booted)
await sleep(3000)

const CHECK = `(() => {
  const ta = document.querySelector('textarea.fem-comp-input')
  const perm = document.querySelector('.fem-comp-perm-trigger')
  const stats = document.querySelector('.fem-comp-stats')
  const card = document.querySelector('[data-composer-card]')
  const vis = (el) => el === null ? null : !!(el.offsetParent !== null || el.getClientRects().length > 0)
  return {
    composerMounted: ta !== null,
    permTriggerInDom: perm !== null,
    permTriggerVisible: vis(perm),
    statsInDom: stats !== null,
    statsText: stats?.textContent ?? null,
    cardFolded: card?.getAttribute('data-meow-smooth') ?? null,
  }
})()`

const afterRefresh = await evalJs(CHECK)
console.log('AFTER-REFRESH ', JSON.stringify(afterRefresh))
// 等 session.list 落地（侧边栏出现会话行）后再查一次——按理论按钮应当仍然缺失
// （memo 缓存了失败解析，列表落地不触发重算）。
let listLanded = false
for (let i = 0; i < 60; i += 1) {
  const r = await evalJs(`document.querySelectorAll('[data-slot="sidebar"] [role="treeitem"]').length`)
  if (typeof r === 'number' && r > 0) { listLanded = true; break }
  await sleep(500)
}
console.log('list-landed(sidebar rows):', listLanded)
await sleep(4000)
const afterList = await evalJs(CHECK)
console.log('AFTER-LIST-LAND', JSON.stringify(afterList))
console.log('console tail:', consoleLogs.slice(-15).join('\n  '))
// 页面快照：当前选中会话与 header 按钮文本。
const pageState = await evalJs(`(() => ({
  persisted: localStorage.getItem('dsh.sessions.current')?.slice(0, 200) ?? null,
  headerButtons: [...document.querySelectorAll('[data-slot="conversation.session.header.actions"] button')].map(b => (b.textContent ?? '').trim()).slice(0, 8),
  crumbs: document.querySelector('[class*="crumbs"]')?.textContent?.slice(0, 120) ?? null,
  anyHeader: !!document.querySelector('[data-slot="conversation.session.header"]'),
  bodyCls: document.body.className.slice(0, 80),
}))()`)
console.log('PAGE-STATE:', JSON.stringify(pageState))
const shot1 = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync('D:/myFiles/dsh/_tmp/femwa-probe-refresh.png', Buffer.from(shot1.data, 'base64'))

// 2) 模拟用户修复动作：视角菜单 → 戏外·主模型（跳主会话）→ 上帝视角（跳回）。
const viewBtn = `(() => {
  const btns = [...document.querySelectorAll('[data-slot="conversation.session.header.actions"] button')]
  const vb = btns.find(b => (b.textContent ?? '').includes('上帝视角') || (b.textContent ?? '').includes('戏外'))
  if (!vb) return 'no-view-button'
  vb.click()
  return 'opened'
})()`
console.log('view-menu:', await evalJs(viewBtn))
await sleep(600)
const pickOffstage = `(() => {
  const items = [...document.querySelectorAll('button')].filter(b => (b.textContent ?? '').includes('戏外'))
  if (items.length === 0) return 'no-item'
  items[items.length - 1].click()
  return 'picked'
})()`
console.log('pick-offstage:', await evalJs(pickOffstage))
await sleep(4000)
const onMain = await evalJs(`[...document.querySelectorAll('[data-slot="conversation.session.header.actions"] button')].map(b => (b.textContent ?? '').trim()).join(',')`)
console.log('ON-MAIN:', onMain)
console.log('view-menu2:', await evalJs(viewBtn))
await sleep(600)
const pickGod = `(() => {
  const items = [...document.querySelectorAll('button')].filter(b => (b.textContent ?? '').includes('上帝视角'))
  if (items.length === 0) return 'no-item'
  items[items.length - 1].click()
  return 'picked'
})()`
console.log('pick-god:', await evalJs(pickGod))
await sleep(5000)

const afterSwitch = await evalJs(CHECK)
console.log('AFTER-SWITCH  ', JSON.stringify(afterSwitch))

ws.close()
edge?.kill()
process.exit(0)
