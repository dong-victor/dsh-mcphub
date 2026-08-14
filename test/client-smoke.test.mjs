/**
 * DOM smoke test for the @dong-victor/dsh-mcphub browser half.
 *
 * Runs lib/client.js inside jsdom with a minimal dsh shell skeleton, drives
 * the real DOM paths: factory registration, apply/entry contract, sidebar
 * entry placement, panel mount into the conversation column, fetch -> status
 * render (badge, meta rows, server cards), refresh, error banner, and full
 * disposal.
 *
 * Usage: node test/client-smoke.test.mjs   (needs `npm i -D jsdom` once)
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const html = `<!doctype html><html lang="zh"><head></head><body>
  <div data-pane="sidebar"><div class="logoRow"><button class="newSession">New Session</button></div><div class="sidebarCol-inner"></div></div>
  <div data-pane="conversation"><div class="chat">conversation</div></div>
</body></html>`

const dom = new JSDOM(html, { url: 'http://127.0.0.1:3080/', runScripts: 'outside-only', pretendToBeVisual: true })
const { window } = dom
const { document } = window

// --- fixtures --------------------------------------------------------------
const fakeStatus = {
  ok: true,
  connected: true,
  endpoint: 'http://localhost:3000/mcp',
  baseUrl: 'http://localhost:3000',
  serverName: 'mcphub',
  group: '',
  toolCount: 3,
  serverCount: 2,
  servers: [
    {
      name: 'cassiopeia-ap-mysql',
      toolCount: 2,
      tools: [
        { name: 'cassiopeia-ap-mysql-execute_sql', publicName: 'mcp__mcphub__cassiopeia-ap-mysql-execute_sql' },
        { name: 'cassiopeia-ap-mysql-get_schema_info', publicName: 'mcp__mcphub__cassiopeia-ap-mysql-get_schema_info' },
      ],
    },
    {
      name: 'cassiopeia-ep-mysql',
      toolCount: 1,
      tools: [{ name: 'cassiopeia-ep-mysql-execute_sql', publicName: 'mcp__mcphub__cassiopeia-ep-mysql-execute_sql' }],
    },
  ],
  lastSyncAt: new Date().toISOString(),
  health: { ok: true, status: 'healthy', servers: { total: 2, connected: 2, disconnected: 0 } },
}
const fetchCalls = []
window.fetch = async (url) => {
  fetchCalls.push(String(url))
  return { ok: true, json: async () => fakeStatus }
}

// --- module loader capture --------------------------------------------------
let registered = undefined
window.__ModuleLoader__ = { load: (handoff) => { registered = handoff } }

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
window.eval(source)

check('bundle registers via __ModuleLoader__.load', registered !== undefined)
check('registered id matches package name', registered?.id === '@dong-victor/dsh-mcphub')

const moduleExports = registered.factory((spec) => { throw new Error(`unexpected require: ${spec}`) })
check('factory exports apply + inject', typeof moduleExports?.apply === 'function' && Array.isArray(moduleExports?.inject))
check('inject waits for slots + locale', JSON.stringify(moduleExports.inject) === JSON.stringify(['slots', 'locale']))

// --- fake ctx ----------------------------------------------------------------
const registeredLocales = {}
const ctx = {
  locale: {
    register(ns, dicts) {
      registeredLocales.ns = ns
      registeredLocales.zh = dicts.zh
      registeredLocales.en = dicts.en
      return () => {}
    },
  },
  effect(fn) {
    const disposer = fn()
    ctx.effects.push(disposer)
    return () => {}
  },
  effects: [],
}
moduleExports.apply(ctx)

await new Promise((resolve) => setTimeout(resolve, 60))

// --- sidebar entry ------------------------------------------------------------
const entry = document.querySelector('[data-dsh-mcphub-entry]')
check('sidebar entry mounted', entry !== null)
check('entry placed inside sidebar root', entry?.parentElement?.getAttribute('data-pane') === 'sidebar')
check('locale registered under dsh-mcphub', registeredLocales.ns === 'dsh-mcphub')
check('zh dict has entry.label', registeredLocales.zh?.['entry.label'] === 'MCPHub')
check('entry label text rendered (zh)', entry?.querySelector('.mh-entryLabel')?.textContent === 'MCPHub')

// --- sidebar inline summary (no click needed) -------------------------------------
const toolsStat = entry?.querySelector('[data-stat="tools"]')?.textContent ?? ''
const serversStat = entry?.querySelector('[data-stat="servers"]')?.textContent ?? ''
check('entry tool count rendered', toolsStat === '3 个工具', toolsStat)
check('entry server count rendered', serversStat === '2 个 server', serversStat)
check('connection dot is ok', entry?.querySelector('.mh-dot')?.classList.contains('ok'))
check('entry fetch uses plain status path (host cache)', fetchCalls.length > 0 && fetchCalls[0] === '/api/dsh-mcphub/status')

// --- open panel -----------------------------------------------------------------
entry.click()
await new Promise((resolve) => setTimeout(resolve, 80))

const view = document.querySelector('[data-dsh-mcphub-view]')
check('panel view mounted in conversation column', view !== null && view.parentElement?.getAttribute('data-pane') === 'conversation')
check('html carries data-dsh-mcphub-active', document.documentElement.hasAttribute('data-dsh-mcphub-active'))

const stateBadge = document.querySelector('.mh-stateBadge')
check('state badge shows connected + ok class', stateBadge?.textContent === '已连接' && stateBadge?.classList.contains('ok'))
check('endpoint meta rendered', document.body.textContent.includes('http://localhost:3000/mcp'))
check('group meta shows global', document.body.textContent.includes('全局聚合'))
check('health meta rendered', document.body.textContent.includes('2/2 已连接'))

const cards = document.querySelectorAll('.mh-card')
check('two server cards rendered', cards.length === 2)
check('card names correct', cards[0]?.querySelector('.mh-cardName')?.textContent === 'cassiopeia-ap-mysql')
check('card tool counts rendered', (cards[0]?.querySelector('.mh-cardCount')?.textContent ?? '').includes('2'))

// expand the first card
cards[0]?.querySelector('.mh-cardHead')?.click()
const toolRows = cards[0]?.querySelectorAll('.mh-toolRow') ?? []
check('expanded card shows its tool rows', toolRows.length === 2)
check('tool row shows the DSH callable public name', (toolRows[0]?.textContent ?? '').includes('mcp__mcphub__cassiopeia-ap-mysql-execute_sql'))
check('cards container visible', !document.querySelector('.mh-cards')?.hidden)

// --- refresh -----------------------------------------------------------------------
const fetchBefore = fetchCalls.length
document.querySelector('.mh-iconBtn[title="刷新"]').click()
await new Promise((resolve) => setTimeout(resolve, 80))
check('refresh button hits ?refresh=1', fetchCalls.length > fetchBefore && fetchCalls[fetchCalls.length - 1].includes('refresh=1'))

// --- error banner path --------------------------------------------------------------
window.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'MCPHub unreachable' }) })
document.querySelector('.mh-iconBtn[title="刷新"]').click()
await new Promise((resolve) => setTimeout(resolve, 80))
const banner = document.querySelector('.mh-banner')
check('error banner visible on failure', banner !== null && !banner.hidden && banner.textContent.includes('状态查询失败'))
window.fetch = async (url) => { fetchCalls.push(String(url)); return { ok: true, json: async () => fakeStatus } }

// --- close / disposal -----------------------------------------------------------------
document.querySelector('.mh-iconBtn[title="关闭"]').click()
check('close removes active attr', !document.documentElement.hasAttribute('data-dsh-mcphub-active'))
check('entry loses active state', !entry.hasAttribute('data-active'))

for (const dispose of ctx.effects.splice(0)) dispose()
await new Promise((resolve) => setTimeout(resolve, 30))
check('dispose removes sidebar entry', document.querySelector('[data-dsh-mcphub-entry]') === null)
check('dispose removes panel view', document.querySelector('[data-dsh-mcphub-view]') === null)
check('dispose removes active attr', !document.documentElement.hasAttribute('data-dsh-mcphub-active'))
check('dispose removes injected style', document.getElementById('dsh-mcphub-style') === null)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
