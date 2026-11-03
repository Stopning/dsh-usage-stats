/**
 * dsh-usage-stats — client half.
 *
 * Layout follows the official session-and-usage dashboard:
 *   header  → title + range capsules + currency capsules
 *   row 1   → 4 KPI cards
 *   row 2   → DSH 运行状态 (CPU / 内存 / 事件循环 / 运行时长) + CPU sparkline
 *   row 3   → 每日消耗 stacked bars  |  Token 构成 donut
 *   row 4   → 会话消耗排行            |  对话性能
 *   row 5   → 模型花费
 *
 * The sidebar icon and the keyed main panel share the same id, which is how
 * the harness links a panel-list entry to its main panel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const NS = 'dsh-usage-stats'
    const API = '/api/dsh-usage-stats'
    const RANGES = ['24h', '7d', '14d', '30d', 'all']

    /** Token category palette, matching the official dashboard legend. */
    const C = {
      uncached: '#3B82F6',
      cacheRead: '#49B9A0',
      cacheWrite: '#F3A139',
      output: '#855DEA',
    }

    /* ------------------------------------------------------------ locale */

    const zh = {
      title: '会话与用量',
      range24h: '近 24 小时',
      range7d: '近 7 天',
      range14d: '近 14 天',
      range30d: '近 30 天',
      rangeAll: '全部',
      cny: '人民币',
      usd: '美元',
      totalTokens: '总 Token 消耗',
      tokens: 'tokens',
      cost: '预估成本',
      sessions: '会话数',
      cacheHitRate: '缓存命中率',
      inputSplit: '输入 {a} · 输出 {b}',
      costHint: '按官方目录价估算',
      avgPerSession: '平均每会话 {n} tokens',
      cacheReadAmount: '缓存读取 {n}',
      runtimeTitle: 'DSH 运行状态',
      live: '实时 · {n} 秒采样',
      cores: '{n} 核 · 负载 {v}',
      cpuSingle: 'CPU（单核）',
      memory: '内存（RSS）',
      eventLoop: '事件循环 p99',
      uptime: '运行时长',
      heapUsed: '堆已用 {n}',
      machineLoad: '整机负载 {v} · {n} 核',
      loopMean: '平均 {v}',
      cpuHistory: '最近 5 分钟 CPU',
      peak: '峰值 {v}',
      dailyTitle: '每日消耗',
      dailySub: '按 token 堆叠 · {range}',
      composition: 'Token 构成',
      legendUncached: '输入（未命中）',
      legendCacheRead: '缓存读取',
      legendCacheWrite: '缓存写入',
      legendOutput: '输出',
      ranking: '会话消耗排行',
      byToken: '按 Token',
      byCost: '按花费',
      byDuration: '按耗时',
      perfTitle: '对话性能',
      avgTurn: '平均每轮耗时',
      avgTtft: '平均首字延迟',
      outputSpeed: '输出速度',
      toolErrorRate: '工具错误率',
      turns: '共 {n} 轮',
      ttftHint: '轮次开始到首个分片',
      decodeHint: '流式生成期间',
      toolHint: '{a} 次调用中 {b} 次报错',
      perfNote: '基于日志中的轮次边界与流式时间戳计算。',
      modelSpend: '模型花费',
      budgetTitle: '月度预算',
      budgetUsed: '{used} / {amount}',
      budgetRemaining: '剩余 {n}',
      over: '已超支',
      budgetMonth: '{month}',
      budgetEdit: '编辑预算',
      budgetSave: '保存',
      budgetCancel: '取消',
      budgetInvalid: '请输入不小于 0 的数字',
      estimated: '估算',
      estimatedHint: '部分模型未命中价目表，已按默认价估算',
      refresh: '刷新',
      loading: '加载中…',
      loadError: '加载失败',
      retry: '重试',
      noSessions: '该时间范围内没有会话用量',
      noTitle: '（无标题会话）',
      unknownModel: '未知模型',
      unknown: '未知',
    }

    const en = {
      title: 'Sessions & Usage',
      range24h: 'Last 24h',
      range7d: 'Last 7 days',
      range14d: 'Last 14 days',
      range30d: 'Last 30 days',
      rangeAll: 'All',
      cny: 'CNY',
      usd: 'USD',
      totalTokens: 'Total token usage',
      tokens: 'tokens',
      cost: 'Estimated cost',
      sessions: 'Sessions',
      cacheHitRate: 'Cache hit rate',
      inputSplit: 'Input {a} · Output {b}',
      costHint: 'Estimated at list price',
      avgPerSession: '{n} tokens per session',
      cacheReadAmount: 'Cache read {n}',
      runtimeTitle: 'DSH runtime status',
      live: 'Live · {n}s sampling',
      cores: '{n} cores · load {v}',
      cpuSingle: 'CPU (single core)',
      memory: 'Memory (RSS)',
      eventLoop: 'Event loop p99',
      uptime: 'Uptime',
      heapUsed: 'Heap used {n}',
      machineLoad: 'Machine load {v} · {n} cores',
      loopMean: 'Mean {v}',
      cpuHistory: 'CPU over the last 5 minutes',
      peak: 'Peak {v}',
      dailyTitle: 'Daily usage',
      dailySub: 'Stacked by token · {range}',
      composition: 'Token composition',
      legendUncached: 'Input (uncached)',
      legendCacheRead: 'Cache read',
      legendCacheWrite: 'Cache write',
      legendOutput: 'Output',
      ranking: 'Session usage ranking',
      byToken: 'By token',
      byCost: 'By cost',
      byDuration: 'By duration',
      perfTitle: 'Conversation performance',
      avgTurn: 'Avg time per turn',
      avgTtft: 'Avg time to first token',
      outputSpeed: 'Output speed',
      toolErrorRate: 'Tool error rate',
      turns: '{n} turns',
      ttftHint: 'Turn start to first chunk',
      decodeHint: 'During streaming',
      toolHint: '{b} errors out of {a} calls',
      perfNote: 'Computed from turn boundaries and streaming timestamps in the log.',
      modelSpend: 'Model spend',
      budgetTitle: 'Monthly budget',
      budgetUsed: '{used} / {amount}',
      budgetRemaining: '{n} left',
      over: 'Over budget',
      budgetMonth: '{month}',
      budgetEdit: 'Edit budget',
      budgetSave: 'Save',
      budgetCancel: 'Cancel',
      budgetInvalid: 'Enter a number of 0 or more',
      estimated: 'estimated',
      estimatedHint: 'Some models missed the price table and were priced with defaults',
      refresh: 'Refresh',
      loading: 'Loading…',
      loadError: 'Failed to load',
      retry: 'Retry',
      noSessions: 'No session usage in this range',
      noTitle: '(untitled session)',
      unknownModel: 'unknown model',
      unknown: 'unknown',
    }

    /* ------------------------------------------------------------ fetch */

    async function post(path, body) {
      const relative = `${API}/${path}`.replace(/^\/+/, '')
      const url = typeof document === 'undefined'
        ? `/${relative}`
        : new URL(`/${relative}`, document.baseURI).pathname
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json()
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `request failed (${response.status})`)
      }
      return payload.value
    }

    /* ------------------------------------------------------------ format */

    function formatTokens(value) {
      const n = Number(value) || 0
      if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
      return String(n)
    }

    function formatMoney(value, symbol) {
      const n = Number(value) || 0
      return `${symbol ?? '¥'}${n.toFixed(2)}`
    }

    function formatBytes(value) {
      const n = Number(value) || 0
      if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
      if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
      return `${n} B`
    }

    function formatDuration(seconds) {
      const s = Math.max(0, Math.floor(seconds || 0))
      const d = Math.floor(s / 86400)
      const hrs = Math.floor((s % 86400) / 3600)
      const min = Math.floor((s % 3600) / 60)
      if (d > 0) return `${d}d ${hrs}h`
      if (hrs > 0) return `${hrs}h ${min}m`
      return `${min}m ${s % 60}s`
    }

    function formatMs(ms) {
      const n = Number(ms) || 0
      if (n >= 60_000) return `${(n / 60_000).toFixed(1)}m`
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}s`
      return `${Math.round(n)}ms`
    }

    function formatPercent(ratio) {
      return `${((Number(ratio) || 0) * 100).toFixed(1)}%`
    }

    /* ------------------------------------------------------------ styles */

    const STYLE = `
