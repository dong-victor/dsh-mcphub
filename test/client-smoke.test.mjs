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
/** Calls made to the connection route, in order: `{ method, body }`. */
const connectionCalls = []
/**
 * Reply override for the connection route: `null` echoes the saved address as a
 * connected status, a function receives the call and returns a fake response.
 */
let connectionResponse = null
/**
 * The address the fake host currently serves.
 *
 * The status route must report whatever the connection route last saved —
 * otherwise a test would "pass" a reconnect whose result the status endpoint
 * then contradicts, which is exactly the bug this suite exists to catch.
 */
let servedBaseUrl = fakeStatus.baseUrl
/** Whether the fake host can currently reach the address it serves. */
let servedConnected = true

/** The status payload for the address currently being served. */
function servedStatus(overrides) {
  const status = servedConnected
    ? { ...fakeStatus, baseUrl: servedBaseUrl, endpoint: `${servedBaseUrl}/mcp` }
    : {
      ...fakeStatus, baseUrl: servedBaseUrl, endpoint: `${servedBaseUrl}/mcp`,
      connected: false, toolCount: 0, serverCount: 0, servers: [], error: '无法连接',
    }
  return overrides === undefined ? status : { ...status, ...overrides }
}

window.fetch = async (url, init) => {
  const target = String(url)
  const method = (init && init.method) || 'GET'
  fetchCalls.push(method === 'GET' ? target : `${method} ${target}`)
  if (target.indexOf('/api/dsh-mcphub/connection') !== -1) {
    const body = init && init.body ? JSON.parse(init.body) : undefined
    const call = { method, body }
    connectionCalls.push(call)
    if (connectionResponse !== null) return connectionResponse(call)
    if (method === 'DELETE') servedBaseUrl = fakeStatus.baseUrl
    else if (body && typeof body.baseUrl === 'string') servedBaseUrl = body.baseUrl
    return { ok: true, json: async () => servedStatus({ source: 'saved' }) }
  }
  return { ok: true, json: async () => servedStatus() }
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

// --- the address is editable, and saving it reconnects ----------------------
// The bridge is local by default, but the address is a deployment fact the
// user owns. This block pins the whole edit->save->reconnect->repaint path,
// because that is the only thing that makes the field more than decoration.

const conn = host.querySelector('[data-mcphub-connection]')
check('the address editor renders', conn !== null, host.innerHTML.slice(0, 120))

const inputs = conn?.querySelectorAll('input') ?? []
check('the editor has an address field and a group field', inputs.length === 2, String(inputs.length))

const addressInput = inputs[0]
const groupInput = inputs[1]
check('the address field is prefilled from the host status', addressInput?.value === 'http://localhost:3000', addressInput?.value)
check('the group field is prefilled from the host status', groupInput?.value === '')

const buttons = conn?.querySelectorAll('button') ?? []
const saveButton = buttons[0]
const resetButton = buttons[1]
check('the editor offers save and restore-default', buttons.length === 2, String(buttons.length))
check('save is disabled until something changes', saveButton?.disabled === true)
check('the reset control names the default in its tooltip',
  (resetButton?.getAttribute('title') ?? '').includes('http://localhost:3000'), resetButton?.getAttribute('title'))

/** Type into a field the way React's controlled input expects. */
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

await type(addressInput, 'http://10.0.0.5:3000')
check('editing the address enables save', saveButton?.disabled === false)
check('an unsaved edit is announced', (conn?.textContent ?? '').includes('保存后生效'), conn?.textContent)

await act(async () => {
  conn.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })

const saveCall = connectionCalls.find((call) => call.method === 'POST')
check('saving posts the edited address to the connection route', saveCall?.body?.baseUrl === 'http://10.0.0.5:3000',
  JSON.stringify(saveCall))
check('saving carries the group field too', saveCall?.body?.group === '', JSON.stringify(saveCall?.body))
check('the save result is reported as connected', (conn.textContent ?? '').includes('已连接到 http://10.0.0.5:3000'),
  conn.textContent)
check('a saved status repaints the endpoint', host.textContent.includes('http://10.0.0.5:3000/mcp'), '')
check('the field follows the address the host now serves', addressInput.value === 'http://10.0.0.5:3000', addressInput.value)
check('save is disabled again once the edit is applied', saveButton.disabled === true)

// A refused address must be reported as an INPUT error, not as a connection
// failure: the two need different fixes, so they must read differently.
connectionResponse = () => ({ ok: false, json: async () => ({ ok: false, error: '地址不能为空' }) })
await type(addressInput, '   ')
await act(async () => {
  conn.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
check('a rejected address is reported as invalid input', (conn.textContent ?? '').includes('地址无效'), conn.textContent)

// An address that is valid but unreachable: saved, yet the bridge is down. The
// form must say so instead of claiming success.
connectionResponse = (call) => {
  servedBaseUrl = call.body.baseUrl
  servedConnected = false
  return { ok: true, json: async () => servedStatus({ source: 'saved' }) }
}
await type(addressInput, 'http://127.0.0.1:1')
await act(async () => {
  conn.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
check('an unreachable address reports the failure', (conn.textContent ?? '').includes('连接 http://127.0.0.1:1 失败'),
  conn.textContent)

// A bare-text rejection from dsh's own `/api` gate (`401 unauthorized`,
// `403 forbidden`) or an unmounted route (`404`) has no JSON error to quote.
// Echoing the raw word as "invalid address" would blame the field the user
// typed for a problem that lives in the session, the origin, or the running
// Host — so each status must name its own cause instead.
const bareRejections = [
  [401, '会话未通过认证'],
  [403, '拒绝了这次请求'],
  [404, '还没有这个接口'],
]
for (const [status, expected] of bareRejections) {
  connectionResponse = () => ({
    ok: false,
    status,
    json: async () => { throw new SyntaxError('Unexpected token') },
  })
  await type(addressInput, 'http://10.0.0.6:3000')
  await act(async () => {
    conn.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
  const text = conn.textContent ?? ''
  check(`a bare ${status} is explained, not blamed on the address`, text.includes(expected), text)
  check(`the bare ${status} message is not an "invalid address" report`, !text.includes('地址无效'), text)
}

// Restore default clears the override and reconnects to the local hub.
connectionResponse = null
servedConnected = true
await act(async () => {
  resetButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
check('restore-default calls the connection route with DELETE',
  connectionCalls.some((call) => call.method === 'DELETE'), JSON.stringify(connectionCalls.map((c) => c.method)))
check('restore-default returns the field to the local default', addressInput.value === 'http://localhost:3000',
  addressInput.value)

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

// dsh's own `/api` gate answers this route with a bare-text body
// (`401 unauthorized` / `403 forbidden`), which `response.json()` cannot parse.
// The banner must translate the STATUS into an instruction instead of showing
// the raw word — "状态查询失败：forbidden" tells the user nothing to do.
for (const [status, expected] of [[401, '会话未通过认证'], [403, '拒绝了这次请求'], [404, '还没有这个接口']]) {
  window.fetch = async () => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token') } })
  await act(async () => { refreshButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
  const text = host.querySelector('.mh-banner')?.textContent ?? ''
  check(`a bare status-route ${status} becomes an instruction`, text.includes(expected), text)
  check(`the bare ${status} banner quotes no raw body word`,
    !/forbidden|unauthorized|not found/.test(text), text)
}

// An unexpected status still reports its code rather than a placeholder.
window.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token') } })
await act(async () => { refreshButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
check('an unlisted status reports its code',
  (host.querySelector('.mh-banner')?.textContent ?? '').includes('502'),
  host.querySelector('.mh-banner')?.textContent)

// A real transport failure keeps the historical wording.
window.fetch = async () => { throw new TypeError('Failed to fetch') }
await act(async () => { refreshButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
check('a transport failure still reads as a failed status query',
  (host.querySelector('.mh-banner')?.textContent ?? '').includes('状态查询失败'),
  host.querySelector('.mh-banner')?.textContent)

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
