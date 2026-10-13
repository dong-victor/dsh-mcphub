/**
 * dsh-mcphub — browser half (hand-built CJS bundle).
 *
 * Runs inside the dsh web GUI. On dsh 0.2.0-rc.2 the browser half is a cordis
 * plugin whose module exports are `inject` + `apply`; every UI surface is
 * contributed through the official slot registry (`ctx.slots`), never by
 * scraping the shell's DOM for CSS-module class names (which is what the
 * pre-0.2 build did, and what the shell rewrite broke).
 *
 * Surfaces:
 *   - `sidebar.panellist` (list, id = 'mcphub')  — the sidebar panel menu row,
 *     listed with the other plugin panels. The shell owns the row (button,
 *     label, active state, click-to-select) and this slot supplies only the
 *     glyph; the entry's `order` places it in the menu.
 *   - `main` (keyed, key = 'mcphub')  — the status panel body, selected through
 *     `ctx.layout.selectPanel('mcphub')`. The shell derives its panel list from
 *     the `sidebar.panellist` entries, so the two ids must match.
 *
 * Copy is registered as the `dsh-mcphub` locale namespace and every component
 * receives the framework-synthesized `t` seat; no manual language sniffing.
 *
 * The panel queries GET /api/dsh-mcphub/status (host half).
 *
 * Failure policy: slot registration problems are logged, never thrown — an
 * external plugin must not take the GUI down.
 */