.ust-root { --ust-whale-mask: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22377%22 height=%22277%22 viewBox=%2267 116 377 277%22%3E%3Cpath fill=%22%23000%22 fill-rule=%22nonzero%22 d=%22M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z%22/%3E%3C/svg%3E"); --ust-brand: #31BD9D; --ust-ok: #31BD9D; --ust-warn: #E0B23C; --ust-high: #F08A24; --ust-danger: #E2453C; display: flex; flex-direction: column; gap: 18px; padding: 18px 20px 28px; color: var(--dsw-alias-label-primary); flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.ust-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ust-title { font-size: 20px; font-weight: 600; letter-spacing: .2px; }
.ust-head-right { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ust-caps { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.ust-caps button { appearance: none; background: transparent; border: none; border-radius: 6px; color: var(--dsw-alias-label-secondary); padding: 5px 11px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.ust-caps button[data-active='true'] { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.ust-button { appearance: none; background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-secondary); padding: 4px 10px; cursor: pointer; font-size: 12px; }
.ust-button:hover { color: var(--dsw-alias-label-primary); }
.ust-grid { display: grid; gap: 12px; }
.ust-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.ust-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ust-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 1100px) { .ust-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 860px) { .ust-grid-3, .ust-grid-2 { grid-template-columns: minmax(0, 1fr); } }
.ust-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; }
.ust-kpi-top { display: flex; align-items: center; gap: 8px; }
.ust-kpi-ico { width: 22px; height: 22px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; }
.ust-kpi-ico svg { width: 13px; height: 13px; }
.ust-kpi-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ust-kpi-value { font-size: 26px; font-weight: 600; line-height: 1.15; margin-top: 10px; font-variant-numeric: tabular-nums; }
.ust-kpi-unit { font-size: 13px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 4px; }
.ust-kpi-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
.ust-section { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.ust-section-title { font-size: 14px; font-weight: 600; }
.ust-badge-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); color: var(--dsw-alias-state-success-primary); }
.ust-badge-live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ust-section-right { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ust-metric { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1100px) { .ust-metric { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.ust-metric-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ust-metric-value { font-size: 19px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.ust-metric-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }
.ust-spark { display: flex; align-items: flex-end; gap: 2px; height: 72px; margin-top: 16px; }
.ust-spark-bar { flex: 1; background: var(--ust-brand); border-radius: 1px; min-height: 1px; opacity: .85; }
.ust-bars { display: flex; align-items: flex-end; gap: 6px; height: 190px; padding-top: 10px; }
.ust-bar-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; gap: 5px; }
.ust-bar-stack { width: 100%; max-width: 42px; display: flex; flex-direction: column; justify-content: flex-end; gap: 1px; }
.ust-bar-seg { width: 100%; min-height: 1px; }
.ust-bar-label { font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ust-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; }
.ust-legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ust-legend-dot { width: 9px; height: 9px; border-radius: 2px; }
.ust-donut-wrap { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.ust-donut { position: relative; width: 148px; height: 148px; flex: none; }
.ust-donut svg { transform: rotate(-90deg); }
.ust-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
.ust-donut-total { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ust-donut-unit { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ust-donut-cost { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ust-legend-list { flex: 1; min-width: 200px; }
.ust-legend-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ust-legend-row:last-child { border-bottom: none; }
.ust-legend-name { flex: 1; color: var(--dsw-alias-label-secondary); }
.ust-legend-num { font-variant-numeric: tabular-nums; }
.ust-legend-pct { color: var(--dsw-alias-label-secondary); width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
.ust-daily-total { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
.ust-daily-tokens { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ust-daily-cost { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ust-rank { display: flex; flex-direction: column; }.ust-rank-row { display: flex; align-items: center; gap: 12px; padding: 9px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ust-rank-row:last-child { border-bottom: none; }
.ust-rank-no { width: 20px; height: 20px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ust-rank-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.ust-rank-sub { font-size: 10.5px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.ust-rank-num { text-align: right; flex: none; }
.ust-rank-tokens { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ust-rank-cost { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; font-variant-numeric: tabular-nums; }
.ust-perf-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; }
.ust-perf-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ust-perf-value { font-size: 19px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.ust-perf-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }
.ust-note { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 14px; }
.ust-budget { margin-top: 14px; }
.ust-budget-head { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
.ust-budget-body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; margin-top: 6px; }
.ust-rank-budget { grid-template-columns: minmax(0, 6fr) minmax(0, 4fr); }
/* narrower screens can't give the whale 30%, so fall back to stacked */
@media (max-width: 1100px) { .ust-rank-budget { grid-template-columns: minmax(0, 1fr); } }
.ust-rank-budget > .ust-card { display: flex; flex-direction: column; align-items: stretch; }
.ust-rank-budget > .ust-card > .ust-budget-body { flex: 1; }
.ust-whale { position: relative; width: 100%; max-width: 210px; flex: none; }
/* the mask clips the whole shape, so one child can be a rising water level */
.ust-whale-shape { position: relative; width: 100%; aspect-ratio: 160 / 118; -webkit-mask: var(--ust-whale-mask) center / contain no-repeat; mask: var(--ust-whale-mask) center / contain no-repeat; }
.ust-whale-empty { position: absolute; inset: 0; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent); }
.ust-whale-fill { position: absolute; left: 0; right: 0; bottom: 0; background: var(--ust-ok); transition: height .35s ease; }
.ust-whale[data-level='safe'] .ust-whale-fill { background: var(--ust-ok); }
.ust-whale[data-level='warn'] .ust-whale-fill { background: var(--ust-warn); }
.ust-whale[data-level='high'] .ust-whale-fill { background: var(--ust-high); }
.ust-whale[data-level='over'] .ust-whale-fill { background: var(--ust-danger); }
.ust-budget-side { width: 100%; min-width: 0; text-align: center; }
.ust-budget-pct { font-size: 40px; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; }
.ust-budget-pct[data-level='safe'] { color: var(--ust-ok); }
.ust-budget-pct[data-level='warn'] { color: var(--ust-warn); }
.ust-budget-pct[data-level='high'] { color: var(--ust-high); }
.ust-budget-pct[data-level='over'] { color: var(--ust-danger); }
.ust-budget-sub { font-size: 14px; color: var(--dsw-alias-label-secondary); margin-top: 6px; font-variant-numeric: tabular-nums; }
.ust-budget-left { font-size: 13px; margin-top: 4px; color: var(--dsw-alias-label-secondary); }
.ust-budget-left[data-over='true'] { color: var(--dsw-alias-state-error-primary); }
.ust-budget-amount { display: inline-flex; align-items: center; gap: 4px; }
.ust-budget-edit { appearance: none; background: transparent; border: none; padding: 0 2px; cursor: pointer; color: var(--dsw-alias-label-secondary); opacity: 0; transition: opacity .12s; line-height: 1; font-size: 12px; }
.ust-budget-amount:hover .ust-budget-edit, .ust-budget-edit:focus-visible { opacity: 1; }
.ust-budget-input { width: 88px; padding: 2px 6px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; outline: none; }
.ust-budget-input:focus { border-color: var(--ust-brand); }
.ust-budget-actions { display: inline-flex; gap: 4px; }
.ust-budget-save, .ust-budget-cancel { appearance: none; border-radius: 4px; font-size: 11px; padding: 2px 8px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); }
.ust-budget-save { background: var(--ust-brand); border-color: var(--ust-brand); color: #fff; }
.ust-budget-save:disabled { opacity: .5; cursor: default; }
.ust-model-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(80px, 2fr) 88px; gap: 12px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; }
.ust-model-row:last-child { border-bottom: none; }
.ust-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ust-model-track { height: 8px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.ust-model-track > div { min-width: 3px; }
.ust-model-fill { height: 100%; background: var(--ust-brand); }
.ust-model-num { text-align: right; font-variant-numeric: tabular-nums; }
.ust-tag { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 4px; font-size: 10px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.ust-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.ust-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.ust-warn { color: var(--dsw-alias-state-warn-primary); font-size: 11.5px; }
`

    /* ------------------------------------------------------------ pieces */

    function Icon({ path, color }) {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
        ...path.map((d, i) => h('path', { key: i, d })),
      )
    }

    const ICONS = {
      tokens: ['M12 3 3 8l9 5 9-5-9-5Z', 'M3 13l9 5 9-5', 'M3 18l9 5 9-5'],
      cost: ['M12 2v20', 'M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 9.5 12 9.5s5 1.1 5 3.5-2.2 3-5 3-5-1.1-5-3'],
      sessions: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'],
      cache: ['M13 2 4 14h6l-1 8 9-12h-6l1-8Z'],
      cpu: ['M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3', 'M6 6h12v12H6z'],
      memory: ['M3 8h18v8H3z', 'M7 12h.01M11 12h.01M15 12h.01'],
      loop: ['M12 2v6M12 16v6', 'M4 12h16', 'M8 8l4-4 4 4', 'M8 16l4 4 4-4'],
      clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
    }

    function KpiIcon({ name, tint }) {
      const paths = ICONS[name] ?? ICONS.tokens
      return h('span', {
        className: 'ust-kpi-ico',
        style: { background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint },
      }, h(Icon, { path: paths, color: 'currentColor' }))
    }

    function KpiCard({ icon, tint, label, value, unit, sub }) {
      return h('div', { className: 'ust-card' },
        h('div', { className: 'ust-kpi-top' },
          h(KpiIcon, { name: icon, tint }),
          h('span', { className: 'ust-kpi-label' }, label),
        ),
        h('div', { className: 'ust-kpi-value' }, value, unit ? h('span', { className: 'ust-kpi-unit' }, unit) : null),
        sub ? h('div', { className: 'ust-kpi-sub' }, sub) : null,
      )
    }

    function Section({ title, right, badge, children }) {
      return h('div', { className: 'ust-section' },
        h('span', { className: 'ust-section-title' }, title),
        badge ? h('span', { className: 'ust-badge-live' }, badge) : null,
        right ? h('span', { className: 'ust-section-right' }, right) : null,
        children,
      )
    }

    /** Stacked daily bars: uncached / cache read / cache write / output. */
    function DailyBars({ days }) {
      if (!days || days.length === 0) return h('div', { className: 'ust-muted' }, '—')
      const max = Math.max(...days.map((d) => d.tokens || 0), 1)
      return h('div', { className: 'ust-bars' },
        days.map((d) => {
          const total = d.tokens || 0
          const segs = [
            { value: d.uncached || 0, color: C.uncached },
            { value: d.cacheRead || 0, color: C.cacheRead },
            { value: d.cacheWrite || 0, color: C.cacheWrite },
            { value: d.output || 0, color: C.output },
          ].filter((s) => s.value > 0)
          return h('div', { className: 'ust-bar-col', key: d.date, title: `${d.date}: ${formatTokens(total)} tokens` },
            h('div', { className: 'ust-bar-stack', style: { height: `${Math.max(1, (total / max) * 100)}%` } },
              segs.map((s, i) => h('div', {
                key: i,
                className: 'ust-bar-seg',
                style: { height: `${(s.value / total) * 100}%`, background: s.color },
              })),
            ),
            h('div', { className: 'ust-bar-label' }, d.date.slice(5)),
          )
        }),
      )
    }

    /** Token composition donut plus the legend list. */
    function Donut({ totals, cost, symbol }) {
      const t = totals ?? {}
      const parts = [
        { key: 'cacheRead', value: t.cacheRead || 0, color: C.cacheRead },
        { key: 'uncached', value: t.uncached || 0, color: C.uncached },
        { key: 'cacheWrite', value: t.cacheWrite || 0, color: C.cacheWrite },
        { key: 'output', value: t.output || 0, color: C.output },
      ]
      const total = parts.reduce((s, p) => s + p.value, 0) || 1
      const R = 60
      const CIRC = 2 * Math.PI * R
      let offset = 0
      const arcs = parts.map((p) => {
        const frac = p.value / total
        const arc = {
          ...p,
          frac,
          dash: frac * CIRC,
          offset: -offset * CIRC,
        }
        offset += frac
        return arc
      })
      return h('div', { className: 'ust-donut-wrap' },
        h('div', { className: 'ust-donut' },
          h('svg', { width: '148', height: '148', viewBox: '0 0 148 148' },
            h('circle', { cx: '74', cy: '74', r: String(R), fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2)', strokeWidth: '14' }),
            arcs.map((a) => h('circle', {
              key: a.key,
              cx: '74',
              cy: '74',
              r: String(R),
              fill: 'none',
              stroke: a.color,
              strokeWidth: '14',
              strokeDasharray: `${a.dash} ${CIRC - a.dash}`,
              strokeDashoffset: String(a.offset),
            })),
          ),
          h('div', { className: 'ust-donut-center' },
            h('span', { className: 'ust-donut-total' }, formatTokens(t.tokens ?? 0)),
            h('span', { className: 'ust-donut-unit' }, 'tokens'),
            h('span', { className: 'ust-donut-cost' }, formatMoney(cost ?? 0, symbol)),
          ),
        ),
        h('div', { className: 'ust-legend-list' },
          parts.map((p) => h('div', { className: 'ust-legend-row', key: p.key },
            h('span', { className: 'ust-legend-dot', style: { background: p.color } }),
            h('span', { className: 'ust-legend-name' }, LEGEND[p.key]),
            h('span', { className: 'ust-legend-num' }, formatTokens(p.value)),
            h('span', { className: 'ust-legend-pct' }, formatPercent(p.value / total)),
          )),
        ),
      )
    }

    /* ------------------------------------------------------------ panels */

    /**
     * Budget ceiling: reads as plain text, turns into an input on click.
     * Enter or the check button saves, Esc or blur cancels; the value is
     * persisted by the Host, so a page reload keeps it.
     */
    function BudgetAmount({ t, symbol, amount, onSave }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [invalid, setInvalid] = useState(false)
      const inputRef = useRef(null)

      useEffect(() => {
        if (editing && inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      }, [editing])

      const start = () => {
        setDraft(String(amount ?? 0))
        setInvalid(false)
        setEditing(true)
      }

      const close = () => {
        setEditing(false)
        setInvalid(false)
      }

      const commit = async () => {
        const next = Number(draft)
        if (!Number.isFinite(next) || next < 0) {
          setInvalid(true)
          return
        }
        if (next === amount) return close()
        setBusy(true)
        try {
          await onSave(next)
          close()
        } catch {
          setInvalid(true)
        } finally {
          setBusy(false)
        }
      }

      if (!editing) {
        return h('span', { className: 'ust-budget-amount' },
          h('span', null, formatMoney(amount ?? 0, symbol)),
          h('button', {
            type: 'button',
            className: 'ust-budget-edit',
            title: t('budgetEdit'),
            'aria-label': t('budgetEdit'),
            onClick: start,
          }, '✎'),
        )
      }

      return h('span', { className: 'ust-budget-amount', title: invalid ? t('budgetInvalid') : undefined },
        h('input', {
          ref: inputRef,
          className: 'ust-budget-input',
          type: 'number',
          min: '0',
          step: '10',
          value: draft,
          disabled: busy,
          onChange: (event) => {
            setDraft(event.target.value)
            setInvalid(false)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          },
          onBlur: (event) => {
            // clicking the save button must not cancel first
            if (event.relatedTarget && event.relatedTarget.dataset?.role === 'budget-save') return
            if (!busy) close()
          },
        }),
        h('span', { className: 'ust-budget-actions' },
          h('button', {
            type: 'button',
            className: 'ust-budget-save',
            'data-role': 'budget-save',
            disabled: busy,
            onClick: commit,
          }, t('budgetSave')),
          h('button', {
            type: 'button',
            className: 'ust-budget-cancel',
            disabled: busy,
            onClick: close,
          }, t('budgetCancel')),
        ),
      )
    }

    function OverviewPanel({ data, rows, cpu, t, symbol, rankBy, setRankBy, onSaveBudget, dailySub }) {
      if (!data) return null
      const totals = data.totals ?? {}
      const cost = data.cost ?? {}
      const budget = data.budget ?? {}
      const perf = data.perf ?? {}
      const over = Boolean(budget.over)
      // spend ratio drives the bar colour; the thresholds are fixed bands
      const ratio = Number(budget.ratio) || 0
      const level = ratio >= 0.9 ? 'over' : ratio >= 0.6 ? 'high' : ratio >= 0.3 ? 'warn' : 'safe'

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        // KPI row
        h('div', { className: 'ust-grid ust-grid-4' },
          h(KpiCard, {
            icon: 'tokens', tint: C.uncached, label: t('totalTokens'),
            value: formatTokens(totals.tokens), unit: t('tokens'),
            sub: t('inputSplit', { a: formatTokens(totals.uncached), b: formatTokens(totals.output) }),
          }),
          h(KpiCard, {
            icon: 'cost', tint: '#0FA36B', label: t('cost'),
            value: formatMoney(cost.display, symbol),
            sub: t('costHint'),
          }),
          h(KpiCard, {
            icon: 'sessions', tint: C.output, label: t('sessions'),
            value: String(data.sessions ?? 0),
            sub: t('avgPerSession', { n: formatTokens(totals.avgTokensPerSession ?? 0) }),
          }),
          h(KpiCard, {
            icon: 'cache', tint: C.cacheWrite, label: t('cacheHitRate'),
            value: formatPercent(totals.cacheHitRate),
            sub: t('cacheReadAmount', { n: formatTokens(totals.cacheRead ?? 0) }),
          }),
        ),

        // Runtime status
        h('div', { className: 'ust-card' },
          h(Section, {
            title: t('runtimeTitle'),
            badge: t('live', { n: Math.round((cpu?.sampleIntervalMs ?? 5000) / 1000) }),
            right: cpu ? t('cores', { n: cpu.current?.cores ?? 0, v: (cpu.current?.load1 ?? 0).toFixed(2) }) : undefined,
          }),
          h('div', { className: 'ust-metric' },
            h('div', null,
              h('div', { className: 'ust-metric-label' }, t('cpuSingle')),
              h('div', { className: 'ust-metric-value' }, `${(cpu?.current?.percent ?? 0).toFixed(1)}%`),
              h('div', { className: 'ust-metric-sub' }, cpu ? t('machineLoad', { v: (cpu.current?.load1 ?? 0).toFixed(2), n: cpu.current?.cores ?? 0 }) : '—'),
            ),
            h('div', null,
              h('div', { className: 'ust-metric-label' }, t('memory')),
              h('div', { className: 'ust-metric-value' }, formatBytes(cpu?.current?.rss ?? 0)),
              h('div', { className: 'ust-metric-sub' }, cpu ? t('heapUsed', { n: formatBytes(cpu.current.heapUsed ?? 0) }) : '—'),
            ),
            h('div', null,
              h('div', { className: 'ust-metric-label' }, t('eventLoop')),
              h('div', { className: 'ust-metric-value' }, cpu ? formatMs(cpu.current?.eventLoopP99 ?? 0) : '—'),
              h('div', { className: 'ust-metric-sub' }, cpu ? t('loopMean', { v: formatMs(cpu.current?.eventLoopMean ?? 0) }) : '—'),
            ),
            h('div', null,
              h('div', { className: 'ust-metric-label' }, t('uptime')),
              h('div', { className: 'ust-metric-value' }, formatDuration(cpu?.current?.uptimeSec ?? 0)),
              h('div', { className: 'ust-metric-sub' }, cpu ? `PID ${cpu.current?.pid ?? '—'} · Node ${cpu.current?.nodeVersion ?? '—'}` : '—'),
            ),
          ),
          h('div', { style: { marginTop: '16px' } },
            h('div', { className: 'ust-section' },
              h('span', { className: 'ust-metric-label' }, t('cpuHistory')),
              h('span', { className: 'ust-section-right' }, t('peak', {
                v: `${(Math.max(0, ...(cpu?.history ?? []).map((p) => p.percent ?? 0))).toFixed(1)}%`,
              })),
            ),
            h(CpuSpark, { history: cpu?.history ?? [] }),
          ),
        ),

        // Daily usage + model spend
        h('div', { className: 'ust-grid ust-grid-2' },
          h('div', { className: 'ust-card' },
            h(Section, {
              title: t('dailyTitle'),
              // official layout puts the window total + spend on the right of the header
              right: h('span', { className: 'ust-daily-total' },
                h('span', { className: 'ust-daily-tokens' }, `${formatTokens(totals.tokens ?? 0)} tokens`),
                h('span', { className: 'ust-daily-cost' }, formatMoney(cost.display ?? 0, symbol)),
              ),
            }),
            h('div', { className: 'ust-muted', style: { marginTop: '-2px', marginBottom: '6px' } }, dailySub ?? ''),
            h(DailyBars, { days: data.timeline }),
            h('div', { className: 'ust-legend' },
              h('span', { className: 'ust-legend-item' }, h('span', { className: 'ust-legend-dot', style: { background: C.uncached } }), LEGEND.uncached),
              h('span', { className: 'ust-legend-item' }, h('span', { className: 'ust-legend-dot', style: { background: C.cacheRead } }), LEGEND.cacheRead),
              h('span', { className: 'ust-legend-item' }, h('span', { className: 'ust-legend-dot', style: { background: C.cacheWrite } }), LEGEND.cacheWrite),
              h('span', { className: 'ust-legend-item' }, h('span', { className: 'ust-legend-dot', style: { background: C.output } }), LEGEND.output),
            ),
          ),
          h('div', { className: 'ust-card' },
          h(Section, { title: t('modelSpend') }),
          (data.models ?? []).length === 0
            ? h('div', { className: 'ust-muted' }, '—')
            : h('div', null, (data.models ?? []).map((m) => {
              const ratio = (data.totals?.tokens ?? 0) > 0 ? m.tokens / data.totals.tokens : 0
              return h('div', { className: 'ust-model-row', key: m.key },
                h('div', { className: 'ust-model-name' }, m.key,
                  m.estimated ? h('span', { className: 'ust-tag' }, t('estimated')) : null),
                h('div', null,
                  h('div', { className: 'ust-model-track' },
                    h('div', { className: 'ust-model-fill', style: { width: `${Math.min(100, ratio * 100).toFixed(1)}%` } }),
                  ),
                ),
                h('div', { className: 'ust-model-num' }, formatMoney(m.costDisplay ?? 0, symbol)),
              )
            })),
          (data.estimatedModels ?? []).length > 0 ? h('div', { className: 'ust-warn', style: { marginTop: '10px' } }, t('estimatedHint')) : null,
          ),
        ),

        // Session ranking + budget, half each
        h('div', { className: 'ust-grid ust-grid-2 ust-rank-budget' },
          h('div', { className: 'ust-card' },
            h(Section, { title: t('ranking') }),
            h(RankList, { rows, t, symbol, rankBy, setRankBy }),
          ),
          h('div', { className: 'ust-card' },
            h(Section, {
              title: t('budgetTitle'),
              right: t('budgetMonth', { month: budget.month ?? '' }),
            }),
            h('div', { className: 'ust-budget-body' },
              h('div', { className: 'ust-budget-side' },
                h('div', { className: 'ust-budget-pct', 'data-level': level },
                  formatPercent(budget.ratio)),
                h('div', { className: 'ust-budget-sub' },
                  formatMoney(budget.used ?? 0, symbol),
                  ' / ',
                  h(BudgetAmount, {
                    t,
                    symbol,
                    amount: budget.amount ?? 0,
                    onSave: onSaveBudget,
                  }),
                ),
                h('div', { className: 'ust-budget-left', 'data-over': String(over) },
                  over ? t('over') : t('budgetRemaining', { n: formatMoney(Math.max(0, (budget.amount ?? 0) - (budget.used ?? 0)), symbol) })),
              ),
              // the whale is the level indicator: its colour tracks how much of the month is spent
              h('div', { className: 'ust-whale', 'data-level': level },
                h('div', { className: 'ust-whale-shape' },
                  h('div', { className: 'ust-whale-empty' }),
                  h('div', { className: 'ust-whale-fill', style: { height: `${Math.max(0, Math.min(100, Math.round((budget.ratio ?? 0) * 1000) / 10))}%` } }),
                ),
              ),
            ),
          ),
        ),

        // Token composition + conversation performance (bottom row)
        h('div', { className: 'ust-grid ust-grid-2' },
          h('div', { className: 'ust-card' },
            h(Section, { title: t('composition') }),
            h(Donut, { totals, cost: cost.display, symbol }),
          ),
          h('div', { className: 'ust-card' },
            h(Section, { title: t('perfTitle') }),
            h('div', { className: 'ust-perf-grid' },
              h('div', null,
                h('div', { className: 'ust-perf-label' }, t('avgTurn')),
                h('div', { className: 'ust-perf-value' }, formatMs(perf.avgTurnMs ?? 0)),
                h('div', { className: 'ust-perf-sub' }, t('turns', { n: perf.turns ?? 0 })),
              ),
              h('div', null,
                h('div', { className: 'ust-perf-label' }, t('avgTtft')),
                h('div', { className: 'ust-perf-value' }, formatMs(perf.avgTtftMs ?? 0)),
                h('div', { className: 'ust-perf-sub' }, t('ttftHint')),
              ),
              h('div', null,
                h('div', { className: 'ust-perf-label' }, t('outputSpeed')),
                h('div', { className: 'ust-perf-value' }, `${perf.outputTokensPerSec ?? 0}`),
                h('div', { className: 'ust-perf-sub' }, t('decodeHint')),
              ),
              h('div', null,
                h('div', { className: 'ust-perf-label' }, t('toolErrorRate')),
                h('div', { className: 'ust-perf-value' }, formatPercent(perf.toolErrorRate)),
                h('div', { className: 'ust-perf-sub' }, t('toolHint', { a: perf.commandRuns ?? 0, b: perf.commandFailed ?? 0 })),
              ),
            ),
            h('div', { className: 'ust-note' }, t('perfNote')),
          ),
        ),

      )
    }

    function CpuSpark({ history }) {
      if (!history || history.length === 0) return h('div', { className: 'ust-muted' }, '—')
      const max = Math.max(...history.map((p) => p.percent ?? 0), 1)
      return h('div', { className: 'ust-spark' },
        history.map((p) => h('div', {
          className: 'ust-spark-bar',
          key: p.at,
          title: `${new Date(p.at).toLocaleTimeString()}: ${p.percent}%`,
          style: { height: `${Math.max(1, ((p.percent ?? 0) / max) * 100)}%` },
        })),
      )
    }

    function RankList({ rows, t, symbol, rankBy, setRankBy }) {
      const modes = [
        { id: 'token', label: t('byToken') },
        { id: 'cost', label: t('byCost') },
        { id: 'duration', label: t('byDuration') },
      ]
      const sorted = useMemo(() => {
        const copy = rows.slice()
        if (rankBy === 'cost') copy.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
        else if (rankBy === 'duration') copy.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
        else copy.sort((a, b) => (b.tokens?.total ?? 0) - (a.tokens?.total ?? 0))
        return copy.slice(0, 8)
      }, [rows, rankBy])

      /** Primary/secondary figures follow the active ranking mode. */
      const figures = (s) => {
        if (rankBy === 'duration') {
          return {
            main: formatMs(s.durationMs ?? 0),
            sub: t('turns', { n: s.turns ?? 0 }),
          }
        }
        if (rankBy === 'cost') {
          return {
            main: formatMoney(s.costDisplay ?? 0, symbol),
            sub: formatTokens(s.tokens?.total ?? 0),
          }
        }
        return {
          main: formatTokens(s.tokens?.total ?? 0),
          sub: formatMoney(s.costDisplay ?? 0, symbol),
        }
      }

      if (rows.length === 0) return h('div', { className: 'ust-muted' }, t('noSessions'))
      return h('div', null,
        h('div', { className: 'ust-caps', style: { marginBottom: '10px' } },
          modes.map((m) => h('button', {
            key: m.id,
            type: 'button',
            'data-active': String(rankBy === m.id),
            onClick: () => setRankBy(m.id),
          }, m.label)),
        ),
        h('div', { className: 'ust-rank' },
          sorted.map((s, i) => {
            const f = figures(s)
            return h('div', { className: 'ust-rank-row', key: s.id },
              h('span', { className: 'ust-rank-no' }, String(i + 1)),
              h('div', { className: 'ust-rank-title' },
                s.title ?? t('noTitle'),
                h('div', { className: 'ust-rank-sub' }, s.model ? `${s.model.provider}:${s.model.model}` : t('unknownModel')),
              ),
              h('div', { className: 'ust-rank-num' },
                h('div', { className: 'ust-rank-tokens' }, f.main),
                h('div', { className: 'ust-rank-cost' }, f.sub),
              ),
            )
          }),
        ),
      )
    }

    /* ------------------------------------------------------------ root */

    function UsageStatsPanel({ t }) {
      const [range, setRange] = useState('7d')
      const [overview, setOverview] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [cpu, setCpu] = useState(null)
      const [rankBy, setRankBy] = useState('token')
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const timerRef = useRef(null)

      const load = useCallback(async () => {
        setError(null)
        try {
          const [ov, se, cp] = await Promise.all([
            post('overview', { range }),
            post('sessions', { range, limit: 200 }),
            post('cpu', {}),
          ])
          setOverview(ov)
          setSessions(se)
          setCpu(cp)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setLoading(false)
        }
      }, [range])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        timerRef.current = setInterval(() => {
          post('cpu', {}).then((value) => setCpu(value)).catch(() => {})
        }, 5000)
        return () => clearInterval(timerRef.current)
      }, [])

      const saveBudget = useCallback(async (amount) => {
        await post('budget', { amount })
        const ov = await post('overview', { range })
        setOverview(ov)
      }, [range])

      const symbol = '¥'
      const rangeLabel = (r) => t(`range${r === '24h' ? '24h' : r === 'all' ? 'All' : r}`)

      return h('div', { className: 'ust-root' },
        h('div', { className: 'ust-head' },
          h('span', { className: 'ust-title' }, t('title')),
          h('div', { className: 'ust-head-right' },
            h('div', { className: 'ust-caps' },
              RANGES.map((r) => h('button', {
                key: r,
                type: 'button',
                'data-active': String(range === r),
                onClick: () => setRange(r),
              }, rangeLabel(r))),
            ),
            h('button', { type: 'button', className: 'ust-button', onClick: load }, t('refresh')),
            loading ? h('span', { className: 'ust-muted' }, t('loading')) : null,
          ),
        ),
        error
          ? h('div', { className: 'ust-error' }, `${t('loadError')}: ${error} `,
            h('button', { type: 'button', className: 'ust-button', onClick: load }, t('retry')))
          : null,
        h(OverviewPanel, {
          data: overview,
          rows: sessions?.sessions ?? [],
          cpu,
          t,
          symbol,
          rankBy,
          setRankBy,
          onSaveBudget: saveBudget,
          dailySub: t('dailySub', { range: rangeLabel(range) }),
        }),
      )
    }

    /* ------------------------------------------------------------ icon */

    function UsageIcon({ size }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none' },
        h('rect', { x: '3', y: '12', width: '4', height: '8', rx: '1', fill: 'currentColor' }),
        h('rect', { x: '10', y: '7', width: '4', height: '13', rx: '1', fill: 'currentColor' }),
        h('rect', { x: '17', y: '3', width: '4', height: '17', rx: '1', fill: 'currentColor' }),
      )
    }

    /* ------------------------------------------------------------ register */

    /** Legend text is shared by both charts and lives next to the palette. */
    let LEGEND = {}

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          // The locale service throws when the namespace already carries a language.
          // A re-applied entry (reload / bundle refresh) would abort here and never
          // reach the slot registrations, so registration must stay idempotent.
          try {
            return ctx.locale.register(NS, { zh, en })
          } catch {
            return undefined
          }
        }, `${NS}: dictionaries`)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshUsageStats = 'true'
          style.textContent = STYLE
          document.head.append(style)
          return () => style.remove()
        }, `${NS}: styles`)

        const t = ctx.locale.bind(NS)

        LEGEND = {
          uncached: t('legendUncached'),
          cacheRead: t('legendCacheRead'),
          cacheWrite: t('legendCacheWrite'),
          output: t('legendOutput'),
        }

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS }, () => h(UsageStatsPanel, { t })))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: NS,
          order: 5,
          label: () => t('title'),
        }, (props) => h(UsageIcon, { size: props?.size })))
      },
    }
  },
})
