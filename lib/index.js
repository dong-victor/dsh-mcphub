/**
 * dsh-mcphub — host half.
 *
 * Bridges every MCP server published by a local MCPHub
 * (https://github.com/samanhappy/mcphub, the `@samanhappy/mcphub` npm package,
 * dashboard at http://localhost:3000) into the dsh harness. MCPHub already
 * aggregates all its enabled servers behind one Streamable HTTP MCP endpoint
 * (the global route `/mcp`, or `/mcp/<group>` for a group), projecting each
 * upstream tool under the name `<serverName>-<toolName>`. This plugin connects
 * to that endpoint with the official MCP SDK, registers every discovered tool
 * on `ctx.tools` under the server-qualified public name
 * `mcp__<serverName>__<rawName>` (identical naming contract as
 * `@deepseek-ai/dsh-mcp-client`), and forwards `tools/call` with the raw
 * MCPHub name — no name parsing on the hot path.
 *
 * Surfaces mounted here:
 *   - GET /api/dsh-mcphub/status        (loopback-fenced, TTL-cached)
 *   - the `mcphub_status` agent tool    (what is connected / which tools)
 *   - the `mcphub_resync` agent tool    (force a tool re-sync)
 *   - a system-prompt announcement section
 *
 * The browser half (./client) renders the sidebar entry and the status panel.
 * Everything rides the official dsh seams — no dsh source changes.
 *
 * Resilience: reconnect with bounded exponential backoff on transport loss
 * (tools stay registered during an outage; calls fail until recovery), plus
 * re-sync on `notifications/tools/list_changed` so MCPHub server/tool edits
 * show up without a host restart.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'

/** Stable cordis plugin name. */
export const name = 'mcphub'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Default MCPHub base URL (dashboard + MCP endpoint origin). */
export const DEFAULT_BASE_URL = 'http://localhost:3000'

/** Default MCP server namespace used in public tool names. */
export const DEFAULT_SERVER_NAME = 'mcphub'

/** Default group scope: the global route (every enabled server). */
export const DEFAULT_GROUP = ''

/** Per-call timeout for upstream `tools/call`. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** How long one status snapshot is served from the in-memory cache. */
export const DEFAULT_STATUS_TTL_MS = 10_000

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 145

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/**
 * Loose result schema for `tools/call`: any JSON object passes. Owning the raw
 * request (like dsh-mcp-client) bypasses the SDK's per-tool outputSchema
 * validator, which can choke on upstream schemas; the executor validates the
 * shape it actually consumes.
 */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** Reconnect policy defaults (mirrors dsh-mcp-client). */
const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** Static base of the model-facing announcement (plugin presence, capabilities, limits). */
export const MCPHUB_GUIDANCE_BASE =
  '本机已安装 @dong-victor/dsh-mcphub 插件（把本地 MCPHub 发布的全部 MCP server 桥接进 DSH）：' +
  '宿主侧以 MCP Streamable HTTP 客户端连接 MCPHub 聚合端点（默认 http://localhost:3000/mcp，可配置分组 /mcp/<group>），' +
  '把 MCPHub 中每个已启用 server 的工具注册为原生工具，命名格式 mcp__mcphub__<server名>-<工具名>（如 mcp__mcphub__cassiopeia-ap-mysql-execute_sql），' +
  '直接调用即可，参数 schema 与 MCPHub 发布的一致；提供 mcphub_status（查看连接状态 / server / 工具清单）与 mcphub_resync（强制重新同步工具集）两个工具；' +
  '侧边栏「MCPHub」入口显示连接状态、server 与工具数量并支持打开 MCPHub Dashboard（http://localhost:3000）。' +
  '限制：依赖本机 MCPHub 服务在线；只桥接工具能力（资源 / 提示词暂不暴露）；工具名中的 server 前缀来自 MCPHub 配置，改名会导致工具名变化。'

/**
 * Proactive routing directive — tells the model to actively consider MCPHub
 * tools when a task matches a capability the bridged servers provide (not only
 * when the user literally names the plugin).
 */
