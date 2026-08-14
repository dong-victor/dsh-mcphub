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
- **侧边栏「MCPHub」入口**：位于侧边栏**底部「设置」按钮上方**（连接状态点 + 工具数概览；折叠侧边栏时自动切换为图标形态），点击打开状态面板。
- **状态面板**：连接徽章、端点 / 分组 / 健康 / 上次同步 / 最近错误、按 server 分组的工具清单（可展开）、「打开 MCPHub Dashboard」外链、手动刷新。
- **健壮性**：断线自动指数退避重连（工具在中断期保持注册、调用报错，恢复后自动重同步）；监听 `notifications/tools/list_changed` 热同步工具集；MCPHub 不可达时插件照常激活，状态面板如实显示。
- **宿主路由**：`GET /api/dsh-mcphub/status`（环回地址保护、TTL 缓存、`?refresh=1` 绕过）。

## 安装

前置：本机已运行 MCPHub（`mcphub`，`http://localhost:3000`），且其中已启用至少一个 server。

```powershell
# 从本地目录安装（与本仓库 dsh-jupyter 同样的 link 方式）
dsh plugin --profile web add link:C:\Users\dongz\.dsh\workspace\dsh-mcphub
```

或发布到 npm 后：`dsh plugin --profile web add @dong-victor/dsh-mcphub`。

安装后**重启 dsh web 宿主进程**（本插件是新 bundle，需要宿主重新加载 profile 才能生效）。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 中按需覆盖：

```yaml
- id: mcphub
  name: '@dong-victor/dsh-mcphub'
  config:
    baseUrl: http://localhost:3000   # MCPHub 地址
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

## 开发

```powershell
npm install        # 安装依赖（@modelcontextprotocol/sdk、zod、jsdom 等）
npm test           # host-boot 冒烟 + 客户端 DOM 冒烟 + 对真实 MCPHub 的桥接端到端测试
npm pack           # 打包发布
```

测试说明：`bridge-live.test.mjs` 会真实连接本机 `http://localhost:3000` 的 MCPHub，发现工具并调用一个只读工具（如 `get_schema_info`），需要 MCPHub 在线。

## 已知限制

- 只桥接**工具**能力：MCP 的 resources / prompts 暂不暴露（与 dsh-mcp-client 相同）。
- 工具名中的 `<server名>` 前缀来自 MCPHub 配置；在 MCPHub 中改名会导致工具名变化（可 `mcphub_resync` 刷新）。
- 面板中的 server 分组基于工具名前缀启发式推断（展示用），调用始终使用完整工具名，不受影响。
- 依赖 MCPHub 服务在线；服务端会话在插件重连后会重建。

## 许可

MIT
