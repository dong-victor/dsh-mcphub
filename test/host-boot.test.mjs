/**
 * Host-boot regression test: simulates the loader calling the plugin's
 * apply() with stubbed services. apply() must complete without throwing and
 * register the status route, the two agent tools, and the prompt section.
 * The bridge itself starts asynchronously (never rejects), so this test does
 * not depend on MCPHub being reachable.
 *
 * Usage: node test/host-boot.test.mjs
 */
import { apply, MCPHUB_GUIDANCE, publicToolName, groupToolsByServer, endpointOf } from '../lib/index.js'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const registered = { routes: [], tools: [], sections: [] }
const disposers = []
const ctx = {
  webServer: {
    register: (route) => {
      registered.routes.push(route)
      return () => {}
    },
  },
  tools: {
    register: (tool) => {
      registered.tools.push(tool)
      return () => {}
    },
  },
  systemPrompt: {
    section: (section) => {
      registered.sections.push(section)
      return () => {}
    },
  },
  effect: (fn) => {
    const dispose = fn()
    disposers.push(dispose)
    return () => {}
  },
  get: () => undefined,
}

let applyError
try {
  apply(ctx, {})
} catch (error) {
  applyError = error
}
check('apply() completes without throwing', applyError === undefined, applyError?.message)

check('status route registered', registered.routes.length === 1 && registered.routes[0].path === '/api/dsh-mcphub/status')
check('route kind is exact', registered.routes[0]?.kind === 'exact')

const toolNames = registered.tools.map((t) => t.name)
check('mcphub_status tool registered', toolNames.includes('mcphub_status'))
check('mcphub_resync tool registered', toolNames.includes('mcphub_resync'))
check('two agent tools registered', registered.tools.length === 2)

const statusTool = registered.tools.find((t) => t.name === 'mcphub_status')
check('status tool has output schema', statusTool?.output?.schema?.type === 'object' && statusTool.output.schema.properties?.servers !== undefined)
const renderBlocks = statusTool?.output?.render?.(
  {},
  {
    ok: true,
    connected: true,
    endpoint: 'http://localhost:3000/mcp',
    baseUrl: 'http://localhost:3000',
    serverName: 'mcphub',
    group: '',
    toolCount: 2,
    serverCount: 1,
    servers: [{ name: 'demo', toolCount: 2, tools: [{ name: 'demo-q', publicName: 'mcp__mcphub__demo-q' }] }],
    lastSyncAt: new Date().toISOString(),
    health: { ok: true, status: 'healthy', servers: { total: 1, connected: 1, disconnected: 0 } },
  },
)
check('status render produces a text block', Array.isArray(renderBlocks) && typeof renderBlocks[0]?.text === 'string' && renderBlocks[0].text.includes('mcp__mcphub__demo-q'))

check('prompt section registered', registered.sections.length === 1 && registered.sections[0].name === 'plugin:dsh-mcphub')
check('prompt guidance mentions tools naming', typeof MCPHUB_GUIDANCE === 'string' && MCPHUB_GUIDANCE.includes('mcp__mcphub__'))

// Pure helpers.
check('publicToolName clean case', publicToolName('mcphub', 'demo-q') === 'mcp__mcphub__demo-q')
// Invalid characters are replaced; when replacement changes the name a
// deterministic hash suffix is appended (same contract as dsh-mcp-client).
const replaced = publicToolName('mcphub', 'a b/c')
check('publicToolName normalizes invalid chars', replaced.startsWith('mcp__mcphub__a_b_c') && /_[0-9a-f]{12}$/.test(replaced), replaced)
const long = publicToolName('mcphub', 'x'.repeat(80))
check('publicToolName truncates with hash', long.length <= 64 && /_[0-9a-f]{12}$/.test(long))

const groups = groupToolsByServer(['cassiopeia-ap-mysql-execute_sql', 'cassiopeia-ap-mysql-get_schema_info', 'cassiopeia-ep-mysql-execute_sql'])
check('groupToolsByServer splits by shared prefix', groups.length === 2 &&
  groups.some((g) => g.server === 'cassiopeia-ap-mysql' && g.tools.length === 2) &&
  groups.some((g) => g.server === 'cassiopeia-ep-mysql' && g.tools.length === 1), JSON.stringify(groups))

check('endpointOf global', endpointOf('http://localhost:3000', '') === 'http://localhost:3000/mcp')
check('endpointOf group', endpointOf('http://localhost:3000/', 'my-group') === 'http://localhost:3000/mcp/my-group')

// Disposal path: the effect disposer must run without throwing.
for (const dispose of disposers.splice(0)) dispose()
check('disposers run without throwing', true)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
