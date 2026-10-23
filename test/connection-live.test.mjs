/**
 * Real-HTTP verification of the connection route (not part of `npm test`).
 *
 * Every other test drives the route handler with fake req/res objects. That
 * proves the logic but not the plumbing: a real socket proves the loopback
 * fence reads the actual `remoteAddress`/`host`, that `readBody` assembles the
 * body from real `data`/`end` events, and that the JSON the browser will parse
 * is what actually goes over the wire.
 *
 * Usage: node test/connection-live.test.mjs   (needs the local MCPHub running)
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-mcphub-live-'))

const { apply } = await import('../lib/index.js')

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
  }
}

// --- mount the plugin's routes on a real server -----------------------------

const routes = new Map()
const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  effect(fn) {
    const dispose = fn()
    process.on('exit', () => dispose())
    return () => {}
  },
  get: () => undefined,
}

apply(ctx, {})
check('both routes were mounted', routes.size === 2, Array.from(routes.keys()).join(','))

const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url, 'http://x').pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  void route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

/** One real HTTP call. */
async function call(path, init) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/**
 * Wait for the bridge to reach a connection state.
 *
 * `apply()` connects in the background, so the first probe can easily arrive
 * before the handshake finished; polling keeps the assertions about behaviour
 * instead of about timing.
 *
 * @param wanted - the `connected` value to wait for.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the last status payload seen.
 */
async function waitForConnected(wanted, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = (await call('/api/dsh-mcphub/status?refresh=1')).body
    if (last?.connected === wanted) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return last
}

// --- the live MCPHub is reachable, so the status route must say so ----------

const status = await waitForConnected(true)
check('status route answers over a real socket', status?.ok === true, JSON.stringify(status?.error))
check('status reports the live MCPHub', status?.connected === true, JSON.stringify(status?.error))
check('status is the local default by default', status?.baseUrl === 'http://localhost:3000', String(status?.baseUrl))
const toolCountBefore = status?.toolCount ?? 0
check('status lists the bridged tools', toolCountBefore > 0, String(toolCountBefore))

// --- GET reports the effective connection for the form ---------------------

const read = await call('/api/dsh-mcphub/connection')
check('GET default address is the local hub', read.body?.baseUrl === 'http://localhost:3000', String(read.body?.baseUrl))
check('GET reports the default for restore', read.body?.defaultBaseUrl === 'http://localhost:3000')
check('GET reports a settings path under the harness home',
  typeof read.body?.settingsPath === 'string' && read.body.settingsPath.startsWith(process.env.DSH_HOME))

// --- a typo is an input error, and changes nothing ------------------------

const badJson = await call('/api/dsh-mcphub/connection', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
})
check('malformed JSON is a 400', badJson.status === 400, String(badJson.status))

const badAddress = await call('/api/dsh-mcphub/connection', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: 'nope://x' }),
})
check('a non-http address is a 400', badAddress.status === 400, String(badAddress.status))
check('a rejected address leaves the bridge alone',
  (await call('/api/dsh-mcphub/status')).body?.baseUrl === 'http://localhost:3000')

// --- a real save repoints the bridge and survives a reload ----------------

const saved = await call('/api/dsh-mcphub/connection', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ baseUrl: 'localhost:3000/', group: '' }),
})
check('a bare host:port save is accepted', saved.status === 200, String(saved.status))
check('the saved address is normalized to an origin', saved.body?.baseUrl === 'http://localhost:3000', String(saved.body?.baseUrl))
check('the status after the save reports connected', saved.body?.connected === true, String(saved.body?.error))
check('the tool set survived the reconnect', (saved.body?.toolCount ?? 0) === toolCountBefore,
  `${saved.body?.toolCount} vs ${toolCountBefore}`)

const reread = await call('/api/dsh-mcphub/connection')
check('the saved address is persisted to disk', reread.body?.baseUrl === 'http://localhost:3000')

// --- restore default ------------------------------------------------------

const cleared = await call('/api/dsh-mcphub/connection', { method: 'DELETE' })
check('DELETE restores the local default', cleared.body?.baseUrl === 'http://localhost:3000', String(cleared.body?.baseUrl))
check('DELETE reports the default source', cleared.body?.source === 'default', String(cleared.body?.source))
check('the bridge is connected after restore', cleared.body?.connected === true, String(cleared.body?.error))

// --- the fence holds against a non-loopback Host header -------------------

/**
 * One raw HTTP call that keeps a chosen `Host` header.
 *
 * `fetch` derives `Host` from the URL and refuses to let it be overridden, so
 * the DNS-rebinding shape the fence exists for can only be reproduced with
 * `http.request`.
 */
function rawCall({ method = 'GET', path, host, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        host,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.length }),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
        resolve({ status: response.statusCode, body: parsed })
      })
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

const fenced = await rawCall({
  method: 'POST',
  path: '/api/dsh-mcphub/connection',
  host: 'evil.example.com',
  body: JSON.stringify({ baseUrl: 'http://evil.example.com:3000' }),
})
check('a non-loopback Host header is refused', fenced.status === 403, String(fenced.status))
check('the fenced request changed nothing',
  (await call('/api/dsh-mcphub/connection')).body?.baseUrl === 'http://localhost:3000',
  JSON.stringify((await call('/api/dsh-mcphub/connection')).body))

// The fence is about the Host header, not about raw HTTP: the same call with a
// loopback Host must still work, otherwise the test above would "pass" on a
// route that simply refuses everything.
const sameOrigin = await rawCall({
  method: 'POST',
  path: '/api/dsh-mcphub/connection',
  host: `127.0.0.1:${port}`,
  body: JSON.stringify({ baseUrl: 'http://localhost:3000', group: '' }),
})
check('a loopback Host header is still accepted', sameOrigin.status === 200, String(sameOrigin.status))

// Restore the default so this verification leaves no saved override behind.
await call('/api/dsh-mcphub/connection', { method: 'DELETE' })
check('the verification leaves no saved override',
  (await call('/api/dsh-mcphub/connection')).body?.source === 'default')

await new Promise((resolve) => server.close(resolve))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
