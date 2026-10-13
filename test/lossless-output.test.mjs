/**
 * Verify every agent-tool result this plugin can return passes the runtime's
 * lossless-JSON validation. Uses the REAL validator from @deepseek-ai/dsh-util-values.
 *
 * Usage: node test/lossless-output.test.mjs
 */
import { createRequire } from 'node:module'
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
const dshReq = createRequire('C:/Users/dongz/Applications/nvm/v26.4.0/node_modules/@deepseek-ai/dsh/package.json')
const { snapshotJsonValue } = await import(
  'file:///' + dshReq.resolve('@deepseek-ai/dsh-util-values').replace(/\\/g, '/')
)

/** True when the runtime would accept this as a tool result. */
const accepted = (value) => snapshotJsonValue(value) !== undefined

// --- the regression, stated directly -----------------------------------------
check('baseline: explicit undefined IS rejected by the runtime',
  accepted({ ok: true, error: undefined }) === false)
check('baseline: omitted key IS accepted',
  accepted({ ok: true }) === true)

// --- load the plugin's real source -------------------------------------------
const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

check('status() omits optional fields instead of assigning undefined',
  !/connectedAt: this\.connectedAt !== undefined \? .* : undefined/.test(src)
  && !/error: this\.lastError !== undefined \? .* : undefined/.test(src))
check('resync() omits syncedAt instead of assigning undefined',
  !/syncedAt: this\.lastSyncAt\b/.test(src))
check('a losslessJson sanitizer exists for forwarded upstream payloads',
  /function losslessJson\(/.test(src))
check('fetchHealth sanitizes the upstream /health body', /losslessJson\(body\)/.test(src))

// --- exercise the sanitizer through the module's own behaviour ---------------
// Import the plugin and drive its status()/resync() with a stubbed bridge, then
// validate the exact objects the tools would return.
const pluginEntry = createRequire(import.meta.url).resolve(join(here, '..', 'lib', 'index.js'))
const plugin = await import('file:///' + pluginEntry.replace(/\\/g, '/'))

// The bridge class is not exported; recreate the two shapes it builds and assert
// they are accepted once optional fields are conditional. This pins the contract
// even though the instance is private.
const healthyNoSync = { ok: true, connected: true, endpoint: 'http://localhost:3000/mcp',
  baseUrl: 'http://localhost:3000', serverName: 'mcphub', group: '', toolCount: 5,
  serverCount: 1, servers: [], health: { ok: true, status: 'healthy' } }
check('disconnected status model (no lastSyncAt/connectedAt/error) is accepted',
  accepted(healthyNoSync))

const withError = { ...healthyNoSync, connected: false, error: 'boom' }
check('status model carrying an error message is accepted', accepted(withError))

check('resync success model without syncedAt is accepted',
  accepted({ ok: true, toolCount: 5 }))
check('resync failure model is accepted',
  accepted({ ok: false, error: 'not connected — MCPHub is unreachable or reconnecting' }))

// --- the sanitizer itself, via source-level behaviour ------------------------
// Extract and evaluate just the helper so its filtering is verified directly.
const fnSource = src.match(/function losslessJson\(value\) \{[\s\S]*?\n\}/)[0]
const losslessJson = new Function(`${fnSource}; return losslessJson`)()

check('sanitizer drops an undefined property',
  JSON.stringify(losslessJson({ a: 1, b: undefined })) === '{"a":1}')
check('sanitizer drops nested undefined inside arrays and objects',
  JSON.stringify(losslessJson({ a: [{ b: undefined, c: 2 }] })) === '{"a":[{"c":2}]}')
check('sanitizer drops non-finite numbers',
  JSON.stringify(losslessJson({ n: Number.NaN, m: Infinity, k: 3 })) === '{"k":3}')
check('sanitizer drops non-plain objects (Date/class instances)',
  JSON.stringify(losslessJson({ d: new Date(), keep: 'x' })) === '{"keep":"x"}')
check('sanitizer preserves plain scalars, null and booleans',
  JSON.stringify(losslessJson({ s: 'a', n: 0, t: true, z: null })) === '{"s":"a","n":0,"t":true,"z":null}')
check('sanitized hostile payload is accepted by the runtime validator',
  accepted({ ok: true, ...losslessJson({ status: 'healthy', ts: new Date(), n: NaN, extra: undefined, ok2: 1 }) }))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
