/**
 * Editable-endpoint regression test.
 *
 * The plugin connects to the local MCPHub by default (`http://localhost:3000`),
 * but the address must be editable: another port, another host, or a remote
 * MCPHub. Saving a new address has to do three things that this test pins:
 *
 *   1. normalize what a person actually types (`localhost:3000`,
 *      `127.0.0.1:3000/mcp`, a full `https://` URL) into one origin;
 *   2. persist it so the address survives a Host restart;
 *   3. reconnect the live bridge immediately, dropping the tools of the hub it
 *      no longer talks to so nothing advertises a stale tool set.
 *
 * Every route assertion drives the plugin's REAL route handler with fake
 * request/response objects — no HTTP server, no network — and the settings
 * assertions run against a throwaway $DSH_HOME so a developer's saved address
 * can never leak into the result.
 *
 * Usage: node test/connection.test.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-mcphub-connection-'))

const {
  apply,
  DEFAULT_BASE_URL,
  settingsFilePath,
  readSettings,
  writeSettings,
  resolveConnection,
  normalizeBaseUrl,
  normalizeGroup,
} = await import('../lib/index.js')

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
  }
}

// --- normalization ----------------------------------------------------------

check('default base URL is the local MCPHub', DEFAULT_BASE_URL === 'http://localhost:3000')

check('a bare host:port gains http://', normalizeBaseUrl('localhost:3000') === 'http://localhost:3000')
check('an explicit scheme is kept', normalizeBaseUrl('https://hub.example.com') === 'https://hub.example.com')
check('a typed /mcp suffix is dropped', normalizeBaseUrl('http://localhost:3000/mcp') === 'http://localhost:3000')
check('a typed group path is dropped', normalizeBaseUrl('http://localhost:3000/mcp/team') === 'http://localhost:3000')
check('surrounding whitespace is trimmed', normalizeBaseUrl('  http://127.0.0.1:3001  ') === 'http://127.0.0.1:3001')
check('a trailing slash normalizes away', normalizeBaseUrl('http://localhost:3000/') === 'http://localhost:3000')

let rejectedEmpty = false
try {
  normalizeBaseUrl('   ')
} catch {
  rejectedEmpty = true
}
check('an empty address is rejected', rejectedEmpty)

let rejectedScheme = false
try {
  normalizeBaseUrl('ftp://localhost:3000')
} catch {
  rejectedScheme = true
}
check('a non-http scheme is rejected', rejectedScheme)

let rejectedGarbage = false
try {
  normalizeBaseUrl('http://')
} catch {
  rejectedGarbage = true
}
check('an address with no host is rejected', rejectedGarbage)

check('group normalization strips slashes', normalizeGroup('/team/') === 'team')
check('an empty group stays the global route', normalizeGroup('') === '')
check('a missing group is the global route', normalizeGroup(undefined) === '')

// --- persistence ------------------------------------------------------------

const settingsPath = settingsFilePath()
check('settings live under the harness home', settingsPath.startsWith(process.env.DSH_HOME), settingsPath)
check('settings path is dsh-mcphub/config.json', settingsPath.endsWith(join('dsh-mcphub', 'config.json')), settingsPath)

check('an absent settings file reads as empty', JSON.stringify(readSettings(settingsPath)) === '{}')

writeSettings({ baseUrl: 'http://10.0.0.5:3000', group: 'team' }, settingsPath)
check('a saved address survives a re-read', readSettings(settingsPath).baseUrl === 'http://10.0.0.5:3000')
check('a saved group survives a re-read', readSettings(settingsPath).group === 'team')

writeSettings({ group: '' }, settingsPath)
check('a patch keeps fields it does not mention', readSettings(settingsPath).baseUrl === 'http://10.0.0.5:3000')
check('a patch overwrites the fields it does', readSettings(settingsPath).group === '')

// A corrupt file must degrade to "no override", never throw: the bridge then
// starts on its defaults instead of the Host failing to boot.
writeFileSync(settingsPath, '{ this is not json', 'utf8')
check('a malformed settings file reads as empty', JSON.stringify(readSettings(settingsPath)) === '{}')
check('the bridge still resolves a usable address', resolveConnection({}).baseUrl === DEFAULT_BASE_URL)

writeFileSync(settingsPath, '[]', 'utf8')
check('a non-object settings document reads as empty', JSON.stringify(readSettings(settingsPath)) === '{}')

writeFileSync(settingsPath, JSON.stringify({ baseUrl: '', group: 3 }), 'utf8')
check('a blank stored address is ignored', readSettings(settingsPath).baseUrl === undefined)
check('a non-string stored group is ignored', readSettings(settingsPath).group === undefined)

// --- precedence -------------------------------------------------------------

// Clear the file so the remaining assertions start from "nothing saved".
writeSettings({ baseUrl: undefined, group: undefined }, settingsPath)
const defaults = resolveConnection({})
check('no saved address and no config yields the local default', defaults.baseUrl === DEFAULT_BASE_URL)
check('the default is reported as the default source', defaults.source === 'default')

const fromConfig = resolveConnection({ baseUrl: 'http://192.168.1.9:3100', group: 'ops' })
check('a profile-configured address is used when nothing is saved', fromConfig.baseUrl === 'http://192.168.1.9:3100')
check('a profile-configured group is used when nothing is saved', fromConfig.group === 'ops')
check('a configured address is reported as the config source', fromConfig.source === 'config')

writeSettings({ baseUrl: 'http://10.0.0.5:3000', group: '' }, settingsPath)
const savedWins = resolveConnection({ baseUrl: 'http://192.168.1.9:3100', group: 'ops' })
check('a saved address wins over the profile config', savedWins.baseUrl === 'http://10.0.0.5:3000')
check('a saved group wins over the profile config', savedWins.group === '')
check('a saved address is reported as the saved source', savedWins.source === 'saved')

// A hand-edited profile may carry junk; the Host must still boot.
writeSettings({ baseUrl: undefined, group: undefined }, settingsPath)
const junk = resolveConnection({ baseUrl: 'not a url at all ::' })
check('an unparseable configured address falls back to the default', junk.baseUrl === DEFAULT_BASE_URL)

// --- the connection route ---------------------------------------------------

const registered = { routes: [], tools: [], sections: [], effects: [] }
const ctx = {
  webServer: {
    register(route) {
      registered.routes.push(route)
      return () => {}
    },
  },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  effect(fn) {
    registered.effects.push(fn())
    return () => {}
  },
  get: () => undefined,
}

apply(ctx, {})
// NOTE: the effect disposers are deliberately NOT run here — disposing the
// surfaces tears the bridge down, and the route assertions below must drive a
// LIVE bridge. They run at the end of the file.

const connectionRoute = registered.routes.find((route) => route.path === '/api/dsh-mcphub/connection')
check('the connection route is registered', connectionRoute !== undefined)
check('the connection route is an exact path', connectionRoute?.kind === 'exact')

/** Build a fake loopback request carrying an optional JSON body. */
function fakeRequest(method, body, { loopback = true } = {}) {
  const listeners = {}
  const request = {
    method,
    url: '/api/dsh-mcphub/connection',
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: loopback ? '127.0.0.1' : '10.1.2.3' },
    on(event, handler) {
      listeners[event] = handler
      return request
    },
    destroy() {},
  }
  // Deliver the body on the next tick, the way a real socket would.
  setImmediate(() => {
    if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body), 'utf8'))
    listeners.end?.()
  })
  return request
}

