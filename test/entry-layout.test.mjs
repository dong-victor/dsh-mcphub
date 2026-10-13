/**
 * Verify the sidebar panel entry against the SHELL'S real contract.
 *
 * The plugin used to register a `sidebar.footer.action` seat (a foot row beside
 * Settings). It now registers `sidebar.panellist`, which is the panel MENU: the
 * shell derives its whole row list from those entries
 * (`ctx.slots.entriesOfSlot("sidebar.panellist")` → `{ id, order, label }`) and
 * calls our component ONLY for the glyph, passing `{ size, active }`.
 *
 * So this test asserts:
 *   1. the entry lands in `sidebar.panellist`, not the footer;
 *   2. its `id`/`order`/`label` match what the shell reads for the row list;
 *   3. the glyph renders with ONLY the props the shell supplies (`size`,
 *      `active`) — reaching for anything else blanks the row silently;
 *   4. the old footer seat is gone, so no second entry reappears at the bottom.
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

// --- 1. the entry targets the panel menu ------------------------------------
check('registers into the sidebar.panellist slot',
  /ctx\.slots\.inject\('sidebar\.panellist'/.test(src))
check('the old sidebar.footer.action seat is gone',
  !/slots\.inject\('sidebar\.footer\.action'/.test(src))
check('the old mh-entry styling is gone (the shell owns the row)',
  !/\.mh-entry\{/.test(src))

// The shell reads exactly these options off each panellist entry.
const registration = src.match(/name: 'sidebar\.panellist',([\s\S]*?)\n\s*\}, PanelGlyph\)/)
const options = registration?.[1] ?? ''
check('entry declares an id for the row list', /id: PANEL_ID/.test(options), options.trim() || '(none)')
check('entry declares an order (placement in the menu)', /order: 20/.test(options), options.trim() || '(none)')
// The thunk itself is exercised for real further down, through the shell's own
// `resolveSlotLabel`; asserting only the source shape here would pass even when
// the thunk throws (which is how a crashing label shipped once).
check('entry declares a label thunk for the row',
  /label: function \(\) \{\s*return t\('entry\.label'\)/.test(options), options.trim() || '(none)')
check('entry declares the locale namespace for label resolution', /locale: NS/.test(options))
// The thunk needs a translator in scope in `apply`; a bare `t` there is a
// ReferenceError that escapes into the shell's menu-building effect.
check('apply binds the translator it exposes to the label thunk',
  /var t = ctx\.locale\.bind\(NS\)/.test(src))

// --- 2. the glyph seat ------------------------------------------------------
const glyph = src.match(/function PanelGlyph\(props\) \{([\s\S]*?)\n {4}\}/)?.[1] ?? ''
check('PanelGlyph reads only `size` from props',
  glyph.includes('props.size') && !/\bprops\.(?!size\b)\w+/.test(glyph), glyph.trim() || '(none)')
check('PanelGlyph renders HubIcon', /createElement\(HubIcon, \{ size: size \}\)/.test(glyph))
check('PanelGlyph falls back to 16 when size is absent', /typeof props\.size === 'number' \? props\.size : 16/.test(glyph))

// --- 3. render the glyph with EXACTLY the props the shell supplies ----------
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

const { SlotCore, resolveSlotLabel } = await import('@deepseek-ai/dsh-client-ui-slots')
const core = new SlotCore()
// Mirror the shell's declaration for this slot (`kind: list, scope: root`).
core.register({
  name: 'root',
  children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  },
}, () => null)

const locales = {}
client.apply({
  locale: {
    register: (ns, d) => { locales[ns] = d; return () => {} },
    // Real contract (`dsh-client-locale` bind): a `(key, params) => string`
    // translator. The entry's `label` thunk is resolved through this by the
    // shell, so omitting it would hide a plugin calling an undefined `t`.
    bind: (ns) => (key) => locales[ns]?.zh?.[key] ?? key,
  },
  layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) }, selectPanel: () => {} },
  slots: {
    inject: (n, fn) => (core.specDynamic(n) === undefined ? (() => {}) : fn()),
    register: (o, c) => core.register(o, c),
    entriesOfSlot: (n) => core.entriesOfSlot(n),
  },
  effect: (fn) => { fn(); return () => {} },
})

const entry = core.entriesOfSlot('sidebar.panellist')[0]
check('exactly one sidebar.panellist entry registered', core.entriesOfSlot('sidebar.panellist').length === 1)
check('the entry id matches the main panel key (so the row selects it)',
  entry?.options?.id === 'mcphub', entry?.options?.id)
check('the entry order places it after plugins(0)/schedules(10)',
  entry?.options?.order === 20, String(entry?.options?.order))
check('the label thunk resolves (the shell calls it while building the menu)',
  resolveSlotLabel(entry?.options?.label) === 'MCPHub',
  String((() => { try { return resolveSlotLabel(entry?.options?.label) } catch (e) { return `THREW: ${e.message}` } })()))

const Glyph = entry?.component
const { createRoot } = await import('react-dom/client')
const { createElement, act } = await import('react')

// Render inside a span the way the shell does, with ONLY `{ size, active }`.
const host = window.document.getElementById('host')
host.innerHTML = '<button type="button" class="hHd-Xa_panelRow"><span class="hHd-Xa_panelGlyph"></span></button>'
const mount = host.querySelector('.hHd-Xa_panelGlyph')
const root = createRoot(mount)

await act(async () => {
  root.render(createElement(Glyph, { size: 16, active: false }))
})
check('glyph renders with only { size, active } (no crash, no blank row)',
  mount.querySelector('svg') !== null, mount.innerHTML.slice(0, 80))

await act(async () => {
  root.render(createElement(Glyph, { size: 18, active: true }))
})
check('glyph also renders for the active/collapsed rail size',
  mount.querySelector('svg') !== null)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
