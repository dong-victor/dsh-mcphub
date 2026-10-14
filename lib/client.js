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
 *   - `plugins.detail.section` (list, id = 'mcphub')  — the status section on the
 *     DSH plugin-manager detail page of this very package. The entry renders for
 *     the subject that names this bundle and returns null for every other page,
 *     so it adds one section to its own page and touches nothing else.
 *
 * The sidebar panel menu row this plugin used to contribute
 * (`sidebar.panellist` + a `main` occupant) is deliberately gone: the bridge
 * status lives with the plugin it describes, on the Plugins page, instead of
 * taking a permanently visible slot in the global panel menu.
 *
 * Copy is registered as the `dsh-mcphub` locale namespace and every component
 * receives the framework-synthesized `t` seat; no manual language sniffing.
 *
 * The section queries GET /api/dsh-mcphub/status (host half).
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

    /** Stable id of the one detail-page section this plugin contributes. */
    var SECTION_ID = 'mcphub'

    /** The package name whose detail page hosts the section. */
    var OWN_PACKAGE = '@dong-victor/dsh-mcphub'

    /** Locale namespace this plugin owns. */
    var NS = 'dsh-mcphub'

    // ======================== locale ========================

    /** zh is the key source; en mirrors every key. */
    var zh = {
      'section.title': 'MCPHub 桥接',
      'section.subtitle': 'MCP 服务器聚合桥接 · 本地服务',
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
      'section.title': 'MCPHub bridge',
      'section.subtitle': 'MCP server hub bridge · local service',
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
      // The section is drawn INSIDE the plugin-manager page's own section
      // column, which already supplies the page's padding and max width, so
      // this draws the section's own chrome only: no viewport height, no outer
      // scroll container, no full-page background.
      '.mh-section{display:block;width:100%;box-sizing:border-box}',
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

    // ======================== detail-page section ========================

    /**
     * Whether a plugin-manager detail subject is this plugin's OWN page.
     *
     * The subject is a discriminated union (`slot-contract.d.ts`):
     *   - `{ kind: 'bundle', pkg }`             — a bundle's page
     *   - `{ kind: 'row', pkg, row }`           — one row's own page, reached
     *                                             from that bundle's page
     *   - `{ kind: 'item', id }`                — an official plugin's page
     *
     * This plugin is an ordinary bundle, so its detail page is the `bundle` arm
     * naming its package — that is the one page the section belongs on.
     *
     * The `row` arm deliberately does NOT match, even though it carries the same
     * `pkg.name`: a row's page is a distinct, nested page, and matching it would
     * paint the whole status block a second time one level down. The `item` arm
     * never matches, and every other shape (a subject from a newer host, a
     * missing prop) is treated as not ours.
     *
     * @returns whether the subject is this package's bundle page.
     */
    function isOwnDetailPage(subject) {
      if (subject === null || typeof subject !== 'object') return false
      if (subject.kind !== 'bundle') return false
      var pkg = subject.pkg
      if (pkg === null || typeof pkg !== 'object') return false
      return pkg.name === OWN_PACKAGE
    }

    // ======================== status section (plugins.detail.section) ========================

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

    /**
     * The bridge status section on this plugin's own detail page
     * (slot `plugins.detail.section`).
     *
     * The page renders every registered entry and hands each the subject of the
     * open page, so an entry with nothing to say about a page must return null
     * rather than draw empty chrome — otherwise this section would appear on the
     * detail page of every plugin in the profile.
     *
     * The gate is checked OUTSIDE `SectionBody` so that a foreign page never
     * mounts the body at all: the body's mount effect starts a status fetch,
     * and fetching on every other plugin's page would be pure waste.
     */
    function McphubDetailSection(props) {
      var t = props.t
      if (!isOwnDetailPage(props.subject)) return null
      return react.createElement(SectionBody, { t: t })
    }

    /** The section's own body, mounted only once the subject matched. */
    function SectionBody(props) {
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
          react.createElement('div', { className: 'mh-title', key: 't' }, t('section.title')),
          react.createElement('div', { className: 'mh-subtitle', key: 's' }, t('section.subtitle')),
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

      return react.createElement('section', { className: 'mh-section', 'data-mcphub-section': true },
        [header].concat(body))
    }

    // ======================== registration ========================

    /**
     * Services required (fiber inject waiting — the runtime must be up first).
     *
     * `layout` is gone with the `main` occupant: nothing here navigates panels
     * any more. `slots` and `locale` are all the section needs.
     */
    exports.inject = ['slots', 'locale']

    /**
     * Mount the detail-page section through the slot registry.
     * @param ctx - client root context (slots, locale).
     */
    exports.apply = function (ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-mcphub: dictionaries')
      injectStyle()
      ctx.effect(function () {
        return function () {
          var style = document.getElementById(STYLE_ID)
          if (style !== null) style.remove()
        }
      }, 'dsh-mcphub: styles')

      // Detail-page section: `plugins.detail.section` is a list the plugin
      // manager declares on its handler entry, so this registration lands only
      // once that page has mounted its own declaration — `slots.inject` waits
      // for the key rather than failing on an undeclared slot. The page hands
      // every entry the subject of the open page and the entry decides from it
      // whether to render, which is how this section stays on its own page.
      //
      // `order` places it among other plugins' sections on the same page; the
      // page's own content precedes them all.
      ctx.effect(function () {
        return ctx.slots.inject('plugins.detail.section', function () {
          return ctx.slots.register({
            name: 'plugins.detail.section',
            id: SECTION_ID,
            order: 10,
            locale: NS,
          }, McphubDetailSection)
        })
      }, 'dsh-mcphub: detail section')
    }

    return module.exports
  },
})
