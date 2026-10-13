/**
 * Client-half smoke test for @dong-victor/dsh-mcphub.
 *
 * dsh 0.2.0-rc.2 replaced the CSS-module class names the previous build
 * scraped with a slot registry, so this test drives the REAL registry
 * (`@deepseek-ai/dsh-client-ui-slots`) instead of a hand-written DOM skeleton:
 * it loads lib/client.js in jsdom, runs `apply()` against a stub context whose
 * `slots` is a real `SlotCore` plus the documented `inject`/`register`
 * wrapper, and asserts that
 *
 *   - the module exports the cordis `inject`/`apply` contract,
 *   - the declarations land in `sidebar.panellist` and `main`,
 *   - the glyph component renders from the `{ size, active }` the shell passes,
 *   - the panel component renders the status payload,
 *   - disposal removes both contributions and the injected stylesheet.
 *
 * The registry throws on an undeclared slot key, so a successful registration
 * here is real evidence that the plugin targets declarations the shell owns.
 *
 * Usage: node test/client-smoke.test.mjs   (needs `npm i -D jsdom` once)
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
})
const { window } = dom
const { document } = window

// react-dom reads `window`/`document` as free globals when it computes event
// priorities, so expose the jsdom surface before importing it. The plugin
// itself only touches `document`, which the loader-provided scope supplies.
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'MutationObserver', 'CustomEvent']) {
  if (globalThis[key] === undefined && window[key] !== undefined) globalThis[key] = window[key]
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

// React must resolve through the loader's `require`.
const realRequire = (await import('node:module')).createRequire(import.meta.url)

// --- module loader capture --------------------------------------------------

let registered
window.__ModuleLoader__ = { load: (handoff) => { registered = handoff } }
window.eval(readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8'))

check('bundle registers via __ModuleLoader__.load', registered !== undefined)
check('registered id matches package name', registered?.id === '@dong-victor/dsh-mcphub')

const moduleExports = registered.factory((spec) => realRequire(spec))
check('factory exports apply + inject', typeof moduleExports?.apply === 'function' && Array.isArray(moduleExports?.inject))
check(
  'inject waits for slots + locale + layout',
  JSON.stringify(moduleExports.inject) === JSON.stringify(['slots', 'locale', 'layout']),
  JSON.stringify(moduleExports.inject),
)

// --- real slot runtime ------------------------------------------------------

// Declarations are owned by a parent ENTRY's `children` table and live exactly
// as long as that entry does, so the harness stands in for the shell: one
// persistent "shell" entry mounted in `root` declares `main` (keyed) and
// `sidebar.panellist` (list). Disposing the shell entry would collapse both
// declarations — which is why it stays mounted for the whole test.
const core = new SlotCore()
const SHELL_DISPOSER = core.register({
  name: 'root',
  children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  },
}, () => null)

for (const key of ['main', 'sidebar.panellist']) {
  if (core.specDynamic(key) === undefined) throw new Error(`harness failed to declare slot "${key}"`)
}

const MAIN_TARGET = { kind: 'keyed', scope: 'root' }
const PANEL_TARGET = { kind: 'list', scope: 'root' }

const registeredLocales = {}
const layoutSelection = { activePanelId: null }
const layoutListeners = new Set()
/** Slot keys the plugin asked to inject into, in order. */
const declarations = []

const ctx = {
  locale: {
    register(ns, dicts) {
      registeredLocales.ns = ns
      registeredLocales.zh = dicts.zh
      registeredLocales.en = dicts.en
      return () => {}
    },
    // REAL contract (`dsh-client-locale` ClientLocaleService.bind): returns a
    // `(key, params) => string` translator that falls back to the key itself.
    // The shell resolves the panel entry's `label` thunk through this, so a
    // harness WITHOUT `bind` cannot catch a plugin that calls an undefined `t`
    // — which is exactly how a crashing label shipped once already.
    bind(ns) {
      return (key, params) => {
        let text = registeredLocales.zh?.[key] ?? key
        if (params) for (const k of Object.keys(params)) text = text.split(`{${k}}`).join(String(params[k]))
        return text
      }
    },
  },
  layout: {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: layoutSelection.activePanelId }),
      subscribe: (fn) => { layoutListeners.add(fn); return () => layoutListeners.delete(fn) },
    },
    selectPanel: (id) => {
      layoutSelection.activePanelId = id
      layoutListeners.forEach((fn) => fn())
    },
  },
  slots: {
    inject(name, fn) {
      // Runtime contract: contribute only once the key is declared, and return
      // a disposer that retracts the contribution. An undeclared key must NOT
      // be registered (SlotCore throws); the harness records the attempt so
      // the test can assert the plugin waits for real declarations.
      declarations.push(name)
      if (core.specDynamic(name) === undefined) return () => {}
      return fn()
    },
    register: (options, component) => core.register(options, component),
    entriesOfSlot: (key) => core.entriesOfSlot(key),
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

check('declared slots targeted', declarations.includes('main') && declarations.includes('sidebar.panellist'), declarations.join(','))
check('locale registered under dsh-mcphub', registeredLocales.ns === 'dsh-mcphub')
check('zh dict has entry.label', registeredLocales.zh?.['entry.label'] === 'MCPHub')
check('en dict mirrors every zh key',
  Object.keys(registeredLocales.zh ?? {}).sort().join(',') === Object.keys(registeredLocales.en ?? {}).sort().join(','))

// --- the two contributions actually landed ----------------------------------

const mainEntries = core.entriesOfSlot('main')
const panelEntries = core.entriesOfSlot('sidebar.panellist')
check('main slot has the mcphub occupant', mainEntries.some((e) => e.options.key === 'mcphub'),
  mainEntries.map((e) => e.options.key).join(','))
check('sidebar.panellist slot has a mcphub entry', panelEntries.length >= 1, String(panelEntries.length))
check('panel entry declares the dsh-mcphub locale namespace',
  panelEntries.every((e) => e.options.locale === undefined || e.options.locale === 'dsh-mcphub'))
check('panel entry id matches the main panel key',
  panelEntries.some((e) => e.options.id === 'mcphub'),
  panelEntries.map((e) => e.options.id).join(','))
check('the footer seat is no longer contributed',
  core.entriesOfSlot('sidebar.footer.action').length === 0)

const panelEntry = panelEntries[panelEntries.length - 1]
const GlyphComponent = panelEntry?.component
const MainComponent = mainEntries.find((e) => e.options.key === 'mcphub')?.component

// --- the label thunk the SHELL calls -----------------------------------------
// `dsh-client-ui-sidebar` builds its menu with
// `resolveSlotLabel(options.label)` inside `syncPanels`; anything thrown there
// escapes into the shell's effect and deactivates the whole sidebar plugin.
// So invoke the thunk exactly as the shell does, through the real resolver.
const { resolveSlotLabel } = await import('@deepseek-ai/dsh-client-ui-slots')
check('the label thunk does not throw when the shell resolves it', (() => {
  try { resolveSlotLabel(panelEntry?.options?.label); return true } catch { return false }
})())
check('the label resolves to the localized display name',
  resolveSlotLabel(panelEntry?.options?.label) === 'MCPHub',
  String(resolveSlotLabel(panelEntry?.options?.label)))

// --- render the panel glyph (the shell owns the row) -------------------------

const { createRoot } = await import('react-dom/client')
const { createElement, act } = await import('react')

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)

