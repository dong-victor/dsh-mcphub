/**
 * Bridge live test: connects the real McphubBridge to a running MCPHub
 * (http://localhost:3000), verifies tool discovery + public-name registration,
 * calls one read-only tool end-to-end, and checks the status model.
 *
 * Requires MCPHub to be up (the plugin's documented dependency).
 * Usage: node test/bridge-live.test.mjs
 */
import { McphubBridge } from '../lib/index.js'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const registered = new Map()
const ctx = {
  tools: {
    register: (def) => {
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
  },
  logger: {
    info: (...a) => console.log('  [info]', ...a),
    warn: (...a) => console.warn('  [warn]', ...a),
    error: (...a) => console.error('  [error]', ...a),
  },
}

const bridge = new McphubBridge({
  ctx,
  config: {
    baseUrl: 'http://localhost:3000',
    group: '',
    serverName: 'mcphub',
    toolCallTimeoutMs: 30_000,
    reconnect: { enabled: false },
  },
})

// The bridge starts asynchronously; await the connect attempt, then poll the
// connection state briefly (a failed attempt never rejects).
await bridge.start()
const deadline = Date.now() + 15_000
while (!bridge.connected && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250))
}
check('bridge connected to MCPHub', bridge.connected === true, bridge.lastError?.message)
if (!bridge.connected) {
  console.error(`\n${failures} CHECK(S) FAILED — MCPHub not reachable at http://localhost:3000`)
  process.exit(1)
}

check('tools discovered (>0)', bridge.tools.size > 0, `size=${bridge.tools.size}`)
check('tools registered on ctx.tools (incl. bridge tools)', registered.size === bridge.tools.size, `registered=${registered.size} discovered=${bridge.tools.size}`)

const sample = Array.from(bridge.tools.values())[0]
check('public name follows mcp__mcphub__<server>-<tool>', sample.publicName.startsWith('mcp__mcphub__'), sample.publicName)
check('raw name preserved', bridge.tools.has(sample.publicName) && bridge.tools.get(sample.publicName).rawName === sample.rawName)

// Every registered definition must expose a working execute that routes the
// raw name through mcphub. Call a read-only schema-info tool if present.
const readOnly = Array.from(bridge.tools.values()).find((t) => t.rawName.includes('get_schema_info')) ?? sample
const def = registered.get(readOnly.publicName)
check('definition present for raw tool', def !== undefined)
let callResult
let callError
try {
  callResult = await def.execute({}, { signal: undefined })
} catch (error) {
  callError = error
}
check('tool execute() resolves', callError === undefined, callError?.message)
check('tool execute() returns text content', Array.isArray(callResult?.content) && callResult.content.some((c) => c.type === 'text'))

const status = await bridge.status({ refresh: true })
check('status ok', status.ok === true && status.connected === true)
check('status endpoint correct', status.endpoint === 'http://localhost:3000/mcp')
check('status serverCount matches grouping', status.serverCount >= 1 && status.serverCount === status.servers.length)
check('status toolCount consistent', status.toolCount === bridge.tools.size)
check('status health reflects MCPHub', status.health?.ok === true && typeof status.health?.servers?.total === 'number', JSON.stringify(status.health))

// mcphub_resync path: the tool definitions are registered by apply(); here we
// exercise the same bridge.resync() the tool wraps.
const resync = await bridge.resync()
check('resync ok', resync.ok === true && resync.toolCount === bridge.tools.size, JSON.stringify(resync))

await bridge.dispose()
check('dispose clears registrations', registered.size === 0)
check('dispose drops client', bridge.client === undefined)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