export const MCPHUB_GUIDANCE_PROACTIVE =
  '主动调用规则：当用户任务涉及数据库查询 / 数据分析 / 表结构查看 / 示例数据 / 或其他可通过已桥接 MCP server 工具完成的操作时，' +
  '应主动判断并优先使用对应的 mcp__mcphub__<server>-<tool> 工具，而非仅依赖 pwsh / shell 命令或其他内置工具；' +
  '不要等用户明确说出「mcphub / MCPHub / mcp」关键词后才使用——根据任务语义和下方工具清单主动匹配。' +
  '若不确定有哪些可用工具，先调用 mcphub_status 查看连接状态与完整工具清单。' +
  '用户提到「mcphub / MCPHub / mcp 服务器 / 数据库查询 / 调用 mcp 工具」时即指本插件，请据此协作。'

/**
 * Build the full model-facing announcement text, including a live tool list
 * when the bridge has discovered tools. Called as a `systemPrompt.section`
 * text function so the list reflects the current bridge state at render time.
 *
 * @param {McphubBridge} bridge - the live bridge (may not be connected yet).
 * @returns {string} the announcement text for this render.
 */
export function buildGuidance(bridge) {
  const parts = [MCPHUB_GUIDANCE_BASE, MCPHUB_GUIDANCE_PROACTIVE]
  const tools = bridge?.tools
  if (tools instanceof Map && tools.size > 0) {
    const servers = bridge.servers ?? []
    if (servers.length > 0) {
      parts.push('当前已桥接的 MCP server 与工具清单（可直接调用）：')
      for (const bucket of servers) {
        const names = bucket.tools.map((raw) => {
          const entry = tools.get(publicToolName(bridge.serverName, raw))
          const desc = entry?.description ?? ''
          const pub = entry?.publicName ?? publicToolName(bridge.serverName, raw)
          const oneLine = desc.replace(/\s+/g, ' ').trim()
          return oneLine ? `\`${pub}\` — ${oneLine}` : `\`${pub}\``
        })
        parts.push(`- ${bucket.server}（${bucket.tools.length} 个工具）: ${names.join('; ')}`)
      }
    } else {
      const all = Array.from(tools.values()).map((t) => `\`${t.publicName}\``)
      parts.push(`当前已桥接 ${tools.size} 个工具: ${all.join(', ')}`)
    }
  } else {
    parts.push('（当前 MCPHub 未连接或尚未发现工具；如需查询可调用 mcphub_status 检查连接状态。）')
  }
  return parts.join('\n\n')
}

/** Resolve reconnect policy with defaults + validation. */
export function resolveReconnectPolicy(config) {
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error('mcphub: reconnect.initialDelayMs must be a positive number')
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) throw new Error('mcphub: reconnect.maxDelayMs must be a positive number')
  if (initialDelayMs > maxDelayMs) throw new Error('mcphub: reconnect.initialDelayMs must be <= maxDelayMs')
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('mcphub: reconnect.maxAttempts must be a positive integer')
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** Normalize a base URL to a bare origin ('' when empty). */
export function originOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const trimmed = value.trim().replace(/\/+$/, '')
  try {
    return new URL(trimmed).origin
  } catch {
    return trimmed
  }
}

/** Build the MCP endpoint URL: `${origin}/mcp` or `${origin}/mcp/<group>`. */
export function endpointOf(baseUrl, group) {
  const origin = originOf(baseUrl) || DEFAULT_BASE_URL
  const g = typeof group === 'string' ? group.trim().replace(/^\/+|\/+$/g, '') : ''
  return g === '' ? `${origin}/mcp` : `${origin}/mcp/${encodeURIComponent(g)}`
}

/**
 * Derive the model-facing public name for one MCPHub tool. Deterministic pure
 * function of `(serverName, rawName)` with the same contract as dsh-mcp-client:
 * `mcp__<serverName>__<rawName>` verbatim when it survives normalization,
 * otherwise a 12-hex-char SHA-256 hash suffix prevents identity collisions.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Group raw MCPHub tool names (`<server>-<tool>`, separator '-') into server
 * buckets. Heuristic: a server name is a '-' boundary prefix that is either
 * shared by >= 2 tool names, or is the longest prefix of a singleton tool
 * (that tool's own full server prefix). The longest valid prefix wins.
 * Display-only (call routing always uses the full raw name), so a miss
 * degrades to the full name minus its last '-'-segment.
 */
