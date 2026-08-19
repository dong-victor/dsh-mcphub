/**
 * dsh-mcphub — browser half (hand-built CJS bundle, zero runtime deps).
 *
 * Runs inside the dsh web GUI. Registers locale dictionaries and mounts two
 * DOM surfaces: the sidebar entry row (connection dot + tool/server counts,
 * toggles the panel) and the status panel in the center column (endpoint,
 * connection state, MCPHub health, per-server tool lists with the exact DSH
 * callable names, and a button to open the MCPHub dashboard). Everything is
 * plain DOM + one scoped stylesheet riding the dsh --dsw-* theme tokens.
 *
 * The panel queries GET /api/dsh-mcphub/status (host half).
 *
 * Failure policy: DOM mounting problems are logged, never thrown — an
 * external plugin must not take the GUI down.
 */
window.__ModuleLoader__.load({
  id: '@dong-victor/dsh-mcphub',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ======================== locale ========================

    /** Locale namespace this plugin owns. */
    var NS = 'dsh-mcphub'

    /** zh is the key source; en mirrors every key. */
    var zh = {
      'entry.label': 'MCPHub',
      'entry.tooltip': '本地 MCPHub 桥接状态',
      'panel.title': 'MCPHub',
      'panel.subtitle': 'MCP 服务器聚合桥接 · 本地服务',
      'panel.refresh': '刷新',
      'panel.close': '关闭',
      'panel.openDashboard': '打开 MCPHub Dashboard',
      'panel.loading': '查询中…',
      'state.connected': '已连接',
      'state.disconnected': '未连接',
      'state.reconnecting': '重连中',
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
      'server.collapse': '收起',
      'server.expand': '展开',
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
      'panel.close': 'Close',
      'panel.openDashboard': 'Open MCPHub Dashboard',
      'panel.loading': 'Fetching…',
      'state.connected': 'Connected',
      'state.disconnected': 'Disconnected',
      'state.reconnecting': 'Reconnecting',
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
      'server.collapse': 'Collapse',
      'server.expand': 'Expand',
      'meta.provider': 'by @dong-victor/dsh-mcphub · GET /api/dsh-mcphub/status',
      'error.fetch': 'Status query failed: {error}',
      'empty.servers': 'No tools discovered yet — make sure servers are enabled in MCPHub and wait for the sync',
    }

    /** Active dictionary, picked by the document language at call time. */
    function dictionary() {
      var lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
      return lang.toLowerCase().startsWith('en') ? en : zh
    }

    /** Translate a key with optional {name} template params (current language). */
    function tt(key, values) {
      var text = dictionary()[key]
      if (text === undefined) text = key
      if (values) {
        for (var k in values) {
          if (Object.prototype.hasOwnProperty.call(values, k)) {
            text = text.split('{' + k + '}').join(String(values[k]))
          }
        }
      }
      return text
    }

    // ======================== styles ========================

    /** Inject the scoped stylesheet once; the module system claims it via data-plugin. */
    var STYLE_TEXT = [
      "[data-pane='conversation']{position:relative}",
      "[class*='centerCol']{position:relative}",
      '[data-dsh-mcphub-view]{position:absolute;inset:0;display:none;z-index:5;box-sizing:border-box}',
      "html[data-dsh-mcphub-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]):not([data-dsh-opencode-go-active]) [data-dsh-mcphub-view]{display:block}",
      "html[data-dsh-mcphub-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]):not([data-dsh-opencode-go-active]) [data-pane='conversation']>:not([data-dsh-mcphub-view]){display:none}",
      "html[data-dsh-mcphub-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]):not([data-dsh-opencode-go-active]) [class*='centerCol']>:not([data-dsh-mcphub-view]){display:none}",
      '.mh-entry{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;font-family:var(--dsw-font-family);font-size:14px;line-height:22px;text-align:left;display:flex;overflow:hidden}',
      '.mh-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mh-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary)}',
      '.mh-entryIcon{display:inline-flex;flex:none;position:relative;width:16px;height:16px;align-items:center;justify-content:center}',
      '.mh-entryLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.mh-entryCount{margin-left:auto;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;padding-right:6px}',
      '.mh-dot{position:absolute;right:-2px;top:-2px;width:7px;height:7px;border-radius:50%;border:1.5px solid var(--dsw-alias-bg-base);background:var(--dsw-alias-state-error-primary)}',
      '.mh-dot.ok{background:var(--dsw-alias-state-success-primary)}',
      '.mh-entry[data-rail]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}',
      '.mh-entry[data-rail] .mh-entryLabel,.mh-entry[data-rail] .mh-entryCount{display:none}',
      '.mh-view{width:100%;height:100%;padding:16px;overflow-y:auto;box-sizing:border-box;background:var(--dsw-alias-bg-base)}',
      '.mh-panel{max-width:640px;margin:0 auto}',
      '.mh-header{display:flex;align-items:center;gap:10px;margin-bottom:14px}',
      '.mh-brand{min-width:0}',
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
      '.mh-metaRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.hHd-Xa_collapsed .hHd-Xa_footerActions,.hHd-Xa_collapsed .hHd-Xa_settingsArea{flex-direction:column!important}',
    ].join('')

    function injectStyle() {
      if (document.getElementById('dsh-mcphub-style') !== null) return
      var style = document.createElement('style')
      style.id = 'dsh-mcphub-style'
      style.setAttribute('data-plugin', '@dong-victor/dsh-mcphub')
      style.textContent = STYLE_TEXT
      document.head.append(style)
    }

    // ======================== DOM helpers ========================

    /** Tiny element builder: attrs set via setAttribute, dataset, class, text or innerHTML. */
    function el(tag, attrs, children) {
      var node = document.createElement(tag)
      if (attrs) {
        for (var key in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue
          var value = attrs[key]
          if (value === undefined || value === null || value === false) continue
          if (key === 'class') node.className = value
          else if (key === 'dataset') Object.assign(node.dataset, value)
          else if (key === 'text') node.textContent = value
          else if (key === 'html') node.innerHTML = value
          else node.setAttribute(key, value === true ? '' : String(value))
        }
      }
      if (children) {
        var list = Array.isArray(children) ? children : [children]
        for (var i = 0; i < list.length; i++) {
          var child = list[i]
          if (child !== undefined && child !== null && child !== false) node.append(child)
        }
      }
      return node
    }

    // ======================== controller ========================

    /** Panel open/close state with a tiny subscriber list. */
    function PanelController() {
      this.listeners = new Set()
      this.open = false
    }
    PanelController.prototype.subscribe = function (fn) {
      this.listeners.add(fn)
      var self = this
      return function () { self.listeners.delete(fn) }
    }
    PanelController.prototype.setOpen = function (open) {
      if (this.open === open) return
      this.open = open
      var listeners = Array.from(this.listeners)
      for (var i = 0; i < listeners.length; i++) listeners[i](open)
    }
    PanelController.prototype.toggle = function () { this.setOpen(!this.open) }
    PanelController.prototype.close = function () { this.setOpen(false) }

    // ======================== sidebar entry ========================

    var PANEL_NAME = 'mcphub'
    var ACTIVATE_EVENT = 'dsh-panel-activate'
    var ACTIVE_ATTR = 'data-dsh-mcphub-active'
    var OTHER_ACTIVE_ATTRS = ['data-dsh-ssh-active', 'data-dsh-taskboard-active', 'data-dsh-opencode-go-active']

    /** Entry icon: a hub / nodes glyph with a connection dot. */
    var ENTRY_ICON =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.4"/><path d="M8 5.6V2.6M8 10.4v3M5.6 8H2.6M10.4 8h3"/></svg>'

    /** Find the sidebar shell root element, or undefined while not yet mounted. */
    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (column === null) return undefined
      var logoOwner = column.querySelector('[class*="logoRow"]')
      return logoOwner ? logoOwner.parentElement : (column.firstElementChild || undefined)
    }

    /** The sidebar foot settings area (holds the settings trigger button). */
    function settingsAreaRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (column === null) return undefined
      var area = column.querySelector('[class*="settingsArea"]')
      return area || undefined
    }

    /** The settings trigger button inside the settings area. */
    function settingsTrigger(area) {
      if (area === undefined || area === null) return undefined
      var nested = area.querySelector('button[class*="trigger"]')
      return nested || undefined
    }

    /**
     * Whether the sidebar is in collapsed rail mode (icon-only entries).
     * The trigger's rail modifier arrives as a CSS-module class like
     * `VOzbGW_rail` — the `_` is a word character, so `\brail\b` would miss it;
     * match a standalone "rail" token or a `_rail` suffix instead.
     */
    function detectRail() {
      var root = sidebarRoot()
      if (root !== undefined && /\bcollapsed\b/.test(root.className)) return true
      var trigger = settingsTrigger(settingsAreaRoot())
      if (trigger !== undefined && /\brail\b|_rail\b/.test(trigger.className)) return true
      return false
    }

    /** Build the entry row (a detached button; insert once the shell is up). */
    function createEntry(controller) {
      var entry = document.createElement('button')
      entry.type = 'button'
      entry.dataset.dshMcphubEntry = ''
      entry.className = 'mh-entry'
      entry.setAttribute('aria-label', tt('entry.label'))
      entry.setAttribute('title', tt('entry.tooltip'))
      entry.innerHTML =
        '<span class="mh-entryIcon">' + ENTRY_ICON + '<span class="mh-dot"></span></span>' +
        '<span class="mh-entryLabel"></span>' +
        '<span class="mh-entryCount">--</span>'
      var label = entry.querySelector('.mh-entryLabel')
      label.textContent = tt('entry.label')
      entry.addEventListener('click', function () { controller.toggle() })
      return entry
    }

    /**
     * Place the entry inside the sidebar foot settings area, right above the
     * settings trigger — a quiet home below the browsing region instead of the
     * crowded plugin family at the top.
     *
     * The trigger may be wrapped in a slot container (`div[data-slot=...]`,
     * display:contents), so the reference node for insertBefore must be the
     * trigger's parent — never assumed to be the settings area itself.
     * @returns true when placed.
     */
    function placeEntry(entry) {
      var area = settingsAreaRoot()
      if (area === undefined) return false
      var trigger = settingsTrigger(area)
      if (trigger === undefined) return false
      var parent = trigger.parentElement
      if (parent === null) return false
      try {
        if (entry.parentElement !== parent) {
          parent.insertBefore(entry, trigger)
        }
      } catch (error) {
        // A re-render may have detached the trigger mid-insert; the shell
        // observer retries on the next mutation.
        console.warn('[dsh-mcphub] place entry failed:', error)
        return false
      }
      return true
    }

    /** How often the sidebar summary re-queries (host caches 10s, so 30s is cheap). */
    var ENTRY_REFRESH_MS = 30_000

    /** Mount the sidebar entry, waiting for the shell and self-healing on re-renders. */
    function mountSidebarEntry(controller) {
      var entry = createEntry(controller)
      var shellRoot
      var entryTimer = undefined

      function refreshEntry() {
        fetchStatus(false)
          .then(function (body) { renderEntrySummary(entry, body) })
          .catch(function () { renderEntrySummary(entry, null) })
      }

      function startWatch() {
        refreshEntry()
        if (entryTimer === undefined) {
          entryTimer = setInterval(refreshEntry, ENTRY_REFRESH_MS)
        }
      }

      /** Sync the rail (icon-only) look with the sidebar collapse state. */
      function applyRail() {
        if (detectRail()) entry.dataset.rail = 'true'
        else delete entry.dataset.rail
      }

      function tryPlace() {
        if (shellRoot !== undefined && !shellRoot.isConnected) {
          shellObserver.disconnect()
          shellRoot = undefined
        }
        shellRoot = shellRoot || sidebarRoot()
        if (shellRoot === undefined) return
        if (!placeEntry(entry)) return
        shellObserver.observe(shellRoot, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        })
        waitObserver.disconnect()
        applyRail()
      }

      var waitObserver = new MutationObserver(function () { tryPlace() })
      waitObserver.observe(document.body, { childList: true, subtree: true })

      var shellObserver = new MutationObserver(function () {
        if (shellRoot === undefined || !shellRoot.isConnected) {
          tryPlace()
          return
        }
        var area = settingsAreaRoot()
        if (area === undefined || settingsTrigger(area) === undefined || !area.contains(entry)) {
          tryPlace()
          return
        }
        applyRail()
      })

      var unsubscribe = controller.subscribe(function (open) {
        if (open) entry.dataset.active = 'true'
        else delete entry.dataset.active
      })
      if (controller.open) entry.dataset.active = 'true'

      tryPlace()
      startWatch()

      return function () {
        if (entryTimer !== undefined) clearInterval(entryTimer)
        waitObserver.disconnect()
        shellObserver.disconnect()
        unsubscribe()
        entry.remove()
      }
    }

    /** Fill the sidebar entry's connection dot + tool count from a payload. */
    function renderEntrySummary(entry, body) {
      var dot = entry.querySelector('.mh-dot')
      var count = entry.querySelector('.mh-entryCount')
      var ok = body !== null && body.ok === true
      var connected = ok && body.connected === true
      dot.className = 'mh-dot' + (connected ? ' ok' : '')
      count.textContent = ok ? String(body.toolCount) : '--'
      entry.title = tt('entry.tooltip') + ' — ' + (ok
        ? (connected ? tt('state.connected') : tt('state.disconnected')) + ' · ' + tt('stat.tools', { n: String(body.toolCount) })
        : tt('error.fetch', { error: body && body.error ? body.error : 'HTTP' }))
    }

    /** Format an ISO timestamp as a short local date-time. */
    function formatTime(iso) {
      var date = new Date(iso)
      if (isNaN(date.getTime())) return '--'
      return date.toLocaleString(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    }

    // ======================== status fetching (shared) ========================

    var API_PATH = '/api/dsh-mcphub/status'

    var lastStatus = null
    var lastStatusAt = 0
    var statusInFlight = null

    /**
     * Fetch the status from the host route. Concurrent callers share one
     * in-flight request; the host serves a short TTL cache.
     * @param force - send ?refresh=1 to bypass the host cache.
     */
    function fetchStatus(force) {
      if (statusInFlight !== null) return statusInFlight
      statusInFlight = fetch(API_PATH + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
        .then(function (response) { return response.json().catch(function () { return null }) })
        .then(function (body) {
          if (body !== null && body.ok === true) {
            lastStatus = body
            lastStatusAt = Date.now()
          }
          return body
        })
        .finally(function () { statusInFlight = null })
      return statusInFlight
    }

    // ======================== panel ========================

    /** Build the whole panel view (detached; appended to the conversation column). */
    function buildPanel(controller) {
      var refreshIcon =
        '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v2.4h-2.4"/></svg>'
      var closeIcon =
        '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
      var externalIcon =
        '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3.5v9.5H13V10"/><path d="M8 8l4.5-4.5M9 3.5h3.5V7"/></svg>'

      var refreshButton = el('button', {
        type: 'button', class: 'mh-iconBtn', title: tt('panel.refresh'), 'aria-label': tt('panel.refresh'),
        html: refreshIcon,
      })
      var closeButton = el('button', {
        type: 'button', class: 'mh-iconBtn', title: tt('panel.close'), 'aria-label': tt('panel.close'),
        html: closeIcon,
      })

      var header = el('div', { class: 'mh-header' }, [
        el('div', { class: 'mh-brand' }, [
          el('div', { class: 'mh-title', text: tt('panel.title') }),
          el('div', { class: 'mh-subtitle', text: tt('panel.subtitle') }),
        ]),
        el('div', { class: 'mh-spacer' }),
        refreshButton,
        closeButton,
      ])

      var banner = el('div', { class: 'mh-banner', hidden: true })
      var loading = el('div', { class: 'mh-loading', text: tt('panel.loading'), hidden: true })

      var stateBadge = el('span', { class: 'mh-stateBadge bad', text: tt('state.disconnected') })
      var dashboardLink = el('a', {
        class: 'mh-dashboardLink', href: '#', target: '_blank', rel: 'noreferrer',
        html: externalIcon + ' ' + tt('panel.openDashboard'),
      })
      var stateRow = el('div', { class: 'mh-stateRow' }, [stateBadge, dashboardLink])

      var endpointNode = el('span')
      var groupNode = el('span')
      var syncNode = el('span')
      var healthNode = el('span')
      var errorNode = el('span', { class: 'mh-error' })
      var metaCard = el('div', { class: 'mh-metaCard' }, [
        el('div', { class: 'mh-metaRow' }, [endpointNode, groupNode]),
        el('div', { class: 'mh-metaRow' }, [healthNode]),
        el('div', { class: 'mh-metaRow' }, [syncNode]),
        el('div', { class: 'mh-metaRow' }, [errorNode]),
      ])

      var cardsRoot = el('div', { class: 'mh-cards', hidden: true })

      var meta = el('div', { class: 'mh-meta' }, [
        el('div', { class: 'mh-metaRow', text: tt('meta.provider') }),
      ])

      var panel = el('div', { class: 'mh-panel' }, [header, banner, loading, stateRow, metaCard, cardsRoot, meta])
      var view = el('div', { dataset: { dshMcphubView: '' }, class: 'mh-view' }, [panel])

      refreshButton.addEventListener('click', function () { refresh(controller, true) })
      closeButton.addEventListener('click', function () { controller.close() })

      return {
        view: view,
        banner: banner,
        loading: loading,
        stateBadge: stateBadge,
        dashboardLink: dashboardLink,
        endpointNode: endpointNode,
        groupNode: groupNode,
        syncNode: syncNode,
        healthNode: healthNode,
        errorNode: errorNode,
        cardsRoot: cardsRoot,
      }
    }

    var panelParts = undefined

    /** Build one server card (empty; filled by updateCard). */
    function buildCard(server) {
      var chevron = el('span', { class: 'mh-chevron', text: '›' })
      var head = el('div', { class: 'mh-cardHead' }, [
        el('span', { class: 'mh-cardName', text: server.name }),
        el('span', { class: 'mh-cardCount', text: tt('server.toolCount', { n: String(server.toolCount) }) }),
        chevron,
      ])
      var tools = el('div', { class: 'mh-tools' })
      var card = el('div', { class: 'mh-card' }, [head, tools])
      head.addEventListener('click', function () {
        if (card.hasAttribute('data-open')) card.removeAttribute('data-open')
        else card.setAttribute('data-open', '')
      })
      return { root: card, tools: tools }
    }

    /** Fill one server card with its tool rows (public DSH callable names). */
    function updateCard(card, server) {
      card.tools.textContent = ''
      for (var i = 0; i < server.tools.length; i++) {
        var tool = server.tools[i]
        card.tools.append(el('div', { class: 'mh-toolRow' }, [
          el('code', { text: tool.publicName }),
        ]))
      }
    }

    /** Fetch the status and render it into the panel. */
    function refresh(controller, force) {
      var view = panelParts
      if (!view) return
      view.banner.hidden = true
      view.loading.hidden = false
      view.cardsRoot.hidden = true
      fetchStatus(force)
        .then(function (body) {
          view.loading.hidden = true
          if (body === null || body.ok !== true) {
            var message = body && typeof body.error === 'string' ? body.error : 'HTTP error'
            view.banner.textContent = tt('error.fetch', { error: message })
            view.banner.hidden = false
            return
          }
          renderStatus(view, body)
        })
        .catch(function (error) {
          view.loading.hidden = true
          view.banner.textContent = tt('error.fetch', { error: String(error && error.message ? error.message : error) })
          view.banner.hidden = false
        })
    }

    /** Render a successful status payload into the panel. */
    function renderStatus(view, body) {
      var connected = body.connected === true
      view.stateBadge.className = 'mh-stateBadge ' + (connected ? 'ok' : 'bad')
      view.stateBadge.textContent = connected ? tt('state.connected') : tt('state.disconnected')

      var base = body.baseUrl || 'http://localhost:3000'
      view.dashboardLink.href = base
      view.endpointNode.textContent = tt('stat.endpoint', { url: body.endpoint || (base + '/mcp') })
      view.groupNode.textContent = body.group
        ? tt('stat.group', { group: body.group })
        : tt('stat.group.global')

      var health = body.health
      if (health && health.ok === true) {
        view.healthNode.textContent = tt('stat.health', {
          status: health.status || 'healthy',
          connected: String(health.servers ? health.servers.connected : '?'),
          total: String(health.servers ? health.servers.total : '?'),
        })
      } else {
        view.healthNode.textContent = tt('stat.health.fail', { error: health && health.error ? health.error : 'n/a' })
      }

      view.syncNode.textContent = body.lastSyncAt ? tt('stat.lastSync', { time: formatTime(body.lastSyncAt) }) : ''
      if (body.error) {
        view.errorNode.textContent = tt('stat.error', { error: body.error })
        view.errorNode.hidden = false
      } else {
        view.errorNode.textContent = ''
        view.errorNode.hidden = true
      }

      view.cardsRoot.textContent = ''
      if (body.servers && body.servers.length > 0) {
        for (var i = 0; i < body.servers.length; i++) {
          var server = body.servers[i]
          var built = buildCard(server)
          updateCard(built, server)
          view.cardsRoot.append(built.root)
        }
      } else {
        view.cardsRoot.append(el('div', { class: 'mh-empty', text: tt('empty.servers') }))
      }
      view.cardsRoot.hidden = false
    }

    /** Mount the panel view into the center column and bind visibility to the controller. */
    function mountPanel(controller) {
      var built = buildPanel(controller)
      panelParts = built
      var container = built.view

      function applyActive(open) {
        if (open) {
          for (var i = 0; i < OTHER_ACTIVE_ATTRS.length; i++) {
            document.documentElement.removeAttribute(OTHER_ACTIVE_ATTRS[i])
          }
          document.documentElement.setAttribute(ACTIVE_ATTR, '')
          document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
          refresh(controller, false)
        } else {
          document.documentElement.removeAttribute(ACTIVE_ATTR)
        }
      }

      function onOtherActivate(event) {
        var detail = event.detail
        if (detail !== PANEL_NAME && (detail === 'ssh' || detail === 'taskboard' || detail === 'opencode-go') && controller.open) {
          controller.close()
        }
      }

      // Jump out on sidebar context clicks: clicking a session/workspace row
      // hands the center column back to the conversation. Capture phase.
      var SIDEBAR_ROW_SELECTOR =
        '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
      function onClickSidebarRow(event) {
        if (!controller.open) return
        var target = event.target
        if (target && target.closest && target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
      }

      function ensure() {
        if (container.isConnected) return
        // Current shell: the conversation slot lives in the center column
        // (`[class*="centerCol"]`); legacy shells used `[data-pane="conversation"]`.
        var column = document.querySelector('[class*="centerCol"], [data-pane="conversation"]')
        if (column === null) return
        column.appendChild(container)
        applyActive(controller.open)
      }

      var waitObserver = new MutationObserver(function () { ensure() })
      waitObserver.observe(document.body, { childList: true, subtree: true })
      document.addEventListener('click', onClickSidebarRow, true)
      document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
      var unsubscribe = controller.subscribe(applyActive)
      ensure()

      return function () {
        document.removeEventListener('click', onClickSidebarRow, true)
        document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
        waitObserver.disconnect()
        unsubscribe()
        document.documentElement.removeAttribute(ACTIVE_ATTR)
        container.remove()
        panelParts = undefined
      }
    }

    // ======================== entry ========================

    /** Services required (fiber inject waiting — the runtime must be up first). */
    exports.inject = ['slots', 'locale']

    /**
     * Mount the sidebar entry and the status panel.
     * @param ctx - client root context (locale service).
     */
    exports.apply = function (ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-mcphub: dictionaries')

      injectStyle()
      var controller = new PanelController()
      var disposers = []
      try {
        disposers.push(mountSidebarEntry(controller))
        disposers.push(mountPanel(controller))
      } catch (error) {
        // DOM failures degrade the panel, never the GUI.
        console.warn('[dsh-mcphub] mount failed:', error)
      }
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]()
          disposers.length = 0
          var style = document.getElementById('dsh-mcphub-style')
          if (style !== null) style.remove()
        }
      }, 'dsh-mcphub: ui mounts')
    }

    return module.exports
  },
})
