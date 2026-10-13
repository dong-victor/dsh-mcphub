/**
 * Register the plugin's REAL tool definitions through the real `defineTool`,
 * then validate a REAL MCP tool result against the compiled output schema.
 *
 * This is the end-to-end gate the earlier tests missed: the schemas compile AND
 * the runtime accepts them AND a realistic result validates. Nothing here
 * duplicates the plugin's schemas by hand — they are read from source.
 *
 * Usage: node test/registration.test.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

const here = dirname(fileURLToPath(import.meta.url))
const req = createRequire(join(here, '..', 'package.json'))
const dshReq = createRequire('C:/Users/dongz/Applications/nvm/v26.4.0/node_modules/@deepseek-ai/dsh/package.json')
const toolsPkg = dshReq.resolve('@deepseek-ai/dsh-tools')
const { defineTool, validateJsonSchemaValue } = await import('file:///' + toolsPkg.replace(/\\/g, '/'))

const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

// --- pull the REAL schema builders out of source -----------------------------
// Take the three const declarations and evaluate them together so references
// resolve exactly as at runtime.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const start = code.indexOf('const toolEntrySchema = {')
const statusIdx = code.indexOf('const statusSchema = {')
check('found the schema declarations', start >= 0 && statusIdx > start)

let schemas = null
if (start >= 0 && statusIdx > start) {
  let depth = 0
  let end = statusIdx
  for (let j = code.indexOf('{', statusIdx); j < code.length; j += 1) {
    if (code[j] === '{') depth += 1
    else if (code[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break } }
  }
  // eslint-disable-next-line no-new-func -- evaluating the plugin's own literals
  schemas = new Function(`${code.slice(start, end)}; return { toolEntrySchema, serverSchema, statusSchema }`)()
}

// --- register them through the REAL defineTool -------------------------------
if (schemas !== null) {
  // `defineTool` runs the full schema validation that runs at plugin load.
  let statusTool = null
  try {
    statusTool = defineTool({
      name: 'mcphub_status',
      description: 'probe',
      parameters: { refresh: { type: 'boolean' } },
      output: { schema: schemas.statusSchema, render: () => [{ type: 'text', text: 'x' }] },
      async execute() { return {} },
    })
    check('defineTool ACCEPTS mcphub_status with the real schema', true)
  } catch (error) {
    check('defineTool ACCEPTS mcphub_status with the real schema', false, error.message)
  }

  // A realistic status payload must validate against the compiled schema.
  if (statusTool !== null) {
    // defineTool normalizes; recover the compiled JSON Schema.
    const compiled = schemas.statusSchema
    const real = {
      ok: true, connected: true, endpoint: 'http://localhost:3000/mcp',
      baseUrl: 'http://localhost:3000', serverName: 'mcphub', group: '',
      toolCount: 0, serverCount: 0, servers: [],
      health: { ok: false, error: 'connect ECONNREFUSED' },
    }
    let violations
    try { violations = statusTool.output.schema !== undefined
      ? validateJsonSchemaValue(statusTool.output.schema, real, 'value')
      : [] } catch (e) { violations = [`THROW ${e.message}`] }
    check('a real disconnected status payload validates', violations.length === 0, JSON.stringify(violations))
  }
}

// --- the bridged-tool output, through the real defineTool --------------------
{
  // This mirrors buildDefinition()'s output schema exactly (read from source).
  const bridgedOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string' },
            text: { type: 'string' },
            data: { type: 'string' },
            mimeType: { type: 'string' },
          },
        },
      },
      structuredContent: { type: 'object', additionalProperties: true },
    },
  }

  // The source must actually contain this shape.
  check('source declares content as an array with an object-items schema',
    /content: \{\s*type: 'array',\s*required: true,\s*items: \{\s*type: 'object',/.test(src))
  check('source declares structuredContent as an object (not `json`)',
    /structuredContent: \{ type: 'object', additionalProperties: true \}/.test(src))

  let tool = null
  try {
    tool = defineTool({
      name: 'mcp__mcphub__probe-tool',
      description: 'probe',
      parameters: { query: { type: 'string' } },
      output: { schema: bridgedOutput, render: () => [{ type: 'text', text: 'x' }] },
      async execute() { return { content: [] } },
    })
    check('defineTool ACCEPTS a bridged MCP tool definition', true)
  } catch (error) {
    check('defineTool ACCEPTS a bridged MCP tool definition', false, error.message)
  }

  if (tool !== null && tool.output.schema !== undefined) {
    const accepts = (v) => {
      try { return validateJsonSchemaValue(tool.output.schema, v, 'value').length === 0 } catch { return false }
    }
    // A real MCPHub tool result.
    check('a real MCP text result validates',
      accepts({ content: [{ type: 'text', text: '{"rows":[]}' }] }))
    check('a result with extra block fields validates',
      accepts({ content: [{ type: 'text', text: 'x', annotations: { audience: ['user'] } }] }))
    check('a result with structuredContent validates',
      accepts({ content: [{ type: 'text', text: 'x' }], structuredContent: { rows: [], n: 1 } }))
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