/** Build a fake response capturing the status and JSON body. */
function fakeResponse() {
  const response = {
    status: 0,
    body: undefined,
    writeHead(status) {
      response.status = status
      return response
    },
    end(text) {
      if (typeof text === 'string' && text !== '') response.body = JSON.parse(text)
    },
  }
  return response
}

async function call(route, method, body, options) {
  const response = fakeResponse()
  await route.handler(fakeRequest(method, body, options), response)
  return response
}

// A non-loopback caller must never be able to repoint the bridge.
{
  const response = await call(connectionRoute, 'POST', { baseUrl: 'http://evil.example.com' }, { loopback: false })
  check('a non-loopback caller is refused', response.status === 403, String(response.status))
  check('a refused caller changes nothing', readSettings(settingsPath).baseUrl !== 'http://evil.example.com')
}

// An unusable body must be reported as an input error, not as a connection failure.
{
  const response = await call(connectionRoute, 'POST', { baseUrl: '   ' })
  check('an empty address is a 400', response.status === 400, String(response.status))
  check('the empty-address error names the field', typeof response.body?.error === 'string' && response.body.error.includes('地址'))
}

// Port 1 on loopback refuses instantly, so the reconnect attempt settles fast
// and the test never waits on a real network.
const unreachable = 'http://127.0.0.1:1'
{
  const response = await call(connectionRoute, 'POST', { baseUrl: unreachable })
  check('an unreachable address is still accepted (200)', response.status === 200, String(response.status))
  check('the typed address is remembered even when it does not answer',
    readSettings(settingsPath).baseUrl === unreachable, JSON.stringify(readSettings(settingsPath)))
  check('the status reports the new endpoint', response.body?.endpoint === `${unreachable}/mcp`, String(response.body?.endpoint))
  check('the status reports disconnected', response.body?.connected === false)
  check('the status carries the failure reason', typeof response.body?.error === 'string')
  check('the status reports the saved source', response.body?.source === 'saved')
  check('no tools stay registered from the previous hub', response.body?.toolCount === 0, String(response.body?.toolCount))
}

// GET reports the effective connection so the form can prefill from the Host.
{
  const response = await call(connectionRoute, 'GET')
  check('GET reports the effective address', response.body?.baseUrl === unreachable, String(response.body?.baseUrl))
  check('GET reports the local default for the reset action', response.body?.defaultBaseUrl === DEFAULT_BASE_URL)
  check('GET reports where the address is stored', typeof response.body?.settingsPath === 'string')
}

// DELETE clears the override and reconnects to the default.
{
  const response = await call(connectionRoute, 'DELETE')
  check('DELETE is accepted', response.status === 200, String(response.status))
  check('DELETE falls back to the local default', response.body?.baseUrl === DEFAULT_BASE_URL, String(response.body?.baseUrl))
  check('DELETE clears the saved address', readSettings(settingsPath).baseUrl === undefined, JSON.stringify(readSettings(settingsPath)))
  check('DELETE reports the default source', response.body?.source === 'default', String(response.body?.source))
}

// Unsupported verbs are refused rather than silently treated as a save.
{
  const response = await call(connectionRoute, 'PUT', {})
  check('an unsupported verb is a 405', response.status === 405, String(response.status))
}

// The persisted document stays human-readable and pretty-printed: the user may
// well open it, and a single-line blob would make a manual fix harder.
writeSettings({ baseUrl: 'http://localhost:3001', group: '' }, settingsPath)
check('the settings file is written with a trailing newline', readFileSync(settingsPath, 'utf8').endsWith('\n'))
check('the settings file is written pretty-printed', readFileSync(settingsPath, 'utf8').includes('\n  "baseUrl"'))

// Tear the surfaces down last, once no assertion needs a live bridge.
for (const dispose of registered.effects.splice(0)) dispose()
check('disposal runs without throwing', true)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