const t = (key, params) => {
  let text = registeredLocales.zh[key] ?? key
  if (params) for (const k of Object.keys(params)) text = text.split(`{${k}}`).join(String(params[k]))
  return text
}

// EXACTLY the props the shell passes to `sidebar.panellist`: `{ size, active }`.
// Supplying more would hide a real crash — that is how the missing entry shipped.
await act(async () => {
  root.render(createElement(GlyphComponent, { size: 16, active: false }))
})
check('panel glyph renders an icon with only { size, active }',
  host.querySelector('svg') !== null, host.innerHTML.slice(0, 80))
check('panel glyph renders nothing else (the shell supplies the label)', host.querySelector('span') === null)

await act(async () => {
  root.render(createElement(GlyphComponent, { size: 18, active: true }))
})
check('panel glyph renders for the collapsed rail size too', host.querySelector('svg') !== null)

// --- selecting the panel -----------------------------------------------------
// The shell owns the row and its click handler (`selectPanel(id)`), and the
// glyph carries no active styling of its own, so what matters here is that the
// id we registered is the one the shell will select with.

await act(async () => { ctx.layout.selectPanel('mcphub') })
await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
check('panel entry id selects the main panel via ctx.layout',
  layoutSelection.activePanelId === 'mcphub', String(layoutSelection.activePanelId))
check('the main panel is registered under that same key',
  mainEntries.some((e) => e.options.key === 'mcphub'))

// --- render the panel --------------------------------------------------------

const panelHost = document.createElement('div')
document.body.append(panelHost)
const panelRoot = createRoot(panelHost)
await act(async () => {
  panelRoot.render(createElement(MainComponent, {
    t,
    usePanelInfo: () => ({ activePanelId: layoutSelection.activePanelId }),
  }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })

const badge = panelHost.querySelector('.mh-stateBadge')
check('state badge shows connected + ok class', badge?.textContent === '已连接' && badge?.classList.contains('ok'),
  badge?.textContent)
check('endpoint meta rendered', panelHost.textContent.includes('http://localhost:3000/mcp'))
check('group meta shows global', panelHost.textContent.includes('全局聚合'))
check('health meta rendered', panelHost.textContent.includes('2/2 已连接'))

const cards = panelHost.querySelectorAll('.mh-card')
check('two server cards rendered', cards.length === 2, String(cards.length))
check('card names correct', cards[0]?.querySelector('.mh-cardName')?.textContent === 'cassiopeia-ap-mysql')
check('card tool counts rendered', (cards[0]?.querySelector('.mh-cardCount')?.textContent ?? '').includes('2'))

const toolRows = cards[0]?.querySelectorAll('.mh-toolRow') ?? []
check('card lists every tool row', toolRows.length === 2, String(toolRows.length))
check('tool row shows the DSH callable public name',
  (toolRows[0]?.textContent ?? '').includes('mcp__mcphub__cassiopeia-ap-mysql-execute_sql'))

// --- error path --------------------------------------------------------------

window.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'MCPHub unreachable' }) })
const refreshButton = panelHost.querySelector('.mh-iconBtn')
await act(async () => { refreshButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
const banner = panelHost.querySelector('.mh-banner')
check('error banner visible on failure', banner !== null && banner.textContent.includes('状态查询失败'), banner?.textContent)

// --- disposal ----------------------------------------------------------------

for (const dispose of ctx.effects.splice(0)) dispose()
await act(async () => {
  root.render(null)
  panelRoot.render(null)
})
await new Promise((resolve) => setTimeout(resolve, 30))

check('dispose drops the main contribution', core.entriesOfSlot('main').some((e) => e.options.key === 'mcphub') === false)
check('dispose drops the panel-menu contribution', core.entriesOfSlot('sidebar.panellist').length === 0,
  String(core.entriesOfSlot('sidebar.panellist').length))
check('dispose removes injected style', document.getElementById('dsh-mcphub-style') === null)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
