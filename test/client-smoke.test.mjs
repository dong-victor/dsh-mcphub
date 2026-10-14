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
 *   - the declaration lands in `plugins.detail.section`,
 *   - the section renders its status payload for its OWN package's subject,
 *   - the section renders NOTHING for any other subject (another bundle, a row,
 *     an official plugin item) — the page hands every entry every page,
 *   - disposal removes the contribution and the injected stylesheet.
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
check('inject waits for slots + locale',
  JSON.stringify(moduleExports.inject) === JSON.stringify(['slots', 'locale']),
  JSON.stringify(moduleExports.inject))

// --- real slot runtime ------------------------------------------------------

// Declarations are owned by a parent ENTRY's `children` table and live exactly
// as long as that entry does, so the harness stands in for the plugin-manager
// page: one persistent "shell" entry mounted in `root` declares
// `plugins.detail.section` (list) and the two seats the plugin USED to occupy
// (`main`, `sidebar.panellist`) plus `sidebar.footer.action`. Disposing the
// shell entry would collapse the declarations — which is why it stays mounted
// for the whole test. Declaring the retired seats on purpose lets the test
// prove positively that nothing registers into them any more, rather than
// passing only because the keys happen to be undeclared.
const core = new SlotCore()
const SHELL_DISPOSER = core.register({
  name: 'root',
  children: {
    'plugins.detail.section': { kind: 'list', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  },
}, () => null)

for (const key of ['plugins.detail.section', 'main', 'sidebar.panellist', 'sidebar.footer.action']) {
  if (core.specDynamic(key) === undefined) throw new Error(`harness failed to declare slot "${key}"`)
}

const SECTION_TARGET = { kind: 'list', scope: 'root' }

const registeredLocales = {}
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
    // REAL contract (`dsh-client-locale` ClientLocaleService.bind). The plugin
    // no longer resolves any copy outside a component (the panel row's `label`
    // thunk is gone with the row), so `bind` is kept only to prove the plugin
    // does not reach for it any more.
    bind(ns) {
      throw new Error('the plugin must not resolve copy outside a component any more')
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

check('declared slot targeted', declarations.includes('plugins.detail.section'), declarations.join(','))
check('the retired sidebar seats are never asked for',
  !declarations.includes('sidebar.panellist') && !declarations.includes('main'),
  declarations.join(','))
check('locale registered under dsh-mcphub', registeredLocales.ns === 'dsh-mcphub')
check('zh dict has section.title', registeredLocales.zh?.['section.title'] === 'MCPHub 桥接')
check('the retired entry.label key is gone', registeredLocales.zh?.['entry.label'] === undefined)
check('en dict mirrors every zh key',
  Object.keys(registeredLocales.zh ?? {}).sort().join(',') === Object.keys(registeredLocales.en ?? {}).sort().join(','))

// --- the one contribution actually landed ------------------------------------

const sectionEntries = core.entriesOfSlot('plugins.detail.section')
check('plugins.detail.section has exactly the mcphub entry', sectionEntries.length === 1,
  String(sectionEntries.length))
check('section entry carries the mcphub id', sectionEntries[0]?.options.id === 'mcphub',
  String(sectionEntries[0]?.options.id))
check('section entry declares the dsh-mcphub locale namespace',
  sectionEntries[0]?.options.locale === undefined || sectionEntries[0]?.options.locale === 'dsh-mcphub')

// The retired surfaces must be empty even though the harness DECLARED them.
for (const retired of ['main', 'sidebar.panellist', 'sidebar.footer.action']) {
  check(`the retired "${retired}" seat is empty`,
    core.entriesOfSlot(retired).length === 0, String(core.entriesOfSlot(retired).length))
}

const SectionComponent = sectionEntries[0]?.component

// --- render the section for ITS OWN package ----------------------------------

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

/** The subject shape the plugin-manager page passes for a bundle page. */
const ownSubject = {
  kind: 'bundle',
  pkg: { name: '@dong-victor/dsh-mcphub', version: '0.2.1', installed: true, enabled: true, rows: [] },
}

await act(async () => {
  root.render(createElement(SectionComponent, { subject: ownSubject, t }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })

check('section renders for its own package subject', host.querySelector('.mh-section') !== null,
  host.innerHTML.slice(0, 80))

const badge = host.querySelector('.mh-stateBadge')
check('state badge shows connected + ok class', badge?.textContent === '已连接' && badge?.classList.contains('ok'),
  badge?.textContent)
check('endpoint meta rendered', host.textContent.includes('http://localhost:3000/mcp'))
check('group meta shows global', host.textContent.includes('全局聚合'))
check('health meta rendered', host.textContent.includes('2/2 已连接'))

const cards = host.querySelectorAll('.mh-card')
check('two server cards rendered', cards.length === 2, String(cards.length))
check('card names correct', cards[0]?.querySelector('.mh-cardName')?.textContent === 'cassiopeia-ap-mysql')
check('card tool counts rendered', (cards[0]?.querySelector('.mh-cardCount')?.textContent ?? '').includes('2'))

const toolRows = cards[0]?.querySelectorAll('.mh-toolRow') ?? []
check('card lists every tool row', toolRows.length === 2, String(toolRows.length))
check('tool row shows the DSH callable public name',
  (toolRows[0]?.textContent ?? '').includes('mcp__mcphub__cassiopeia-ap-mysql-execute_sql'))

// --- render the section for OTHER subjects (must draw nothing) ---------------
// The page renders every registered section entry with the subject of
// whichever page is open, so an entry that draws for a foreign subject paints
// this plugin's status onto another plugin's page.

const foreignSubjects = [
  ['another bundle', { kind: 'bundle', pkg: { ...ownSubject.pkg, name: '@deepseek-ai/dsh-mnemon' } }],
  // A row page carries the same `pkg.name` but is a DIFFERENT, nested page;
  // matching it would repeat the whole status block one level down.
  ['a row page of this bundle', {
    kind: 'row',
    pkg: ownSubject.pkg,
    row: { rowId: 'mcphub', moduleName: '@dong-victor/dsh-mcphub', enabled: true },
  }],
  ['an official plugin item', { kind: 'item', id: 'general' }],
  ['a missing subject', undefined],
  ['a subject with no package', { kind: 'bundle' }],
  ['a subject whose package lacks a name', { kind: 'bundle', pkg: {} }],
  ['a subject from a newer host shape', { kind: 'somethingNew', pkg: ownSubject.pkg }],
]

for (const [label, subject] of foreignSubjects) {
  await act(async () => {
    root.render(createElement(SectionComponent, { subject, t }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  check(`section renders nothing for ${label}`, host.innerHTML === '', host.innerHTML.slice(0, 80))
}

// --- error path --------------------------------------------------------------
// Re-mount the real subject before exercising the refresh control.

await act(async () => {
  root.render(createElement(SectionComponent, { subject: ownSubject, t }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })

window.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'MCPHub unreachable' }) })
const refreshButton = host.querySelector('.mh-iconBtn')
await act(async () => { refreshButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
const banner = host.querySelector('.mh-banner')
check('error banner visible on failure', banner !== null && banner.textContent.includes('状态查询失败'), banner?.textContent)

// --- disposal ----------------------------------------------------------------

for (const dispose of ctx.effects.splice(0)) dispose()
await act(async () => {
  root.render(null)
})
await new Promise((resolve) => setTimeout(resolve, 30))

check('dispose drops the detail-section contribution',
  core.entriesOfSlot('plugins.detail.section').length === 0,
  String(core.entriesOfSlot('plugins.detail.section').length))
check('dispose removes injected style', document.getElementById('dsh-mcphub-style') === null)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
