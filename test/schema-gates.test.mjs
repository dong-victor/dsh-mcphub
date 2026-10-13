/**
 * Verify every tool schema this plugin declares passes BOTH runtime gates:
 *   1. the author DSL compiles it (`valueSchemaSpecToJsonSchema`)
 *   2. the compiled JSON Schema is inside the supported subset
 *      (`assertSupportedJsonSchema`)
 *
 * Gate 2 is the one that bit us: `required` is legal only on an `object`, and
 * the subset has no `json` type — both compile fine and only fail at
 * registration, which is invisible until the plugin runs against a live tool.
 *
 * Usage: node test/schema-gates.test.mjs
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
const req = createRequire(join(here, '..', 'package.json'))
const { valueSchemaSpecToJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } = await import(
  'file:///' + req.resolve('@deepseek-ai/dsh-tools').replace(/\\/g, '/')
)

/** Run both gates; returns the compiled schema or throws with a combined reason. */
function gate(label, spec) {
  let compiled
  try {
    compiled = valueSchemaSpecToJsonSchema(spec)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label} — compile: ${error.message}`)
    return null
  }
  try {
    assertSupportedJsonSchema(compiled)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label} — assertSupportedJsonSchema: ${error.message}`)
    return null
  }
  console.log(`  ok  ${label}`)
  return compiled
}

const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

// --- negative controls: prove the gates really reject the old shapes ---------
let rejectedRequiredOnArray = false
try {
  assertSupportedJsonSchema({ type: 'object', properties: { a: { type: 'array', required: true, items: { type: 'string' } } } })
} catch { rejectedRequiredOnArray = true }
check('gate 2 rejects `required` on an array (the shipped bug)', rejectedRequiredOnArray)

let rejectedJsonType = false
try {
  assertSupportedJsonSchema({ type: 'object', properties: { a: { type: 'json' } } })
} catch { rejectedJsonType = true }
check('gate 2 rejects the `json` type (the shipped bug)', rejectedJsonType)

// --- the plugin must not contain those shapes any more -----------------------
// Strip comments first: the doc comments legitimately MENTION `type: 'json'`
// when explaining why it is not usable here.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

check('no `type: \'json\'` schema node remains in the executable code',
  /type: 'json'/.test(code) === false,
  (code.match(/type: 'json'/) ?? [])[0])

// `required: true` in the DSL is a PER-PROPERTY annotation owned by the parent
// object: the compiler LIFTS it into the parent's `required` array and never
// emits it on the property node. So `{ type: 'array', required: true, ... }` is
// correct DSL, while a raw `required: [...]` INSIDE an array node is the illegal
// form. Assert the semantics on the COMPILED output, not by text matching.
{
  const probe = valueSchemaSpecToJsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'array', required: true, items: { type: 'string' } } },
  })
  check('DSL lifts `required: true` into the parent required array',
    JSON.stringify(probe.required) === '["content"]')
  check('compiled array node carries no `required` of its own',
    Object.keys(probe.properties.content).sort().join(',') === 'items,type',
    Object.keys(probe.properties.content).join(','))

  let rawRejected = false
  try {
    assertSupportedJsonSchema({ type: 'object', properties: { a: { type: 'array', required: ['x'], items: { type: 'string' } } } })
  } catch { rawRejected = true }
  check('a raw `required` inside an array node is rejected', rawRejected)
}

// The bridged-tool `content` must remain genuinely required in the compiled form.
{
  const compiledTool = valueSchemaSpecToJsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      content: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' } } },
      },
      structuredContent: { type: 'object', additionalProperties: true },
    },
  })
  check('bridged result: `content` is required', JSON.stringify(compiledTool.required) === '["content"]')
  check('bridged result: content array node has no own `required`',
    Object.keys(compiledTool.properties.content).sort().join(',') === 'items,type')
}

// --- every real schema is extracted from source and gated --------------------
// Evaluate the module-level schema builders so we gate the ACTUAL objects.
const moduleShapes = {
  'bridged MCP tool result': {
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
  },
}

// Evaluate the schema declarations together, in source order, so references like
// `items: toolEntrySchema` resolve exactly as they do at runtime.
const declStart = code.indexOf('const toolEntrySchema = {')
const declEnd = code.indexOf('const statusSchema = {')
check('schema declarations located in source', declStart >= 0 && declEnd > declStart)
if (declStart >= 0 && declEnd > declStart) {
  // Take everything from toolEntrySchema through the end of statusSchema.
  let depth = 0
  let end = declEnd
  for (let j = code.indexOf('{', declEnd); j < code.length; j += 1) {
    if (code[j] === '{') depth += 1
    else if (code[j] === '}') {
      depth -= 1
      if (depth === 0) { end = j + 1; break }
    }
  }
  const block = code.slice(declStart, end)
  // eslint-disable-next-line no-new-func -- test-local evaluation of real declarations
  const make = new Function(`${block}; return { toolEntrySchema, serverSchema, statusSchema }`)
  try {
    const schemas = make()
    gate('toolEntrySchema passes both gates', schemas.toolEntrySchema)
    gate('serverSchema passes both gates', schemas.serverSchema)
    gate('statusSchema passes both gates', schemas.statusSchema)
  } catch (error) {
    failures += 1
    console.error(`FAIL  schema declarations evaluate — ${error.message}`)
  }
}

// The bridged-tool schema is inline inside buildDefinition; gate its shape too.
gate('bridged MCP tool result passes both gates', moduleShapes['bridged MCP tool result'])

// --- behaviour: a realistic MCP result validates ------------------------------
const compiled = gate('bridged result (compiled for behaviour checks)', moduleShapes['bridged MCP tool result'])
if (compiled !== null) {
  const accepts = (v) => {
    try { return validateJsonSchemaValue(compiled, v, 'value').length === 0 } catch { return false }
  }
  check('accepts a text content block', accepts({ content: [{ type: 'text', text: 'hi' }] }))
  check('accepts an image content block', accepts({ content: [{ type: 'image', data: 'b64', mimeType: 'image/png' }] }))
  check('accepts structuredContent', accepts({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } }))
  check('accepts empty content', accepts({ content: [] }))
  check('rejects missing content', accepts({}) === false)
  check('rejects a non-array content', accepts({ content: 'nope' }) === false)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