window.__ModuleLoader__.load({
  id: '@dong-victor/dsh-mcphub',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    /** The main-panel key shared by the `main` occupant and its sidebar row. */
    var PANEL_ID = 'mcphub'

    /** Locale namespace this plugin owns. */
    var NS = 'dsh-mcphub'

    // ======================== locale ========================

    /** zh is the key source; en mirrors every key. */
    var zh = {
      'entry.label': 'MCPHub',
      'entry.tooltip': '本地 MCPHub 桥接状态',
      'panel.title': 'MCPHub',
      'panel.subtitle': 'MCP 服务器聚合桥接 · 本地服务',
      'panel.refresh': '刷新',
      'panel.openDashboard': '打开 MCPHub Dashboard',
      'panel.loading': '查询中…',
      'state.connected': '已连接',
      'state.disconnected': '未连接',
      'stat.endpoint': '端点 {url}',
      'stat.group': '分组 {group}',
      'stat.group.global': '全局聚合',
      'stat.tools': '{n} 个工具',
      'stat.servers': '{n} 个 server',
      'stat.lastSync': '上次同步 {time}',
      'stat.health': 'MCPHub 健康: {status} · servers {connected}/{total} 已连接',
      'stat.health.fail': 'MCPHub 健康检查失败: {error}',
      'stat.error': '最近错误: {error}',
      'server.toolCount': '{n} 个工具',
      'meta.provider': '由 @dong-victor/dsh-mcphub 提供 · GET /api/dsh-mcphub/status',
      'error.fetch': '状态查询失败：{error}',
      'empty.servers': '尚未发现任何工具 —— 请确认 MCPHub 中已启用 server 并等待同步',
    }

    var en = {
      'entry.label': 'MCPHub',
      'entry.tooltip': 'Local MCPHub bridge status',
      'panel.title': 'MCPHub',
      'panel.subtitle': 'MCP server hub bridge · local service',
      'panel.refresh': 'Refresh',
      'panel.openDashboard': 'Open MCPHub Dashboard',
      'panel.loading': 'Fetching…',
      'state.connected': 'Connected',
      'state.disconnected': 'Disconnected',
      'stat.endpoint': 'Endpoint {url}',
      'stat.group': 'Group {group}',
      'stat.group.global': 'Global aggregate',
      'stat.tools': '{n} tools',
      'stat.servers': '{n} servers',
      'stat.lastSync': 'Last sync {time}',
      'stat.health': 'MCPHub health: {status} · servers {connected}/{total} connected',
      'stat.health.fail': 'MCPHub health check failed: {error}',
      'stat.error': 'Last error: {error}',
      'server.toolCount': '{n} tools',
      'meta.provider': 'by @dong-victor/dsh-mcphub · GET /api/dsh-mcphub/status',
      'error.fetch': 'Status query failed: {error}',
      'empty.servers': 'No tools discovered yet — make sure servers are enabled in MCPHub and wait for the sync',
    }

    // ======================== shared status state ========================

    var API_PATH = '/api/dsh-mcphub/status'

    /** Last successful payload, shared by the entry row and the panel. */
    var lastStatus = null
    var statusInFlight = null
    var statusListeners = new Set()

    function notifyStatus() {
      statusListeners.forEach(function (listener) { listener(lastStatus) })
    }

    /**
     * Query the host status route. Concurrent callers share one in-flight
     * request; the host serves a short TTL cache.
     * @param force - append ?refresh=1 to bypass the host cache.
     */
    function fetchStatus(force) {
      if (statusInFlight !== null) return statusInFlight
      statusInFlight = fetch(API_PATH + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
        .then(function (response) { return response.json().catch(function () { return null }) })
        .then(function (body) {
          if (body !== null && body.ok === true) lastStatus = body
          notifyStatus()
          return body
        })
        .catch(function () {
          lastStatus = null
          notifyStatus()
          return null
        })
        .finally(function () { statusInFlight = null })
      return statusInFlight
    }

    /** Subscribe to status refreshes (backs the entry row's summary). */
    function useStatus() {
      var pair = react.useState(lastStatus)
      var value = pair[0]
      var setValue = pair[1]
      react.useEffect(function () {
        var listener = function (next) { setValue(next) }
        statusListeners.add(listener)
        setValue(lastStatus)
        fetchStatus(false)
        return function () { statusListeners.delete(listener) }
      }, [])
      return value
    }

    /** Format an ISO timestamp as a short local date-time. */
    function formatTime(iso) {
      var date = new Date(iso)
      if (isNaN(date.getTime())) return '--'
      return date.toLocaleString(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    }

    // ======================== styles ========================

    var STYLE_ID = 'dsh-mcphub-style'

    /** Scoped stylesheet riding the dsh --dsw-* theme tokens. */
    var STYLE_TEXT = [
      // The panel-menu row (`.mh-entry*`) is intentionally NOT styled here: the
      // shell renders that row itself (`panelRow`/`panelGlyph`/`panelTitle`) and
      // we only supply the glyph component, so the row inherits the shell's own
      // geometry and hover/active treatment.
      '.mh-view{width:100%;height:100%;padding:16px;overflow-y:auto;box-sizing:border-box;background:var(--dsw-alias-bg-base)}',
      '.mh-panel{max-width:640px;margin:0 auto}',
      '.mh-header{display:flex;align-items:center;gap:10px;margin-bottom:14px}',
      '.mh-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:22px}',
      '.mh-subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px}',
      '.mh-spacer{flex:1}',
      '.mh-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.mh-iconBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-sidebar-nav-item-hover)}',
      '.mh-banner{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.mh-loading{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:24px 0;text-align:center}',
      '.mh-stateRow{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.mh-stateBadge{font-size:12px;line-height:22px;padding:0 10px;border-radius:999px;font-weight:500}',
      '.mh-stateBadge.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
      '.mh-stateBadge.bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
      '.mh-dashboardLink{font-size:12px;color:var(--dsw-alias-state-business-primary);text-decoration:none;margin-left:auto}',
      '.mh-dashboardLink:hover{text-decoration:underline}',
      '.mh-metaCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 14px;margin-bottom:12px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.mh-metaRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mh-cards{display:flex;flex-direction:column;gap:10px}',
      '.mh-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:12px 14px}',
      '.mh-cardHead{display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;user-select:none}',
      '.mh-cardName{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mh-cardCount{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mh-chevron{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}',
      '.mh-card[data-open] .mh-chevron{transform:rotate(90deg)}',
      '.mh-tools{display:none;flex-direction:column;gap:6px;margin-top:4px}',
      '.mh-card[data-open] .mh-tools{display:flex}',
      '.mh-toolRow{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 8px}',
      '.mh-toolRow code{color:var(--dsw-alias-state-business-primary)}',
      '.mh-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:20px 0;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px}',
      '.mh-meta{margin-top:14px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
    ].join('')

    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', '@dong-victor/dsh-mcphub')
      style.textContent = STYLE_TEXT
      document.head.append(style)
    }

    // ======================== icons ========================

    /** Hub / nodes glyph for the sidebar entry and the panel header. */
    function HubIcon(props) {
      var size = props.size || 14
      return react.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, [
        react.createElement('circle', { key: 'c', cx: 8, cy: 8, r: 2.4 }),
        react.createElement('path', { key: 'p', d: 'M8 5.6V2.6M8 10.4v3M5.6 8H2.6M10.4 8h3' }),
      ])
    }

    var REFRESH_PATH = 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.4h-2.4'
    var EXTERNAL_PATHS = 'M6 3H3.5v9.5H13V10|M8 8l4.5-4.5M9 3.5h3.5V7'

    function StrokeIcon(props) {
      var paths = props.paths.split('|')
      return react.createElement('svg', {
        viewBox: '0 0 16 16', width: props.size || 15, height: props.size || 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, paths.map(function (d, index) {
        return react.createElement('path', { key: index, d: d })
      }))
    }

    // ======================== sidebar entry row ========================

    /**
     * Panel-menu glyph (slot `sidebar.panellist`).
     *
     * The shell owns the row itself — it renders the `<button>`, the label, the
     * active background and the click-to-select — and calls this component only
     * for the glyph. The seat supplies `{ size, active }` (`size` is 16 when the
     * sidebar is wide, 18 when collapsed as a rail), so this must render a bare
     * glyph and must NOT read panel state: the shell already resolved `active`
     * for us and there is no `usePanelInfo` in this seat.
     */
    function PanelGlyph(props) {
      var size = typeof props.size === 'number' ? props.size : 16
      return react.createElement(HubIcon, { size: size })
    }

    // ======================== status panel (main slot) ========================

    /** One collapsible server card listing the DSH-callable tool names. */
    function ServerCard(props) {
      var t = props.t
      var pair = react.useState(false)
      var open = pair[0]
      var setOpen = pair[1]
      var server = props.server

      var tools = server.tools.map(function (tool) {
        return react.createElement('div', { className: 'mh-toolRow', key: tool.publicName },
          react.createElement('code', null, tool.publicName))
      })

      return react.createElement('div', { className: 'mh-card', 'data-open': open ? '' : undefined }, [
        react.createElement('div', {
          className: 'mh-cardHead', key: 'head', onClick: function () { setOpen(!open) },
        }, [
          react.createElement('span', { className: 'mh-cardName', key: 'name' }, server.name),
          react.createElement('span', { className: 'mh-cardCount', key: 'count' }, t('server.toolCount', { n: String(server.toolCount) })),
          react.createElement('span', { className: 'mh-chevron', key: 'chev' }, '\u203A'),
        ]),
        react.createElement('div', { className: 'mh-tools', key: 'tools' }, tools),
      ])
    }

    /** The MCPHub status panel hosted in the main column (slot `main`). */
    function StatusPanel(props) {
      var t = props.t
      var pair = react.useState(lastStatus)
      var status = pair[0]
      var setStatus = pair[1]
      var loadingPair = react.useState(status === null)
      var loading = loadingPair[0]
      var setLoading = loadingPair[1]
      var errorPair = react.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]

      var refresh = react.useCallback(function (force) {
        setLoading(true)
        setError(null)
        fetchStatus(force).then(function (body) {
          setLoading(false)
          if (body === null || body.ok !== true) {
            setStatus(null)
            setError(body && typeof body.error === 'string' ? body.error : 'HTTP error')
            return
          }
          setStatus(body)
        }).catch(function (err) {
          setLoading(false)
          setError(String(err && err.message ? err.message : err))
        })
      }, [])

      react.useEffect(function () { refresh(false) }, [refresh])

      var header = react.createElement('div', { className: 'mh-header', key: 'header' }, [
        react.createElement('div', { key: 'brand' }, [
          react.createElement('div', { className: 'mh-title', key: 't' }, t('panel.title')),
          react.createElement('div', { className: 'mh-subtitle', key: 's' }, t('panel.subtitle')),
        ]),
        react.createElement('div', { className: 'mh-spacer', key: 'sp' }),
        react.createElement('button', {
          type: 'button', className: 'mh-iconBtn', key: 'refresh',
          title: t('panel.refresh'), 'aria-label': t('panel.refresh'),
          onClick: function () { refresh(true) },
        }, react.createElement(StrokeIcon, { paths: REFRESH_PATH })),
      ])

      var body = []
      if (error !== null) {
        body.push(react.createElement('div', { className: 'mh-banner', key: 'err' }, t('error.fetch', { error: error })))
      }

      if (status !== null && status.ok === true) {
        var connected = status.connected === true
        var base = status.baseUrl || 'http://localhost:3000'
        var health = status.health

        body.push(react.createElement('div', { className: 'mh-stateRow', key: 'state' }, [
          react.createElement('span', {
            className: 'mh-stateBadge ' + (connected ? 'ok' : 'bad'), key: 'badge',
          }, connected ? t('state.connected') : t('state.disconnected')),
          react.createElement('a', {
            className: 'mh-dashboardLink', key: 'link', href: base, target: '_blank', rel: 'noreferrer',
          }, [
            react.createElement(StrokeIcon, { paths: EXTERNAL_PATHS, size: 13, key: 'i' }),
            react.createElement('span', { key: 'label' }, ' ' + t('panel.openDashboard')),
          ]),
        ]))

        var metaRows = [
          react.createElement('div', { className: 'mh-metaRow', key: 'endpoint' }, [
            react.createElement('span', { key: 'endpoint' }, t('stat.endpoint', { url: status.endpoint || (base + '/mcp') })),
            react.createElement('span', { key: 'group' }, status.group ? t('stat.group', { group: status.group }) : t('stat.group.global')),
          ]),
          react.createElement('div', { className: 'mh-metaRow', key: 'health' }, react.createElement('span', null,
            health && health.ok === true
              ? t('stat.health', {
                status: health.status || 'healthy',
                connected: String(health.servers ? health.servers.connected : '?'),
                total: String(health.servers ? health.servers.total : '?'),
              })
              : t('stat.health.fail', { error: health && health.error ? health.error : 'n/a' }))),
        ]
        if (status.lastSyncAt) {
          metaRows.push(react.createElement('div', { className: 'mh-metaRow', key: 'sync' },
            react.createElement('span', null, t('stat.lastSync', { time: formatTime(status.lastSyncAt) }))))
        }
        if (status.error) {
          metaRows.push(react.createElement('div', { className: 'mh-metaRow', key: 'status-error' },
            react.createElement('span', null, t('stat.error', { error: status.error }))))
        }
        body.push(react.createElement('div', { className: 'mh-metaCard', key: 'meta' }, metaRows))
        if (status.servers && status.servers.length > 0) {
          body.push(react.createElement('div', { className: 'mh-cards', key: 'cards' },
            status.servers.map(function (server) {
              return react.createElement(ServerCard, { key: server.name, server: server, t: t })
            })))
        } else {
          body.push(react.createElement('div', { className: 'mh-empty', key: 'empty' }, t('empty.servers')))
        }
      } else if (loading) {
        body.push(react.createElement('div', { className: 'mh-loading', key: 'loading' }, t('panel.loading')))
      }

      body.push(react.createElement('div', { className: 'mh-meta', key: 'provider' },
        react.createElement('div', { className: 'mh-metaRow' }, t('meta.provider'))))

      return react.createElement('div', { className: 'mh-view' },
        react.createElement('div', { className: 'mh-panel' }, [header].concat(body)))
    }

    // ======================== registration ========================

    /** Services required (fiber inject waiting — the runtime must be up first). */
    exports.inject = ['slots', 'locale', 'layout']

    /**
     * Mount the sidebar entry and the status panel through the slot registry.
     * @param ctx - client root context (slots, locale, layout).
     */
    exports.apply = function (ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-mcphub: dictionaries')
      // Bound translator for copy resolved OUTSIDE a component — notably the
      // panel entry's `label`, which the shell calls through
      // `resolveSlotLabel(options.label)` while building the menu (`t()` on a
      // thunk). A bare `t` is not in scope in `apply`, and a ReferenceError
      // thrown from that thunk propagates out of the shell's `syncPanels` and
      // takes the whole `dsh-client-ui-sidebar` plugin down.
      var t = ctx.locale.bind(NS)
      injectStyle()
      ctx.effect(function () {
        return function () {
          var style = document.getElementById(STYLE_ID)
          if (style !== null) style.remove()
        }
      }, 'dsh-mcphub: styles')

      // Main panel: keyed `main` seat, selected through ctx.layout.
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, StatusPanel)
        })
      }, 'dsh-mcphub: main panel')

      // Sidebar panel entry: `sidebar.panellist` IS the panel menu — the shell
      // derives its whole row list from these entries
      // (`ctx.slots.entriesOfSlot("sidebar.panellist")` → `{ id, order, label }`)
      // and renders this component as the row's glyph. The same `id` also names
      // the `main` panel registered above, so clicking the row selects it.
      // Orders in the shipped shell: `plugins` = 0, `schedules` = 10, so 20
      // places MCPHub directly below them.
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: function () {
              return t('entry.label')
            },
            locale: NS,
          }, PanelGlyph)
        })
      }, 'dsh-mcphub: panel entry')
    }

    return module.exports
  },
})
