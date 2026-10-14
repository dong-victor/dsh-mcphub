/**
 * Verify the detail-page section against the PLUGIN MANAGER'S real contract.
 *
 * This plugin used to own a row in the sidebar panel MENU: it registered
 * `sidebar.panellist` (the row) plus a `main` occupant (the page the row
 * selected). Both are gone — the bridge status now lives with the plugin it
 * describes, as a section on this package's own page in the DSH plugin manager
 * (`plugins.detail.section`).
 *
 * The slot contract this test pins (`slot-contract.d.ts` in
 * `@deepseek-ai/dsh-client-ui-plugin-manager`) is a LIST whose entries are
 * rendered with the subject of whichever detail page is open, and an entry
 * renders null for a subject it has nothing for. So this test asserts:
 *
 *   1. the contribution lands in `plugins.detail.section`;
 *   2. the three retired seats (`sidebar.panellist`, `main`,
 *      `sidebar.footer.action`) are neither injected into nor registered in,
 *      even when the harness DECLARES them;
 *   3. the real `SlotCore` accepts the registration (an undeclared key throws,
 *      so success proves the plugin targets a declaration the page owns);
 *   4. the section renders on this package's OWN bundle page;
 *   5. the section renders null on every other subject — another bundle, a row
 *      page of this same bundle, an official plugin item, malformed subjects;
 *   6. disposal retracts the contribution.
 *
 * Usage: node test/entry-layout.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// --- 1. the contribution targets the plugin manager's detail page ------------
check('registers into the plugins.detail.section slot',
  /ctx\.slots\.inject\('plugins\.detail\.section'/.test(src))

// The three seats the plugin used to occupy — or rejected in favour of — must
// be gone from the source outright, so no stale registration can reappear.
check('the retired sidebar.panellist seat is gone',
  !/slots\.inject\('sidebar\.panellist'/.test(src))
check('the retired main seat is gone',
  !/slots\.inject\('main'/.test(src))
check('the retired sidebar.footer.action seat is gone',
  !/slots\.inject\('sidebar\.footer\.action'/.test(src))
check('the old mh-entry styling is gone (the shell owned the row)',
  !/\.mh-entry\{/.test(src))
// The section is drawn inside the page's own section column, which supplies the
// padding/max-width; a full-viewport scroll container here would nest badly.
check('the full-viewport .mh-view wrapper is gone',
  !/\.mh-view\{/.test(src))

// The plugin must no longer need panel navigation or the menu's label thunk.
check('ctx.layout is no longer injected',
  !/exports\.inject = \['slots', 'locale', 'layout'\]/.test(src))
check('no copy is resolved outside a component any more',
  !/ctx\.locale\.bind\(/.test(src))

// --- 2. the seat the section renders into ------------------------------------
const registration = src.match(/name: 'plugins\.detail\.section',([\s\S]*?)\n\s*\}, McphubDetailSection\)/)
const options = registration?.[1] ?? ''
check('entry declares an id for the list slot', /id: SECTION_ID/.test(options), options.trim() || '(none)')
check('entry declares a placement order', /order: \d+/.test(options), options.trim() || '(none)')
check('entry declares the locale namespace', /locale: NS/.test(options))

// --- 3. drive the REAL runtime ----------------------------------------------
// `SlotCore` throws when a key is undeclared, so a successful registration here
// is real evidence the plugin targets a declaration the plugin-manager page
// owns — not merely a string that looks right.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:3080/', runScripts: 'outside-only', pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

window.fetch = async () => ({
  ok: true,
  json: async () => ({
    ok: true, connected: true, endpoint: 'http://localhost:3000/mcp', baseUrl: 'http://localhost:3000',
    serverName: 'mcphub', group: '', toolCount: 9, serverCount: 1, servers: [], lastSyncAt: new Date().toISOString(),
    health: { ok: true, status: 'healthy', servers: { total: 1, connected: 1, disconnected: 0 } },
  }),
})

let handoff
window.__ModuleLoader__ = { load: (h) => { handoff = h } }
window.eval(src)
const realRequire = (await import('node:module')).createRequire(import.meta.url)
const client = handoff.factory((spec) => realRequire(spec))

const { SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots')
const core = new SlotCore()
// Mirror the declarations: the plugin manager's own section seat (list, root)
// plus the three retired seats, declared ON PURPOSE so the test can prove
// nothing registers into them rather than passing because they are undeclared.
core.register({
  name: 'root',
  children: {
    'plugins.detail.section': { kind: 'list', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  },
}, () => null)

const locales = {}
/** Every slot key the plugin asked to inject into. */
const declarations = []
const effects = []
let bindCalled = false