export function groupToolsByServer(rawNames) {
  if (!Array.isArray(rawNames) || rawNames.length === 0) return []
  const counts = new Map()
  for (const name of rawNames) {
    for (let i = 0; i < name.length; i += 1) {
      if (name[i] === '-') {
        const prefix = name.slice(0, i)
        counts.set(prefix, (counts.get(prefix) || 0) + 1)
      }
    }
  }
  const buckets = new Map()
  for (const name of rawNames) {
    let server = ''
    let best = 0
    let lastPrefix = ''
    for (let i = 0; i < name.length; i += 1) {
      if (name[i] !== '-') continue
      const prefix = name.slice(0, i)
      lastPrefix = prefix
      const seen = counts.get(prefix) || 0
      const isLast = i === name.lastIndexOf('-')
      if ((seen >= 2 || isLast) && prefix.length > best) {
        best = prefix.length
        server = prefix
      }
    }
    if (server === '' && lastPrefix !== '') server = lastPrefix
    if (server === '') {
      const cut = name.lastIndexOf('-')
      server = cut > 0 ? name.slice(0, cut) : name
    }
    let bucket = buckets.get(server)
    if (!bucket) {
      bucket = { server, tools: [] }
      buckets.set(server, bucket)
    }
    bucket.tools.push(name)
  }
  return Array.from(buckets.values()).map((b) => ({
    server: b.server,
    tools: b.tools.sort(),
  }))
}

/**
 * The value-schema types accepted by the DSL (there is no `json`).
 * @see parameterSchemaSpecToJsonSchema
 */
const DSL_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Output spec for every bridged MCP tool: `{ content, structuredContent? }`.
 *
 * `content` is a genuinely required array, expressed with the DSL's
 * per-property `required: true` annotation. That annotation is only legal in the
 * AUTHOR spec — it must be compiled away by `defineTool` before the definition
 * reaches `ctx.tools.register`, which validates the schema it is handed.
 */
const BRIDGED_OUTPUT_SPEC = {
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
    // An MCP tool result may also carry structured content; both shapes are
    // upstream-defined, so unknown members stay legal.
    structuredContent: { type: 'object', additionalProperties: true },
  },
}

/**
 * Convert one JSON Schema node into a value-schema DSL node.
 *
 * The DSL is a strict subset of JSON Schema, so unknown keywords are dropped
 * rather than forwarded (an unsupported keyword fails the whole registration).
 * `items` is converted recursively because an array node without a concrete
 * item type is rejected.
 *
 * @param node - a JSON Schema node from an upstream MCP `inputSchema`.
 * @returns an equivalent DSL node, or undefined when nothing usable remains.
 */
function toValueSpec(node) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
  const rawType = typeof node.type === 'string' ? node.type : undefined
  const type = rawType !== undefined && DSL_TYPES.has(rawType)
    ? rawType
    // A missing or unsupported type degrades to a permissive object/string
    // rather than throwing away the parameter entirely.
    : (node.properties !== undefined ? 'object' : 'string')

  const spec = { type }
  if (typeof node.description === 'string') spec.description = node.description
  if (node.default !== undefined) spec.default = node.default
  if (Array.isArray(node.enum) && node.enum.length > 0) spec.enum = node.enum

  if (type === 'array') {
    const items = toValueSpec(node.items)
    // `items` is mandatory in this subset: fall back to an open object so the
    // array still accepts the caller's values instead of rejecting them.
    spec.items = items ?? { type: 'object', additionalProperties: true }
  } else if (type === 'object') {
    const properties = {}
    let any = false
    if (typeof node.properties === 'object' && node.properties !== null) {
      for (const [key, child] of Object.entries(node.properties)) {
        const converted = toValueSpec(child)
        if (converted !== undefined) {
          properties[key] = converted
          any = true
        }
      }
    }
    // An open object keeps unmodelled keys legal, matching MCP's tolerance.
    spec.additionalProperties = true
    if (any) spec.properties = properties
  }
  return spec
}

/**
 * Convert an upstream MCP `inputSchema` into the DSL property map that
 * `defineTool` expects for `parameters`.
 *
 * `parameterSchemaSpecToJsonSchema` runs `compilePropertyMap` over this value,
 * so the result is a MAP of parameter name to schema — never an object schema
 * with a `type`/`properties` wrapper, which throws
 * `JsonSchemaError: parameters.type must be a value schema object`.
 *
 * @param inputSchema - the upstream JSON Schema (`{ type, properties, required }`).
 * @returns a DSL property map, with requiredness carried per property.
 */
