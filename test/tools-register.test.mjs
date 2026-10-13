/**
 * End-to-end: connect to the LIVE MCPHub, convert every discovered tool through
 * the plugin's real buildDefinition, and register each one through the real
 * `defineTool`. This is the check that would have caught the parameters bug.
 *
 * Requires MCPHub at http://localhost:3000.
 * Usage: node test/tools-register.test.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McphubBridge, toParameterMap } from '../lib/index.js'

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

const here = dirname(fileURLToPath(import.meta.url))
const dshReq = createRequire('C:/Users/dongz/Applications/nvm/v26.4.0/node_modules/@deepseek-ai/dsh/package.json')
const { assertSupportedJsonSchema } = await import(
  'file:///' + dshReq.resolve('@deepseek-ai/dsh-tools').replace(/\\/g, '/')
)

// --- connect to the live hub -------------------------------------------------
const registered = new Map()
const bridge = new McphubBridge({
  ctx: {
    tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name) } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  },
  config: { baseUrl: 'http://localhost:3000', group: '', serverName: 'mcphub', reconnect: { enabled: false } },
})

await bridge.ensureStarted?.()
// Drive one connect+sync attempt the way the plugin does.
await bridge.connectGeneration?.(true)
await new Promise((r) => setTimeout(r, 500))

const tools = [...bridge.tools.values()]
check('discovered tools from the live hub', tools.length > 0, `got ${tools.length}`)

// --- every discovered tool must register through the REAL defineTool ---------
let registeredCount = 0
for (const tool of tools) {
  // buildDefinition now returns an ALREADY-COMPILED definition (it routes the
  // spec through defineTool internally), which is exactly what the runtime
  // hands to `ctx.tools.register`.
  let def
  try {
    def = bridge.buildDefinition(tool.rawName, tool.publicName, tool)
  } catch (error) {
    check(`${tool.rawName}: buildDefinition compiles`, false, `${error.name}: ${error.message}`)
    continue
  }

  // The REAL gate: `ctx.tools.register` validates the schema it is given
  // (dsh-tools index.js:2882), with no further compilation.
  try {
    assertSupportedJsonSchema(def.output.schema)
    registeredCount += 1
    check(`${tool.rawName}: output.schema passes the register gate`, true)
  } catch (error) {
    check(`${tool.rawName}: output.schema passes the register gate`, false,
      `${error.name}: ${error.message}`)
    continue
  }

  // The upstream parameter names must survive, and `required` must now be the
  // compiled JSON-Schema array form (not the DSL `required: true` annotation).
  const upstreamNames = Object.keys(tool.inputSchema?.properties ?? {}).sort()
  const compiledNames = Object.keys(def.parameters?.properties ?? {}).sort()
  if (upstreamNames.length > 0) {
    check(`${tool.rawName}: parameter names preserved (${upstreamNames.join(',')})`,
      JSON.stringify(upstreamNames) === JSON.stringify(compiledNames),
      `expected ${JSON.stringify(upstreamNames)} got ${JSON.stringify(compiledNames)}`)
  }
  const upstreamRequired = (tool.inputSchema?.required ?? []).slice().sort()
  const compiledRequired = (def.parameters?.required ?? []).slice().sort()
  check(`${tool.rawName}: required parameters preserved`,
    JSON.stringify(upstreamRequired) === JSON.stringify(compiledRequired),
    `expected ${JSON.stringify(upstreamRequired)} got ${JSON.stringify(compiledRequired)}`)

  // `required: true` must be GONE from the compiled tree: it is author-spec only
  // and any surviving boolean is what trips the register gate.
  check(`${tool.rawName}: no DSL \`required: true\` survives compilation`,
    JSON.stringify(def.output.schema).includes('"required":true') === false)
}
check('every discovered tool registered', registeredCount === tools.length,
  `${registeredCount}/${tools.length}`)

// --- the conversion unit itself ----------------------------------------------
check('toParameterMap yields a property MAP (no type/properties wrapper)', (() => {
  const map = toParameterMap({ type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] })
  return map.type === undefined && map.properties === undefined && map.sql?.type === 'string'
})())
check('toParameterMap preserves required as a per-property annotation',
  toParameterMap({ type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }).sql.required === true)
check('toParameterMap converts array items',
  toParameterMap({ properties: { q: { type: 'array', items: { type: 'string' } } } }).q.items.type === 'string')
check('toParameterMap tolerates an undefined schema', Object.keys(toParameterMap(undefined)).length === 0)

await bridge.dispose?.()

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