client.apply({
  locale: {
    register: (ns, d) => { locales[ns] = d; return () => {} },
    // The plugin no longer reads copy outside a component, so this must never
    // be reached (see "no copy is resolved outside a component any more").
    bind: () => { bindCalled = true; return (key) => key },
  },
  slots: {
    inject: (n, fn) => {
      declarations.push(n)
      return core.specDynamic(n) === undefined ? (() => {}) : fn()
    },
    register: (o, c) => core.register(o, c),
    entriesOfSlot: (n) => core.entriesOfSlot(n),
  },
  effect: (fn) => { const d = fn(); effects.push(d); return () => {} },
})

check('the plugin never resolves copy outside a component', bindCalled === false)
check('only the detail-section seat was asked for',
  declarations.length === 1 && declarations[0] === 'plugins.detail.section',
  declarations.join(',') || '(none)')

const sectionEntries = core.entriesOfSlot('plugins.detail.section')
check('exactly one plugins.detail.section entry registered', sectionEntries.length === 1,
  String(sectionEntries.length))
check('the entry carries the mcphub id', sectionEntries[0]?.options?.id === 'mcphub',
  String(sectionEntries[0]?.options?.id))

// The retired seats are declared yet must stay empty.
for (const retired of ['main', 'sidebar.panellist', 'sidebar.footer.action']) {
  check(`the retired "${retired}" seat stays empty`,
    core.entriesOfSlot(retired).length === 0, String(core.entriesOfSlot(retired).length))
}

// --- 4./5. render across subjects --------------------------------------------
const Section = sectionEntries[0]?.component
const { createRoot } = await import('react-dom/client')
const { createElement, act } = await import('react')

const t = (key, params) => {
  let text = locales['dsh-mcphub']?.zh?.[key] ?? key
  if (params) for (const k of Object.keys(params)) text = text.split(`{${k}}`).join(String(params[k]))
  return text
}

const host = window.document.getElementById('host')
const root = createRoot(host)

const ownPkg = {
  name: '@dong-victor/dsh-mcphub', version: '0.2.1', installed: true, enabled: true,
  rows: [{ rowId: 'mcphub', moduleName: '@dong-victor/dsh-mcphub', enabled: true }],
}
const ownSubject = { kind: 'bundle', pkg: ownPkg }

// Nothing must be drawn until the section's own page is open.
await act(async () => { root.render(createElement(Section, { subject: ownSubject, t })) })
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })

check('the section renders on this bundle\'s own detail page',
  host.querySelector('[data-mcphub-section]') !== null, host.innerHTML.slice(0, 80))
check('the section shows the bridge title',
  (host.querySelector('.mh-title')?.textContent ?? '') === 'MCPHub 桥接',
  String(host.querySelector('.mh-title')?.textContent))
check('the section shows the live connection state',
  host.querySelector('.mh-stateBadge')?.textContent === '已连接',
  String(host.querySelector('.mh-stateBadge')?.textContent))
check('the section links to the MCPHub dashboard',
  host.querySelector('.mh-dashboardLink')?.getAttribute('href') === 'http://localhost:3000',
  String(host.querySelector('.mh-dashboardLink')?.getAttribute('href')))

// Every subject that is NOT this bundle's page must draw nothing at all — not
// empty chrome, and no status fetch either.
const foreign = [
  ['another bundle', { kind: 'bundle', pkg: { ...ownPkg, name: '@deepseek-ai/dsh-mnemon' } }],
  ['a row page of this same bundle', {
    kind: 'row', pkg: ownPkg, row: { rowId: 'mcphub', moduleName: '@dong-victor/dsh-mcphub', enabled: true },
  }],
  ['an official plugin item', { kind: 'item', id: 'general' }],
  ['a subject with no package', { kind: 'bundle' }],
  ['a subject whose package lacks a name', { kind: 'bundle', pkg: {} }],
  ['a subject from a newer host shape', { kind: 'somethingNew', pkg: ownPkg }],
  ['a missing subject', undefined],
  ['a null subject', null],
]

for (const [label, subject] of foreign) {
  await act(async () => { root.render(createElement(Section, { subject, t })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  check(`draws nothing for ${label}`, host.innerHTML === '', host.innerHTML.slice(0, 80))
}

// --- 6. disposal -------------------------------------------------------------
await act(async () => { root.render(null) })
for (const dispose of effects.splice(0)) dispose()
await new Promise((resolve) => setTimeout(resolve, 30))

check('dispose retracts the detail-section contribution',
  core.entriesOfSlot('plugins.detail.section').length === 0,
  String(core.entriesOfSlot('plugins.detail.section').length))
check('dispose removes the injected stylesheet',
  window.document.getElementById('dsh-mcphub-style') === null)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