export function toParameterMap(inputSchema) {
  const source = typeof inputSchema === 'object' && inputSchema !== null ? inputSchema : {}
  const properties = typeof source.properties === 'object' && source.properties !== null
    ? source.properties
    : {}
  const required = new Set(Array.isArray(source.required) ? source.required : [])
  const map = {}
  for (const [name, node] of Object.entries(properties)) {
    const spec = toValueSpec(node)
    if (spec === undefined) continue
    if (required.has(name)) spec.required = true
    map[name] = spec
  }
  return map
}

/** Extract text from an MCP content array into a single string (defensive). */
export function extractText(mcpContent, toolName) {  if (!Array.isArray(mcpContent)) return `(${toolName} returned no text content)`
  const parts = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    switch (value.type) {
      case 'text':
        if (value.text !== undefined) parts.push(value.text)
        break
      case 'image':
        parts.push(`[image: ${value.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${value.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${value.type}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

/** Extract a readable message from any thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render an error with the extra fields transport failures carry.
 *
 * `messageOf` alone loses `name`/`code`/`status`/`cause`, which are the fields
 * that actually identify an MCP handshake failure, so diagnostics use this.
 *
 * @param error - any thrown value.
 * @returns a single-line description including the useful extra fields.
 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const parts = [`${error.name}: ${error.message}`]
  for (const key of ['code', 'status', 'errno']) {
    const value = error[key]
    if (value !== undefined) parts.push(`${key}=${String(value)}`)
  }
  const cause = error.cause
  if (cause instanceof Error) parts.push(`cause=${cause.name}: ${cause.message}`)
  else if (cause !== undefined) parts.push(`cause=${String(cause)}`)
  return parts.join(' | ')
}

/**
 * Recursively drop values that are not lossless JSON.
 *
 * Every tool result is validated as lossless JSON by the runtime, which rejects
 * an explicitly-`undefined` property and any non-plain object/array. Upstream
 * payloads we merely forward (MCPHub `/health`) are not ours to pin, so they are
 * sanitized here instead of being allowed to fail the whole tool call.
 *
 * @param value - candidate value.
 * @returns the value with non-lossless members removed, or the original scalar.
 */
function losslessJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    return value.map((item) => losslessJson(item)).filter((item) => item !== undefined)
  }
  if (typeof value !== 'object' || value === undefined) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = losslessJson(item)
    if (normalized !== undefined) out[key] = normalized
  }
  return out
}

/** Resolve a logger from the context (falls back to console). */
function loggerOf(ctx) {
  return ctx?.logger ?? console
}

/**
 * The MCPHub bridge: owns one MCP client generation, keeps `ctx.tools` in sync
 * with the discovered tool set, and restarts with bounded exponential backoff
 * after transport loss.
 */
export class McphubBridge {
  /**
   * @param {object} opts
   * @param {object} opts.ctx - cordis context (tools registry, logger).
   * @param {object} opts.config - resolved plugin config.
   */
  constructor({ ctx, config }) {
    this.ctx = ctx
    this.log = loggerOf(ctx)
    this.config = config
    this.baseUrl = config.baseUrl
    this.group = config.group
    this.serverName = config.serverName
    this.endpoint = endpointOf(config.baseUrl, config.group)
    this.headers = config.headers ?? {}
    this.toolCallTimeoutMs = config.toolCallTimeoutMs
    this.policy = config.reconnect
    this.statusTtlMs = config.statusTtlMs ?? DEFAULT_STATUS_TTL_MS
    this.fetchImpl = config.fetchImpl ?? fetch

    /** Live client generation (undefined while down). */
    this.client = undefined
    /** Live tool registrations owned by this bridge: publicName -> dispose(). */
    this.disposers = new Map()
    /** Discovered tools: rawName -> {rawName, publicName, description, inputSchema}. */
    this.tools = new Map()
    /** Display-only server buckets (derived via groupToolsByServer). */
    this.servers = []
    this.connectedAt = undefined
    this.lastSyncAt = undefined
    this.lastError = undefined
    this.lastHealth = undefined
    this.lastHealthAt = 0
    this.failedAttempts = 0
    this.reconnectTimer = undefined
    this.disposed = false
    /** Serializes syncs so two generations can never interleave their swap. */
    this.syncChain = Promise.resolve()
  }

  /** @returns true when the client is connected and synced at least once. */
  get connected() {
    return this.client !== undefined && this.connectedAt !== undefined
  }

  /**
   * Start the bridge (connect + initial sync). Never rejects — failures are
   * recorded in `status()` and retried by the supervisor.
   */
  async start() {
    await this.connectGeneration(true)
  }

  /** Is this generation still the live one? */
  isCurrent(generation) {
    return !this.disposed && this.client === generation
  }

  /** One connect + initial-sync attempt; never rejects. */
  async connectGeneration(startup) {
    const label = `mcphub(${this.serverName}@${this.endpoint})`
    const generation = new Client({ name: 'dsh-mcphub', version: '0.1.0' }, { capabilities: {} })
    this.client = generation
    generation.onclose = () => {
      if (this.isCurrent(generation)) this.generationDown()
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!this.isCurrent(generation)) return
      this.log.info(`${label}: tool list changed, re-syncing`)
      try {
        await this.enqueueSync(generation)
      } catch (error) {
        if (!this.disposed) this.log.error(`${label}: tool re-sync failed: ${messageOf(error)}`)
      }
    })
    try {
      const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
        requestInit: { headers: this.headers },
      })
      await generation.connect(transport)
      await this.enqueueSync(generation)
    } catch (error) {
      this.lastError = error
      if (startup || this.isCurrent(generation)) {
        // Log the full diagnostic surface, not just the message: an MCP
        // transport failure typically carries name/code/status/cause, and the
        // bare message alone ("...failed") is not actionable.
        this.log.warn(`${label}: connection attempt failed: ${describeError(error)}`)
      }
      try {
        await generation.close()
      } catch {}
      this.generationDown()
      return
    }
    if (!this.isCurrent(generation)) return
    this.connectedAt = Date.now()
    this.lastError = undefined
    if (this.failedAttempts > 0) {
      this.log.info(`${label}: reconnected (attempt ${this.failedAttempts + 1})`)
    }
    this.failedAttempts = 0
  }

  /** Serialized tool sync: fetch + swap registrations for one generation. */
  enqueueSync(generation) {
    const run = this.syncChain.then(async () => {
      if (!this.isCurrent(generation)) return
      await this.syncTools(generation)
    })
    this.syncChain = run.catch(() => {})
    return run
  }

  /** List tools and swap the registered generation (atomic-ish: fetch first). */
  async syncTools(generation) {
    const { tools: listed } = await generation.listTools()
    const next = new Map()
    const definitions = []
    for (const tool of listed) {
      const publicName = publicToolName(this.serverName, tool.name)
      if (next.has(publicName)) {
        throw new Error(`mcphub(${this.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      next.set(publicName, {
        rawName: tool.name,
        publicName,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      })
      definitions.push(this.buildDefinition(tool.name, publicName, tool))
    }
    // Swap: dispose previous generation, register the new one.
    for (const dispose of this.disposers.values()) dispose()
    const disposers = new Map()
    try {
      for (const def of definitions) disposers.set(def.name, this.ctx.tools.register(def))
    } catch (error) {
      for (const dispose of disposers.values()) dispose()
      throw error
    }
    this.disposers = disposers
    this.tools = next
    this.servers = groupToolsByServer(Array.from(next.keys(), (k) => next.get(k).rawName))
    this.lastSyncAt = new Date().toISOString()
  }

  /**
   * Register one MCPHub tool on `ctx.tools`.
   *
   * BOTH schema fields go through the value-schema DSL — neither is raw JSON
   * Schema — but they take different shapes:
   *   - `parameters`: compiled by `parameterSchemaSpecToJsonSchema`, which calls
   *     `compilePropertyMap(spec, "parameters")`. The spec is therefore a
   *     PROPERTY MAP (`{ name: <value schema>, … }`) and must NOT carry a
   *     `type: 'object'` / `properties` wrapper. The upstream MCP `inputSchema`
   *     is a JSON Schema, so it is CONVERTED by `toParameterMap()` rather than
   *     passed through.
   *   - `output.schema`: compiled by `valueSchemaSpecToJsonSchema` (which DOES
   *     take an object root with `properties`) and then re-validated by
   *     `assertSupportedJsonSchema`. Both gates must pass and the second is the
   *     strict one:
   *       · types are limited to object/array/string/number/integer/boolean/null
   *         — there is deliberately NO unconstrained `json` node;
   *       · `required` is legal only on an object, and a DSL `required: true` is
   *         a per-property annotation on the OWNING object (the compiler lifts
   *         it into that object's `required` array — never write it on an
   *         `array`/scalar node yourself);
   *       · every `items` needs a concrete type.
   *     A raw JSON Schema here throws `JsonSchemaError` at registration time.
   */
  buildDefinition(rawName, publicName, tool) {
    const bridge = this
    return defineTool({
      name: publicName,
      description: tool.description ?? '',
      // The upstream JSON Schema must be CONVERTED: `parameters` is a DSL
      // property map, not a raw JSON Schema document.
      parameters: toParameterMap(tool.inputSchema),
      output: {
        // Compiled by `defineTool` below; see BRIDGED_OUTPUT_SPEC for why the
        // spec must not be handed to `ctx.tools.register` directly.
        schema: BRIDGED_OUTPUT_SPEC,
        render(_args, value) {
          return [{ type: 'text', text: extractText(value.content, rawName) }]
        },
      },
      async execute(args, exec) {
        const result = await bridge.callTool(rawName, typeof args === 'object' && args !== null ? args : {}, exec?.signal)
        if (result.isError === true) {
          throw new Error(extractText(result.content, rawName) || `MCPHub tool "${rawName}" failed`)
        }
        return {
          content: result.content,
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        }
      },
    })
  }

  /** Forward one `tools/call` with the raw MCPHub name (never the public name). */
  async callTool(rawName, args, signal) {
    const client = this.client
    if (client === undefined) {
      throw new Error(`mcphub(${this.serverName}): not connected — MCPHub is unreachable or reconnecting; call mcphub_status to inspect`)
    }
    try {
      return await client.request(
        { method: 'tools/call', params: { name: rawName, arguments: args } },
        RawCallToolResultSchema,
        { signal, timeout: this.toolCallTimeoutMs },
      )
    } catch (error) {
      this.lastError = error
      throw error
    }
  }

  /** Transport loss: record and schedule a bounded-backoff reconnect. */
  generationDown() {
    if (this.disposed) return
    this.client = undefined
    this.connectedAt = undefined
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    const label = `mcphub(${this.serverName}@${this.endpoint})`
    if (!this.policy.enabled) {
      this.log.error(`${label}: connection lost and reconnect is disabled — registered tools will fail until reload`)
      return
    }
    this.failedAttempts += 1
    if (this.failedAttempts > this.policy.maxAttempts) {
      this.log.error(`${label}: giving up after ${this.policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      this.unregisterAll()
      return
    }
    const delayMs = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** (this.failedAttempts - 1))
    this.log.warn(`${label}: connection lost; reconnecting in ${delayMs}ms (attempt ${this.failedAttempts}/${this.policy.maxAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connectGeneration(false)
    }, delayMs)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  /** Drop every registered tool (used on final failure / dispose). */
  unregisterAll() {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers = new Map()
    this.tools = new Map()
    this.servers = []
    this.lastSyncAt = undefined
  }

  /** Force a re-sync against the live generation (agent tool + refresh path). */
  async resync() {
    const generation = this.client
    if (generation === undefined) {
      return { ok: false, error: 'not connected — MCPHub is unreachable or reconnecting' }
    }
    try {
      await this.enqueueSync(generation)
      // Omit `syncedAt` when unknown — an explicit `undefined` would fail the
      // lossless-JSON validation applied to every tool result.
      const model = { ok: true, toolCount: this.tools.size }
      if (this.lastSyncAt !== undefined) model.syncedAt = this.lastSyncAt
      return model
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** Fetch MCPHub's unauthenticated /health snapshot (cached per statusTtlMs). */
  async fetchHealth({ refresh = false } = {}) {
    const now = Date.now()
    if (!refresh && this.lastHealth !== undefined && now - this.lastHealthAt < this.statusTtlMs) {
      return this.lastHealth
    }
    const origin = originOf(this.baseUrl) || DEFAULT_BASE_URL
    try {
      const response = await this.fetchImpl(`${origin}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        this.lastHealth = { ok: false, error: `HTTP ${response.status}` }
      } else {
        const body = await response.json()
        // Upstream shape is not ours to pin; sanitize so a stray `undefined` or
        // exotic value cannot fail the tool's lossless-JSON output validation.
        // Guard the non-object case (null / scalar / dropped) so the spread
        // below always has an object to work with.
        const safe = losslessJson(body)
        this.lastHealth = safe !== null && typeof safe === 'object' && !Array.isArray(safe)
          ? { ok: true, ...safe }
          : { ok: true, health: safe }
      }
    } catch (error) {
      this.lastHealth = { ok: false, error: messageOf(error) }
    }
    this.lastHealthAt = Date.now()
    return this.lastHealth
  }

  /** Build the status model (route + agent tool share this). */
  async status({ refresh = false } = {}) {
    const servers = this.servers.map((bucket) => ({
      name: bucket.server,
      toolCount: bucket.tools.length,
      tools: bucket.tools.map((rawName) => ({
        name: rawName,
        publicName: publicToolName(this.serverName, rawName),
      })),
    }))
    const health = await this.fetchHealth({ refresh })
    // Optional fields are OMITTED rather than set to `undefined`: a tool result
    // is validated as lossless JSON, and an explicitly-`undefined` property
    // fails that check ("value is not lossless JSON") even though the key would
    // vanish on serialization.
    const model = {
      ok: true,
      connected: this.connected,
      endpoint: this.endpoint,
      baseUrl: originOf(this.baseUrl) || DEFAULT_BASE_URL,
      serverName: this.serverName,
      group: this.group,
      toolCount: this.tools.size,
      serverCount: servers.length,
      servers,
      health,
    }
    if (this.lastSyncAt !== undefined) model.lastSyncAt = this.lastSyncAt
    if (this.connectedAt !== undefined) model.connectedAt = new Date(this.connectedAt).toISOString()
    if (this.lastError !== undefined) model.error = describeError(this.lastError)
    return model
  }

  /** Release the connection and every registration. */
  async dispose() {
    this.disposed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const current = this.client
    this.client = undefined
    if (current !== undefined) {
      try {
        await current.close()
      } catch {}
    }
    await this.syncChain
    this.unregisterAll()
  }
}

/** Render the status model as agent-facing text (markdown). */
export function renderStatusText(value) {
  const lines = []
  if (value?.ok !== true) {
    lines.push(`MCPHub 状态查询失败：${value?.error ?? 'unknown error'}`)
    return lines.join('\n')
  }
  const health = value.health
  const healthText = health?.ok === true
    ? `MCPHub 健康: ${health.status} · servers ${health.servers?.connected ?? '?'}/${health.servers?.total ?? '?'} 已连接`
    : `MCPHub 健康检查失败: ${health?.error ?? '未知'}`
  lines.push(`MCPHub 桥接状态（${value.connected ? '已连接' : '未连接'}）:`)
  lines.push(`- 端点: ${value.endpoint}${value.group ? `（分组 ${value.group}）` : '（全局聚合）'} · 命名空间: ${value.serverName}`)
  lines.push(`- 工具: ${value.toolCount} 个 · server: ${value.serverCount} 个`)
  lines.push(`- ${healthText}`)
  if (value.lastSyncAt) lines.push(`- 上次同步: ${new Date(value.lastSyncAt).toLocaleString()}`)
  if (value.error) lines.push(`- 最近错误: ${value.error}`)
  if (value.servers && value.servers.length > 0) {
    lines.push('')
    lines.push('| server | 工具数 | 工具（DSH 中调用名） |')
    lines.push('| --- | --- | --- |')
    for (const server of value.servers) {
      const names = server.tools.map((t) => `\`${t.publicName}\``).join(', ')
      lines.push(`| ${server.name} | ${server.toolCount} | ${names} |`)
    }
    lines.push('')
    lines.push('直接调用上面的工具名即可，例如 `mcp__mcphub__<server>-<tool>`。')
  }
  return lines.join('\n')
}

/** Loopback check plus browser same-origin markers (same fence as sibling plugins). */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/**
 * Mount the bridge, the status route, the agent tools, and the announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (defaults applied here).
 */
export function apply(ctx, config) {
  const resolved = {
    enabled: config?.enabled ?? true,
    baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL,
    group: config?.group ?? DEFAULT_GROUP,
    serverName: config?.serverName ?? DEFAULT_SERVER_NAME,
    headers: config?.headers ?? {},
    announceToAgent: config?.announceToAgent ?? true,
    toolCallTimeoutMs: config?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    statusTtlMs: config?.statusTtlMs ?? DEFAULT_STATUS_TTL_MS,
    reconnect: resolveReconnectPolicy(config?.reconnect),
    fetchImpl: config?.fetchImpl,
  }
  if (!resolved.enabled) return

  const bridge = new McphubBridge({ ctx, config: resolved })

  // The status route: exact path, loopback-fenced, TTL cache unless ?refresh=1.
  const route = {
    kind: 'exact',
    path: '/api/dsh-mcphub/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      let refresh = false
      try {
        refresh = new URL(req.url ?? '/', 'http://x').searchParams.get('refresh') === '1'
      } catch {
        refresh = false
      }
      const outcome = await bridge.status({ refresh })
      writeJson(res, 200, outcome)
    },
  }

  // Output schemas in the dsh 0.2.0-rc.2 value-schema DSL: object roots carry
  // `additionalProperties`, requiredness is a per-property `required: true`
  // annotation, and unconstrained payloads use the author-only `json` node.
  const toolEntrySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      publicName: { type: 'string', required: true },
    },
  }
  const serverSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      toolCount: { type: 'number', required: true },
      // `required` is legal only on an OBJECT node: on an array it either makes
      // the compiler emit `required` next to `type: "array"` (rejected by
      // `assertSupportedJsonSchema`) or is silently dropped. Declaredness is
      // therefore expressed per-property, on the owning object.
      tools: { type: 'array', items: toolEntrySchema },
    },
  }
  const statusSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      connected: { type: 'boolean', required: true },
      endpoint: { type: 'string', required: true },
      baseUrl: { type: 'string', required: true },
      serverName: { type: 'string', required: true },
      group: { type: 'string', required: true },
      toolCount: { type: 'number', required: true },
      serverCount: { type: 'number', required: true },
      servers: { type: 'array', items: serverSchema },
      lastSyncAt: { type: 'string' },
      connectedAt: { type: 'string' },
      error: { type: 'string' },
      // MCPHub /health is an upstream payload; its shape is not ours to pin.
      // A concrete type is required (there is no `json` node in this subset).
      health: { type: 'object', additionalProperties: true },
    },
  }

  // Agent tool: report the bridge status (what is connected, which tools).
  const statusTool = defineTool({
    name: 'mcphub_status',
    description:
      'Query the status of the dsh-mcphub bridge to the local MCPHub: connection state, endpoint, ' +
      'discovered servers and their tools (with the exact DSH callable names `mcp__mcphub__<server>-<tool>`), ' +
      'tool counts and MCPHub /health. Triggers: mcphub 状态, mcphub 上有什么工具/服务器, mcp 工具列表, 数据库工具不可用时排查.',
    parameters: {
      refresh: { type: 'boolean', description: 'Bypass the status TTL cache and re-check.' },
    },
    output: {
      schema: statusSchema,
      render: (_args, value) => [{ type: 'text', text: renderStatusText(value) }],
    },
    async execute(args) {
      return bridge.status({ refresh: args.refresh === true })
    },
  })

  // Agent tool: force a tool re-sync (after MCPHub server/tool edits).
  const resyncTool = defineTool({
    name: 'mcphub_resync',
    description:
      'Force a re-sync of the tool set from the local MCPHub (re-run tools/list and swap registrations). ' +
      'Use after MCPHub servers/tools were added, removed or renamed and the new tools are not visible yet. ' +
      'Triggers: 刷新 mcphub 工具, 重新同步 mcp 工具, mcphub 工具没更新.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          toolCount: { type: 'number' },
          syncedAt: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? `MCPHub 工具已重新同步：${value.toolCount} 个工具（同步于 ${value.syncedAt ? new Date(value.syncedAt).toLocaleString() : '刚刚'}）`
          : `MCPHub 重新同步失败：${value.error ?? 'unknown error'}`,
      }],
    },
    async execute() {
      return bridge.resync()
    },
  })

  const disposeRoute = ctx.webServer.register(route)
  const disposeStatusTool = ctx.tools.register(statusTool)
  const disposeResyncTool = ctx.tools.register(resyncTool)
  let disposeSection
  if (resolved.announceToAgent) {
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-mcphub',
      order: SECTION_ORDER,
      text: () => buildGuidance(bridge),
    })
  }
  void bridge.start()

  ctx.effect(() => () => {
    disposeRoute()
    disposeStatusTool()
    disposeResyncTool()
    disposeSection?.()
    void bridge.dispose()
  }, 'dsh-mcphub: surfaces')
}
