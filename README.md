# @dong-victor/dsh-mcphub

DSH Web GUI 插件：把本地 [MCPHub](https://github.com/samanhappy/mcphub)（`@samanhappy/mcphub`，Dashboard 默认 `http://localhost:3000`）一站式聚合暴露的**全部 MCP server 工具**桥接进 DSH，让 agent 在会话里直接调用。

MCPHub 自身就是一个 MCP server：它把所有已启用的 server 聚合在一个 Streamable HTTP 端点 `/mcp`（全局路由，工具名投影为 `<server名>-<工具名>`；也可用 `/mcp/<group>` 分组路由）。本插件用官方 MCP SDK 作为客户端连接该端点，把发现到的每个工具注册为 DSH 原生 agent 工具：

```
mcp__mcphub__<server名>-<工具名>
# 例：mcp__mcphub__cassiopeia-ap-mysql-execute_sql
```

调用时参数 schema 与 MCPHub 发布的一致；`tools/call` 原样转发原始工具名（不做名字解析），调用结果按 MCP 文本块投影回模型上下文。

## 能力

- **工具桥接**：连接 MCPHub 聚合端点（或分组端点），注册全部工具为 agent 原生工具（命名规范与 `@deepseek-ai/dsh-mcp-client` 一致：64 字符限制、非法字符替换、必要时追加确定性 hash）。
- **agent 工具**：
  - `mcphub_status` —— 连接状态、端点、server / 工具清单（含 DSH 可调用名）、MCPHub `/health`；
  - `mcphub_resync` —— 强制重新同步工具集（MCPHub 侧增删改 server / 工具后使用）。
- **插件详情页「MCPHub 桥接」区块**：注册到 DSH 插件管理页的 `plugins.detail.section` 槽位（list 类型），只在本插件（`@dong-victor/dsh-mcphub`）**自己的详情页**渲染——入口为 **设置 → 插件 → MCPHub → 详情**。区块内容：**可编辑的 MCPHub 地址表单**、连接徽章、端点 / 分组 / 健康 / 上次同步 / 最近错误、按 server 分组的工具清单（可展开）、「打开 MCPHub Dashboard」外链、手动刷新。
  - 槽位契约要求每个注册项自行判断「当前打开的是哪个插件的详情页」，对不属于自己的 subject 返回 `null`；本插件只匹配 `{ kind: 'bundle', pkg: { name: '@dong-victor/dsh-mcphub' } }`，包内某个 row 的详情页（`kind: 'row'`）不重复渲染。
- **地址可编辑 + 动态重连**：默认连本地 `http://localhost:3000`，地址与分组在详情页直接改。保存后写入 `~/.dsh/dsh-mcphub/config.json`（原子写，重启 dsh 仍生效）并**立即重连**，无需重启宿主；「恢复默认」清除保存值回到本地默认。地址只保留 origin（`/mcp` 前缀自动丢弃，端点始终是 `${origin}/mcp[/<group>]`），支持 `localhost:3000`、`127.0.0.1:3001`、完整 `http(s)://` 写法。连不上时地址照样保存、区块如实报错，方便改掉打错的地址。
- **健壮性**：断线自动指数退避重连（工具在中断期保持注册、调用报错，恢复后自动重同步）；监听 `notifications/tools/list_changed` 热同步工具集；MCPHub 不可达时插件照常激活，详情页区块如实显示；换地址后旧 hub 的工具立即注销，不会残留指向已弃用 hub 的工具。
- **宿主路由**（与 dsh `/api` 网关同一条信任线：环回地址 + 部署声明的 `trustedHosts`，并校验 `sec-fetch-site` / `Origin` 同源）：
  - `GET /api/dsh-mcphub/status`（TTL 缓存、`?refresh=1` 绕过）；
  - `/api/dsh-mcphub/connection`：`GET` 读当前生效地址与默认值，`POST { baseUrl, group }` 保存并重连，`DELETE` 清除保存值回到默认。

  这条信任线**故意不比宿主更严**：早期版本只认环回 `Host`，于是经 dsh-pocket / 局域网地址 / 机器名打开的页面能正常用 `/api` 的其余部分，却会被这两条路由回 `403 forbidden`，详情页既读不到状态也存不下地址。判据从 `connection` 服务惰性读取，顺序是「`requestRejection`（网关的完整判定，含 Host/Origin 栅栏与浏览器认证）→ `trustedHosts` → 只认环回」；`trustedHosts` 故意排在后面，因为它只列受信权威、不表达会话状态，抢先采用就会让未认证调用方进到网关本来就拦的路由。拒绝状态码也会原样透出：`401` 表示需要重新认证，`403` 表示来源不受信，两者修法不同。

## 安装

前置：本机已运行 MCPHub（`mcphub`，`http://localhost:3000`），且其中已启用至少一个 server。

或发布到 npm 后：`dsh plugin --profile web add @dong-victor/dsh-mcphub`。

安装后**重启 dsh web 宿主进程**（本插件是新 bundle，需要宿主重新加载 profile 才能生效）。

## 配置（可选）

**默认即可用**：不配置也能连本机 `http://localhost:3000`。要换地址有两种方式：

1. **界面改（推荐）**：插件详情页「MCPHub 地址」表单填入地址 → **保存并连接**。立即重连，并写入 `~/.dsh/dsh-mcphub/config.json`，重启 dsh 后仍生效；「恢复默认」清除保存值。
2. **改 profile**：在 profile 的 `cordis.patch.yml` 中覆盖部署级默认值。

```yaml
- id: mcphub
  name: '@dong-victor/dsh-mcphub'
  config:
    baseUrl: http://localhost:3000   # 部署默认 MCPHub 地址（界面保存的地址优先于它）
    group: ''                        # 留空=全局聚合 /mcp；填分组名= /mcp/<group>
    serverName: mcphub               # 工具命名空间（mcp__<serverName>__…）
    headers: {}                      # 附加 HTTP 头，如 { Authorization: 'Bearer xxx' }（MCPHub 开启 bearer 认证时）
    announceToAgent: true            # 是否向 agent 公告本插件
    toolCallTimeoutMs: 60000         # 单次 tools/call 超时
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
      maxAttempts: 10
```

地址优先级：**界面保存的地址 > profile 的 `baseUrl` > 默认 `http://localhost:3000`**。保存文件损坏或不可解析时按「未保存」处理，插件仍以默认地址启动，不会拖垮宿主。

## 开发

```powershell
npm install        # 安装依赖（@modelcontextprotocol/sdk、zod、jsdom、react 等）
npm test           # 全部测试：host-boot 冒烟 + 地址编辑 + 客户端槽位冒烟 + 对真实 MCPHub 的桥接/路由端到端
npm pack           # 打包发布
```

测试说明：

- `connection.test.mjs` 覆盖地址编辑这条链路：地址归一化（裸 `host:port`、带 `/mcp` 后缀、带分组路径）、`~/.dsh/dsh-mcphub/config.json` 的读写与原子写、优先级（保存值 > profile > 默认）、损坏文件降级，以及 `/api/dsh-mcphub/connection` 的 GET / POST / DELETE / 非法地址 400 / 不可达地址仍保存。信任线单独成组：四种环回写法放行，未知 `Host`、`sec-fetch-site: cross-site`、异源 `Origin` 一律 403；`trustedHosts` 里的 LAN IP（无端口写法）与机器名（带端口写法）放行、同名换端口拒绝；接上 `requestRejection` 时以它为准（受信权威但无会话照样被拒，其 401 原样透出），判定抛错则 fail closed。
- `client-smoke.test.mjs` 用**真实** `SlotCore`（`@deepseek-ai/dsh-client-ui-slots`）驱动 `apply()`，断言槽位占位成功、区块渲染、对非本插件 subject 返回 `null`、dispose 回收——槽位未声明时注册会抛错，因此通过即证明插件对准了宿主的槽位契约；同时驱动地址表单的编辑 → 保存 → 重连 → 重绘，以及「恢复默认」。另断言被拒绝时的**文案分流**：`401 / 403 / 404` 的裸文本响应分别翻成「会话未通过认证 / 宿主拒绝了这次请求 / 宿主端还没有这个接口」，不会被误报成「地址无效」，其它状态码仍带上状态码，真实传输失败仍是「状态查询失败」。
- `entry-layout.test.mjs` 以插件管理页的真实契约（`plugins.detail.section` 为 list、每个注册项拿到当前详情页的 subject）驱动同一套真实 `SlotCore`，并**故意声明**已废弃的 `sidebar.panellist` / `main` / `sidebar.footer.action` 三个槽位，用来正面证明插件不再注册进它们（而不是因为槽位未声明才「恰好」没注册）。
- `bridge-live.test.mjs` 会真实连接本机 `http://localhost:3000` 的 MCPHub，发现工具并调用一个只读工具（如 `get_schema_info`），需要 MCPHub 在线。
- `connection-live.test.mjs` 把两条路由挂到真实 `node:http` 服务器上跑真实请求：证明栅栏读的是真实 `Host`（用 `http.request` 伪造非环回 `Host` 得 403，环回 `Host` 正对照 200）、请求体能从真实 `data`/`end` 事件拼出、保存后桥接真的重连且保住工具集；再接上真实 `connection` 服务，证明判定确实被查询、LAN 权威放行、未认证判定以 401 透出。需要本机 MCPHub 在线。

## 兼容性
面向 **dsh 0.2.0-rc.2**。该版本有两处破坏性变更，本插件已相应改造：

1. **工具 schema DSL**：`ctx.tools.register` 的 `output.schema` 改为经 `valueSchemaSpecToJsonSchema` 编译的 author-facing DSL（对象根必须写 `additionalProperties`、必填是每个属性的 `required: true` 注解、无约束负载用 `{ type: 'json' }`）；直接传原始 JSON Schema 会在注册时抛 `JsonSchemaError`。`parameters` 仍是原始 JSON Schema（上游 MCP `inputSchema` 原样透传）。
2. **客户端槽位**：浏览器半个包导出 `inject` + `apply`，界面一律经 `ctx.slots` 注册，不再抓取 shell 的 CSS-module 类名；文案经 `ctx.locale.register` 注册命名空间后由框架注入 `t`。

界面挂载点历经三次迁移：`sidebar.footer.action`（设置行上方的底部整行）→ `sidebar.panellist` + `main`（左侧全局面板菜单行 + 中央状态页）→ 当前的 `plugins.detail.section`（插件管理页本插件详情页的区块）。**迁移到详情页后左侧菜单不再出现 MCPHub 行**，这是有意为之：桥接状态属于它所描述的插件，不该长期占用全局面板菜单位。

## 已知限制

- 只桥接**工具**能力：MCP 的 resources / prompts 暂不暴露（与 dsh-mcp-client 相同）。
- 工具名中的 `<server名>` 前缀来自 MCPHub 配置；在 MCPHub 中改名会导致工具名变化（可 `mcphub_resync` 刷新）。
- 区块中的 server 分组基于工具名前缀启发式推断（展示用），调用始终使用完整工具名，不受影响。
- 状态区块只在插件管理页的本插件详情页可见，没有常驻入口；需要随时查看可让 agent 调用 `mcphub_status`。
- 依赖 MCPHub 服务在线；服务端会话在插件重连后会重建。
- 地址编辑只影响本插件自己的 `baseUrl` / `group`：`headers`、`toolCallTimeoutMs`、`reconnect` 等仍在 profile 配置里改。若 MCPHub 开启了 bearer 认证，换地址后仍需在 profile 配 `headers`。
- 地址按 origin 保存：`http(s)://host[:port]`，路径部分会被丢弃（端点固定为 `${origin}/mcp[/<group>]`），这是 MCPHub 的路由契约。
- 界面文案区分三类失败，但插件不自行绕过宿主的访问控制：`401` 需要重新认证、`403` 需要把页面来源加进宿主的 `trustedHosts`、`404` 说明当前运行的宿主进程还没加载本插件的宿主端（重启 dsh web 即可）。
- 改了 `lib/client.js` 后必须重启 dsh web：浏览器 bundle 在宿主组装时一次性生成并缓存在内存里，只替换文件不会换掉已发出的 bundle。

## 许可

MIT
