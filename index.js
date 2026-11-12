/**
 * dsh-usage-stats
 * Token / cost / budget / CPU statistics over the DSH session projection cache.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'

/** Nanoseconds -> milliseconds; an empty histogram reports NaN, so clamp to 0. */
function roundDelay(ns) {
  return Number.isFinite(ns) ? Math.round(ns / 1000) / 1000 : 0
}
import { homedir, cpus, loadavg, totalmem } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-usage-stats'
export const inject = ['storageDomain', 'connection']

const RANGES = ['24h', '7d', '14d', '30d', 'all']

/**
 * Minimal standard-schema config.
 *
 * The bundle is installed as a symlink into the profile, so bare imports are
 * resolved from the workspace real path and would need their own node_modules.
 * Cordis only requires `Config["~standard"].validate()`, so the schema lives
 * here instead of pulling a validation library in.
 */
function defineConfig(spec) {
  const keys = Object.keys(spec)
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'dsh-usage-stats',
      validate(value) {
        const input = value && typeof value === 'object' ? value : {}
        const issues = []
        const result = {}
        for (const key of keys) {
          const field = spec[key]
          let raw = input[key]
          if (raw === undefined || raw === null) raw = field.default
          if (raw === undefined) continue
          if (field.type === 'number') {
            if (typeof raw !== 'number' || !Number.isFinite(raw)) {
              issues.push({ message: `${key} must be a finite number`, path: [key] })
              continue
            }
            if (field.min !== undefined && raw < field.min) {
              issues.push({ message: `${key} must be >= ${field.min}`, path: [key] })
              continue
            }
            if (field.max !== undefined && raw > field.max) {
              issues.push({ message: `${key} must be <= ${field.max}`, path: [key] })
              continue
            }
          } else if (field.type === 'enum') {
            if (!field.values.includes(raw)) {
              issues.push({ message: `${key} must be one of ${field.values.join(', ')}`, path: [key] })
              continue
            }
          }
          result[key] = raw
        }
        if (issues.length) return { issues }
        return { value: result }
      },
    },
  }
  return schema
}

export const Config = defineConfig({
  budgetAmount: { type: 'number', min: 0, default: 100 },
  budgetPeriod: { type: 'enum', values: ['month'], default: 'month' },
  defaultRange: { type: 'enum', values: RANGES, default: '30d' },
  refreshIntervalMs: { type: 'number', min: 1000, default: 5000 },
  topSessions: { type: 'number', min: 1, max: 1000, default: 200 },
  currency: { type: 'enum', values: ['CNY', 'USD'], default: 'CNY' },
})

const NS = 'dsh-usage-stats'
const CACHE_TTL_MS = 15_000
const PRICE_TTL_MS = 60_000
const CPU_SAMPLE_MS = 5_000
const CPU_HISTORY = 60

/* ------------------------------------------------------------------ utils */

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function plain(value) {
  return value !== null && typeof value === 'object' ? value : undefined
}

function rowValue(record, key) {
  const row = plain(record?.rows?.[key])
  return row ? row.val : undefined
}

/* ------------------------------------------------------------------ prices */

/**
 * Model ids are compared without separators and case, so `deepseek-v4-1-flash`
 * and `deepseek-v4.1-flash` resolve to the same price row.
 */
function normalizeModelId(model) {
  return String(model ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Tail of a `vendor/model` key, normalized the same way. */
function modelTail(model) {
  return normalizeModelId(String(model ?? '').split('/').pop())
}

/**
 * Find a price row for `model` inside one table. Both sides are compared
 * without separators, and a `vendor/model` key also matches on its tail.
 */
function lookupModel(table, model) {
  if (!table) return undefined
  const candidates = new Set([normalizeModelId(model), modelTail(model)])
  for (const key of Object.keys(table)) {
    if (candidates.has(normalizeModelId(key)) || candidates.has(modelTail(key))) return table[key]
  }
  return undefined
}

/**
 * Same as `lookupModel`, but keeps the newest `checkedAt` row when several
 * providers list the same model under different prices.
 */
function lookupModelAcrossProviders(providers, model) {
  let best
  let bestAt = -Infinity
  for (const entry of Object.values(plain(providers) ?? {})) {
    const table = plain(entry?.models)
    if (!table) continue
    for (const key of Object.keys(table)) {
      const candidates = new Set([normalizeModelId(model), modelTail(model)])
      if (!candidates.has(normalizeModelId(key)) && !candidates.has(modelTail(key))) continue
      const checkedAt = Date.parse(table[key]?.checkedAt ?? '') || 0
      if (checkedAt >= bestAt) {
        bestAt = checkedAt
        best = table[key]
      }
    }
  }
  return best
}

/**
 * Resolve a price table for one provider:model pair.
 * `bucket` is 'peak' | 'off' | undefined (flat pricing).
 *
 * Resolution order:
 *   1. bundled model table (official DeepSeek models, peak/off aware)
 *   2. the channel's own provider table
 *   3. the same model priced under another channel (published list price)
 *   4. the default table, flagged as an estimate
 */
function resolvePrice(prices, provider, model, bucket) {
  // 1) direct model table (deepseek official models, peak/off aware)
  const direct = lookupModel(prices.models, model)
  if (direct) {
    const tier = bucket === 'peak' ? direct.peak : bucket === 'off' ? direct.offPeak : undefined
    const table = tier ?? direct
    return {
      source: 'model',
      cacheHit: num(table.cacheHit),
      cacheMiss: num(table.cacheMiss),
      cacheWrite: Number.isFinite(table.cacheWrite) ? num(table.cacheWrite) : undefined,
      output: num(table.output),
      peakAware: Boolean(direct.peak && direct.offPeak),
    }
  }

  // 2) provider table (flat, or utc-peak with explicit peak/offPeak)
  const providers = plain(prices.providers) ?? {}
  const providerEntry = plain(providers[provider])
  const own = lookupModel(providerEntry?.models, model)
  if (own) {
    const tier = bucket === 'peak' ? own.peak : bucket === 'off' ? own.offPeak : undefined
    if (tier) {
      return {
        source: 'provider-peak',
        cacheHit: num(tier.cacheHit ?? tier.cachedInput),
        cacheMiss: num(tier.cacheMiss ?? tier.input),
        cacheWrite: Number.isFinite(tier.cacheWrite) ? num(tier.cacheWrite) : undefined,
        output: num(tier.output),
        peakAware: true,
      }
    }
    return {
      source: 'provider',
      cacheHit: num(own.cacheHit ?? own.cachedInput),
      cacheMiss: num(own.cacheMiss ?? own.input),
      cacheWrite: Number.isFinite(own.cacheWrite) ? num(own.cacheWrite) : undefined,
      output: num(own.output),
      peakAware: false,
    }
  }

  // 3) the same model listed by another channel
  const proxied = lookupModelAcrossProviders(providers, model)
  if (proxied) {
    const tier = bucket === 'peak' ? proxied.peak : bucket === 'off' ? proxied.offPeak : undefined
    const table = tier ?? proxied
    return {
      source: 'proxied',
      cacheHit: num(table.cacheHit ?? table.cachedInput),
      cacheMiss: num(table.cacheMiss ?? table.input),
      cacheWrite: Number.isFinite(table.cacheWrite) ? num(table.cacheWrite) : undefined,
      output: num(table.output),
      peakAware: Boolean(table.peak && table.offPeak),
      proxied: true,
    }
  }

  // 4) default fallback
  const fallback = plain(prices.default)
  if (fallback) {
    const tier = bucket === 'peak' ? fallback.peak : bucket === 'off' ? fallback.offPeak : undefined
    const table = tier ?? fallback
    return {
      source: 'default',
      cacheHit: num(table.cacheHit),
      cacheMiss: num(table.cacheMiss),
      cacheWrite: Number.isFinite(table.cacheWrite) ? num(table.cacheWrite) : undefined,
      output: num(table.output),
      peakAware: Boolean(fallback.peak && fallback.offPeak),
      estimated: true,
    }
  }

  return { source: 'none', cacheHit: 0, cacheMiss: 0, output: 0, peakAware: false, estimated: true }
}

/**
 * Cost of one bucket, in USD.
 */
function bucketCostUsd(bucket, price) {
  const uncached = num(bucket?.uncached)
  const cacheRead = num(bucket?.cacheRead)
  const cacheWrite = num(bucket?.cacheWrite)
  const output = num(bucket?.output)
  // cacheWrite falls back to the miss rate because most providers bill the
  // first-time write of a prompt at input price; a table can override it.
  const writeRate = Number.isFinite(price.cacheWrite) ? price.cacheWrite : price.cacheMiss
  const usd =
    (uncached * price.cacheMiss +
      cacheRead * price.cacheHit +
      cacheWrite * writeRate +
      output * price.output) /
    1_000_000
  return { usd, tokens: uncached + cacheRead + cacheWrite + output }
}

/* ------------------------------------------------------------------ collect */

function collectSessions(table) {
  const sessions = []
  for (const [id, record] of table.entries()) {
    const identity = plain(record?.identity)
    const activity = plain(rowValue(record, 'contextActivity'))
    const days = plain(activity?.days) ?? {}
    const usage = plain(rowValue(record, 'tokenUsage'))
    const totals = plain(usage?.totals) ?? {}
    const stats = plain(rowValue(record, 'sessionStats')) ?? {}
    const title = rowValue(record, 'title')
    const model = plain(rowValue(record, 'modelSelection'))?.lastUsed ?? undefined
    const timeline = plain(rowValue(record, 'contextTimeline'))
    const timing = plain(timeline?.timing)
    const commandStats = plain(timeline?.commandStats)

    const dayEntries = []
    for (const [date, day] of Object.entries(days)) {
      const d = plain(day)
      if (!d) continue
      dayEntries.push({ date, day: d })
    }

    const totalTokens =
      num(totals.uncachedInputTokens) +
      num(totals.outputTokens) +
      num(totals.cacheReadTokens) +
      num(totals.cacheWriteTokens)

    sessions.push({
      id,
      title: typeof title === 'string' && title !== '' ? title : undefined,
      createdAt: num(identity?.createdAt),
      cwd: typeof identity?.cwd === 'string' ? identity.cwd : undefined,
      totals: {
        uncached: num(totals.uncachedInputTokens),
        output: num(totals.outputTokens),
        cacheRead: num(totals.cacheReadTokens),
        cacheWrite: num(totals.cacheWriteTokens),
      },
      totalTokens,
      stats: {
        turns: num(stats.turns),
        steps: num(stats.steps),
        llmMs: num(stats.llmMs),
        toolMs: num(stats.toolMs),
        ttftMs: num(stats.ttftMs),
        ttftSteps: num(stats.ttftSteps),
        decodeMs: num(stats.decodeMs),
        decodeTokens: num(stats.decodeTokens),
      },
      perf: {
        wallMs: num(timing?.wallMs),
        genMs: num(timing?.genMs),
        toolCalls: num(timing?.toolCalls),
        toolBusyMs: num(timing?.toolBusyMs),
        commandRuns: num(commandStats?.runs),
        commandFailed: num(commandStats?.failed),
      },
      model: model ? { provider: model.provider, model: model.model } : undefined,
      days: dayEntries,
    })
  }
  return sessions
}

/* ------------------------------------------------------------------ pricing */

async function loadPrices() {
  const path = join(homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json')
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    const config = plain(parsed?.config) ?? {}
    const prices = plain(config.prices) ?? {}
    return {
      prices,
      exchangeRate: num(config.exchangeRate, 1) || 1,
      currency: typeof config.currency === 'string' ? config.currency : 'CNY',
      // ledger.json stores the display symbol; fall back to the currency's glyph
      symbol:
        typeof config.symbol === 'string' && config.symbol !== ''
          ? config.symbol
          : (typeof config.currency === 'string' && config.currency === 'USD' ? '$' : '¥'),
      decimals: num(config.decimals, 2),
      peakEnabled: config.peakEnabled !== false,
      source: path,
    }
  } catch (error) {
    return { prices: {}, exchangeRate: 1, currency: 'CNY', symbol: '¥', decimals: 2, peakEnabled: true, error: String(error) }
  }
}

/* ------------------------------------------------------------ budget store */

/** Private store: survives restarts without touching the profile config. */
function budgetPath() {
  return join(homedir(), '.dsh', 'storages', 'dsh-usage-stats', 'budget.json')
}

async function readStoredBudget() {
  try {
    const parsed = JSON.parse(await readFile(budgetPath(), 'utf-8'))
    const amount = Number(parsed?.amount)
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined
  } catch {
    return undefined
  }
}

async function writeStoredBudget(amount) {
  const path = budgetPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ amount, updatedAt: new Date().toISOString() }, null, 2), 'utf-8')
}

/* ------------------------------------------------------------------ host */

export function apply(ctx, config) {
  const settings = {
    // seeded from config, then overridden by the stored value once loaded
    budgetAmount: num(config?.budgetAmount, 100),
    budgetPeriod: config?.budgetPeriod === 'month' ? 'month' : 'month',
    defaultRange: RANGES.includes(config?.defaultRange) ? config.defaultRange : '30d',
    refreshIntervalMs: num(config?.refreshIntervalMs, 5000),
    topSessions: num(config?.topSessions, 200),
    currency: config?.currency === 'USD' ? 'USD' : 'CNY',
  }

  let sessionsCache = { at: 0, value: null }
  let priceCache = { at: 0, value: null }

  // the panel's inline editor wins over the config default
  readStoredBudget()
    .then((amount) => {
      if (amount !== undefined) settings.budgetAmount = amount
    })
    .catch((error) => ctx.logger?.warn?.(`${NS}: budget load failed (${String(error)})`))

  async function getSessions() {
    const now = Date.now()
    if (sessionsCache.value && now - sessionsCache.at < CACHE_TTL_MS) return sessionsCache.value
    const domain = ctx.get('storageDomain')
    const proj = domain?.get?.('session_projcache')
    const table = proj?.table?.('sessions')
    if (!table || typeof table.entries !== 'function') {
      sessionsCache = { at: now, value: [] }
      return []
    }
    let sessions = []
    try {
      sessions = collectSessions(table)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-usage-stats: session collection failed (${String(error)})`)
      sessions = []
    }
    sessionsCache = { at: now, value: sessions }
    return sessions
  }

  async function getPrices() {
    const now = Date.now()
    if (priceCache.value && now - priceCache.at < PRICE_TTL_MS) return priceCache.value
    const value = await loadPrices()
    priceCache = { at: now, value }
    return value
  }

  /* -------------------------------------------------------- aggregation */

  function rangeStart(range, now) {
    if (range === '24h') return now - 86_400_000
    if (range === '7d') return now - 7 * 86_400_000
    if (range === '14d') return now - 14 * 86_400_000
    if (range === '30d') return now - 30 * 86_400_000
    return null
  }

  function inRange(date, from) {
    if (from === null) return true
    const ts = Date.parse(`${date}T00:00:00Z`)
    return Number.isFinite(ts) ? ts >= from : true
  }

  /** Coarsest unit that keeps the series readable in one row of bars. */
  const MAX_BARS = 32

  function bucketKey(date, unit) {
    if (unit === 'day') return date
    if (unit === 'week') {
      // ISO-ish week of the month is not meaningful across months, so anchor
      // on the Monday of the week instead: "W 2026-11-03".
      const ts = Date.parse(`${date}T00:00:00Z`)
      if (!Number.isFinite(ts)) return date
      const dow = new Date(ts).getUTCDay() || 7
      const monday = new Date(ts - (dow - 1) * 86_400_000)
      return `W ${monday.toISOString().slice(0, 10)}`
    }
    return date.slice(0, 7)
  }

  /**
   * Fold a per-day series into at most MAX_BARS bars. A long "all" range can
   * span months; drawing one bar per day squeezes every bar to sub-pixel width,
   * so aggregate by week, then by month, until the series fits.
   */
  function foldTimeline(timeline) {
    if (timeline.length <= MAX_BARS) return { unit: 'day', days: timeline }
    for (const unit of ['week', 'month']) {
      const buckets = new Map()
      for (const d of timeline) {
        const key = bucketKey(d.date, unit)
        const cur = buckets.get(key)
        if (!cur) {
          buckets.set(key, { ...d, date: key })
          continue
        }
        for (const field of ['uncached', 'output', 'cacheRead', 'cacheWrite', 'tokens', 'costUsd']) {
          cur[field] = (cur[field] ?? 0) + (d[field] ?? 0)
        }
      }
      if (buckets.size <= MAX_BARS || unit === 'month') {
        return { unit, days: [...buckets.values()] }
      }
    }
    return { unit: 'month', days: timeline }
  }

  async function buildOverview(range, currencyOverride) {
    const [sessions, priceInfo] = await Promise.all([getSessions(), getPrices()])
    const from = rangeStart(range, Date.now())
    const rate = priceInfo.exchangeRate
    const currency = currencyOverride === 'USD' || currencyOverride === 'CNY' ? currencyOverride : settings.currency
    const toDisplay = (usd) => (currency === 'USD' ? usd : usd * rate)

    const totals = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 }
    const byDay = new Map()
    const byModel = new Map()
    const estimatedModels = new Set()
    const perf = {
      turns: 0,
      wallMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
      commandRuns: 0,
      commandFailed: 0,
    }
    let sessionCount = 0
    let fallbackSessions = 0

    /** USD cost of one day entry, priced per provider:model:tier bucket. */
    const costOfDay = (day) => {
      let usd = 0
      const cost = plain(day?.cost) ?? {}
      for (const [provider, models] of Object.entries(cost)) {
        for (const [model, tiers] of Object.entries(plain(models) ?? {})) {
          for (const [tier, values] of Object.entries(plain(tiers) ?? {})) {
            const bucketName = tier === 'peak' ? 'peak' : tier === 'off' ? 'off' : undefined
            const price = resolvePrice(priceInfo.prices, provider, model, bucketName)
            usd += bucketCostUsd(values, price).usd
          }
        }
      }
      return usd
    }

    for (const session of sessions) {
      const dayRows = session.days.length > 0
        ? session.days
        : session.totalTokens > 0
          ? [{ date: new Date(session.createdAt || Date.now()).toISOString().slice(0, 10), day: { tokens: session.totalTokens } }]
          : []
      if (session.totalTokens > 0 && session.days.length === 0) fallbackSessions++
      if (dayRows.length === 0) continue

      let sessionTokens = 0
      let sessionInRange = false
      let sessionRangeTurns = 0
      let sessionRangeWallMs = 0
      for (const { date, day } of dayRows) {
        if (!inRange(date, from)) continue
        sessionTokens += num(day.tokens)
        sessionRangeTurns += num(day.turns)
        sessionRangeWallMs += num(day.wallMs)
        sessionInRange = true

        const bucket = byDay.get(date) ?? {
          date,
          uncached: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tokens: 0,
          costUsd: 0,
          requests: 0,
          turns: 0,
        }
        bucket.tokens += num(day.tokens)
        bucket.requests += num(day.requests)
        bucket.turns += num(day.turns)
        bucket.costUsd += costOfDay(day)

        const cost = plain(day.cost) ?? {}
        for (const [provider, models] of Object.entries(cost)) {
          const modelMap = plain(models) ?? {}
          for (const [model, tiers] of Object.entries(modelMap)) {
            const tierMap = plain(tiers) ?? {}
            for (const [tier, values] of Object.entries(tierMap)) {
              const bucketName = tier === 'peak' ? 'peak' : tier === 'off' ? 'off' : undefined
              const price = resolvePrice(priceInfo.prices, provider, model, bucketName)
              if (price.source === 'default' || price.source === 'none') estimatedModels.add(`${provider}:${model}`)
              bucket.uncached += num(values?.uncached)
              bucket.output += num(values?.output)
              bucket.cacheRead += num(values?.cacheRead)
              bucket.cacheWrite += num(values?.cacheWrite)

              const key = `${provider}:${model}`
              const entry = byModel.get(key) ?? {
                key,
                provider,
                model,
                tokens: 0,
                costUsd: 0,
                estimated: false,
                priceSource: price.source,
              }
              entry.tokens += num(values?.uncached) + num(values?.cacheRead) + num(values?.cacheWrite) + num(values?.output)
              entry.costUsd += bucketCostUsd(values, price).usd
              if (price.estimated) entry.estimated = true
              if (price.source === 'proxied') entry.priceSource = 'proxied'
              byModel.set(key, entry)
            }
          }
        }
        byDay.set(date, bucket)
      }
      if (sessionTokens > 0) sessionCount++
      if (sessionInRange) {
        // turns/wallMs come from the day buckets so they match the selected range;
        // ttft/decode are lifetime rates (per-day timings are not recorded).
        perf.turns += sessionRangeTurns
        perf.wallMs += sessionRangeWallMs
        perf.ttftMs += session.stats.ttftMs
        perf.ttftSteps += session.stats.ttftSteps
        perf.decodeMs += session.stats.decodeMs
        perf.decodeTokens += session.stats.decodeTokens
        perf.commandRuns += session.perf.commandRuns
        perf.commandFailed += session.perf.commandFailed
      }
    }

    for (const bucket of byDay.values()) {
      totals.uncached += bucket.uncached
      totals.output += bucket.output
      totals.cacheRead += bucket.cacheRead
      totals.cacheWrite += bucket.cacheWrite
      totals.tokens += bucket.tokens
    }

    const timeline = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
    const totalCostUsd = timeline.reduce((sum, b) => sum + b.costUsd, 0)
    // Long ranges fold to weeks/months so the bars keep a readable width.
    const folded = foldTimeline(timeline)

    // monthly budget: current calendar month, computed over ALL sessions
    // (independent of the selected display range)
    const now = new Date()
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    let monthCostUsd = 0
    let monthTokens = 0
    for (const session of sessions) {
      for (const { date, day } of session.days) {
        if (!date.startsWith(monthKey)) continue
        monthCostUsd += costOfDay(day)
        monthTokens += num(day.tokens)
      }
    }

    const budgetAmount = settings.budgetAmount
    const budgetUsed = toDisplay(monthCostUsd)

    return {
      range,
      requestedRange: range,
      currency,
      symbol: currency === 'USD' ? '$' : priceInfo.symbol,
      exchangeRate: rate,
      sessions: sessionCount,
      fallbackSessions,
      totals: {
        ...totals,
        // hit rate is measured against the input side only; folding output
        // tokens in would understate it
        cacheHitRate:
          totals.cacheRead + totals.uncached > 0
            ? totals.cacheRead / (totals.cacheRead + totals.uncached)
            : 0,
        avgTokensPerSession: sessionCount > 0 ? Math.round(totals.tokens / sessionCount) : 0,
      },
      cost: {
        usd: totalCostUsd,
        display: toDisplay(totalCostUsd),
      },
      perf: {
        turns: perf.turns,
        avgTurnMs: perf.turns > 0 ? Math.round(perf.wallMs / perf.turns) : 0,
        avgTtftMs: perf.ttftSteps > 0 ? Math.round(perf.ttftMs / perf.ttftSteps) : 0,
        outputTokensPerSec: perf.decodeMs > 0 ? Math.round((perf.decodeTokens / perf.decodeMs) * 1000) : 0,
        commandRuns: perf.commandRuns,
        commandFailed: perf.commandFailed,
        toolErrorRate: perf.commandRuns > 0 ? perf.commandFailed / perf.commandRuns : 0,
      },
      budget: {
        amount: budgetAmount,
        period: settings.budgetPeriod,
        used: budgetUsed,
        ratio: budgetAmount > 0 ? budgetUsed / budgetAmount : 0,
        over: budgetAmount > 0 && budgetUsed > budgetAmount,
        month: monthKey,
        monthTokens,
        monthCostUsd,
      },
      timeline: folded.days,
      timelineUnit: folded.unit,
      models: [...byModel.values()]
        .sort((a, b) => b.tokens - a.tokens)
        .map((m) => ({ ...m, costDisplay: toDisplay(m.costUsd) })),
      estimatedModels: [...estimatedModels],
      pricingSource: priceInfo.source,
      priceError: priceInfo.error,
    }
  }

  async function buildSessions(range, limit, currencyOverride) {
    const [sessions, priceInfo] = await Promise.all([getSessions(), getPrices()])
    const from = rangeStart(range, Date.now())
    const rate = priceInfo.exchangeRate
    const currency = currencyOverride === 'USD' || currencyOverride === 'CNY' ? currencyOverride : settings.currency
    const toDisplay = (usd) => (currency === 'USD' ? usd : usd * rate)

    const rows = []
    for (const session of sessions) {
      const dayRows = session.days.length > 0
        ? session.days
        : session.totalTokens > 0
          ? [{ date: new Date(session.createdAt || Date.now()).toISOString().slice(0, 10), day: { tokens: session.totalTokens } }]
          : []
      if (dayRows.length === 0) continue

      const entry = {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        cwd: session.cwd,
        model: session.model,
        stats: session.stats,
        tokens: { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        costUsd: 0,
        // range-scoped activity, summed from the per-day buckets below
        durationMs: 0,
        turns: 0,
        days: [],
      }
      let hasRange = false
      for (const { date, day } of dayRows) {
        if (!inRange(date, from)) continue
        hasRange = true
        const dayRow = {
          date,
          tokens: num(day.tokens),
          requests: num(day.requests),
          turns: num(day.turns),
          costUsd: 0,
        }
        const cost = plain(day.cost) ?? {}
        for (const [provider, models] of Object.entries(cost)) {
          for (const [model, tiers] of Object.entries(plain(models) ?? {})) {
            for (const [tier, values] of Object.entries(plain(tiers) ?? {})) {
              const bucketName = tier === 'peak' ? 'peak' : tier === 'off' ? 'off' : undefined
              const price = resolvePrice(priceInfo.prices, provider, model, bucketName)
              const { usd } = bucketCostUsd(values, price)
              dayRow.costUsd += usd
              entry.tokens.uncached += num(values?.uncached)
              entry.tokens.output += num(values?.output)
              entry.tokens.cacheRead += num(values?.cacheRead)
              entry.tokens.cacheWrite += num(values?.cacheWrite)
            }
          }
        }
        entry.costUsd += dayRow.costUsd
        entry.tokens.total += num(day.tokens)
        entry.durationMs += num(day.wallMs)
        entry.turns += num(day.turns)
        entry.days.push(dayRow)
      }
      if (!hasRange) continue
      rows.push(entry)
    }

    rows.sort((a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total)
    const capped = rows.slice(0, limit)
    return {
      range,
      currency,
      symbol: currency === 'USD' ? '$' : priceInfo.symbol,
      total: rows.length,
      sessions: capped.map((row) => ({
        ...row,
        costDisplay: toDisplay(row.costUsd),
        durationMs: row.durationMs,
        turns: row.turns,
        days: row.days.map((d) => ({ ...d, costDisplay: toDisplay(d.costUsd) })),
      })),
    }
  }

  /* -------------------------------------------------------- cpu sampling */

  const cpuHistory = []
  let lastCpu = null
  const eventLoop = monitorEventLoopDelay({ resolution: 20 })

  function cpuSample() {
    const usage = process.cpuUsage()
    const now = Date.now()
    const cpusInfo = cpus()
    const cores = cpusInfo.length || 1
    let percent = 0
    if (lastCpu) {
      const wallMs = now - lastCpu.at
      const usedUs = usage.user - lastCpu.user + (usage.system - lastCpu.system)
      if (wallMs > 0) percent = Math.min(100, (usedUs / 1000 / wallMs / cores) * 100)
    }
    lastCpu = { at: now, user: usage.user, system: usage.system }
    const mem = process.memoryUsage()
    const load = loadavg()
    const point = {
      at: now,
      percent: Math.round(percent * 100) / 100,
      userMs: Math.round(usage.user / 1000),
      systemMs: Math.round(usage.system / 1000),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      uptimeSec: Math.round(process.uptime()),
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      cores,
      totalMem: totalmem(),
      pid: process.pid,
      nodeVersion: process.version,
      // both readings are NaN right after a reset (no samples yet) or when a
      // sample was not taken; report 0 rather than null so the card stays stable
      eventLoopP99: roundDelay(eventLoop.percentile(99)),
      eventLoopMean: roundDelay(eventLoop.mean),
    }
    // the histogram is cumulative since enable; reset so each sample reports
    // the loop delay observed in this interval only
    eventLoop.reset()
    cpuHistory.push(point)
    while (cpuHistory.length > CPU_HISTORY) cpuHistory.shift()
    return point
  }

  function cpuSnapshot() {
    const current = cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1] : cpuSample()
    return {
      current,
      history: cpuHistory.map((p) => ({ at: p.at, percent: p.percent, rss: p.rss })),
      sampleIntervalMs: CPU_SAMPLE_MS,
    }
  }

  /* -------------------------------------------------------- routes */

  function json(value) {
    return Response.json(value, { headers: { 'cache-control': 'no-store' } })
  }

  function fail(code, message) {
    return json({ ok: false, error: { code, message } })
  }

  function registerRoute(path, handler) {
    const connection = ctx.get('connection')
    const register = connection?.fetch?.register
    if (typeof register !== 'function') return false
    try {
      ctx.effect(() => register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler }), `${NS}: ${path}`)
    } catch (error) {
      ctx.logger?.warn?.(`${NS}: failed to register ${path} (${String(error)})`)
      return false
    }
    return true
  }

  registerRoute('/api/dsh-usage-stats/overview', async (request) => {
    let range = settings.defaultRange
    let currency
    try {
      const body = await request.json()
      if (body && typeof body.range === 'string' && RANGES.includes(body.range)) range = body.range
      if (body && (body.currency === 'USD' || body.currency === 'CNY')) currency = body.currency
    } catch {
      /* empty body is fine */
    }
    try {
      return json({ ok: true, value: await buildOverview(range, currency) })
    } catch (error) {
      ctx.logger?.error?.(`${NS}: overview failed (${String(error)})`)
      return fail('dsh-usage-stats/overview-failed', String(error))
    }
  })

  registerRoute('/api/dsh-usage-stats/sessions', async (request) => {
    let range = settings.defaultRange
    let limit = settings.topSessions
    let currency
    try {
      const body = await request.json()
      if (body && typeof body.range === 'string' && RANGES.includes(body.range)) range = body.range
      if (body && Number.isFinite(body.limit)) limit = Math.min(Math.max(1, body.limit), 1000)
      if (body && (body.currency === 'USD' || body.currency === 'CNY')) currency = body.currency
    } catch {
      /* empty body is fine */
    }
    try {
      return json({ ok: true, value: await buildSessions(range, limit, currency) })
    } catch (error) {
      ctx.logger?.error?.(`${NS}: sessions failed (${String(error)})`)
      return fail('dsh-usage-stats/sessions-failed', String(error))
    }
  })

  registerRoute('/api/dsh-usage-stats/budget', async (request) => {
    let amount
    try {
      const body = await request.json()
      const raw = body?.amount
      amount = typeof raw === 'string' ? Number(raw) : raw
    } catch {
      /* handled below */
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return fail('dsh-usage-stats/bad-budget', 'budget amount must be a non-negative number')
    }
    amount = Math.round(amount * 100) / 100
    try {
      await writeStoredBudget(amount)
      settings.budgetAmount = amount
      return json({ ok: true, value: { amount } })
    } catch (error) {
      ctx.logger?.error?.(`${NS}: budget save failed (${String(error)})`)
      return fail('dsh-usage-stats/budget-save-failed', String(error))
    }
  })

  registerRoute('/api/dsh-usage-stats/cpu', async () => {
    try {
      return json({ ok: true, value: cpuSnapshot() })
    } catch (error) {
      return fail('dsh-usage-stats/cpu-failed', String(error))
    }
  })

  /* -------------------------------------------------------- cpu timer */

  ctx.effect(() => {
    eventLoop.enable()
    cpuSample()
    const timer = setInterval(() => {
      try {
        cpuSample()
      } catch {
        /* sampling must never break the plugin */
      }
    }, CPU_SAMPLE_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
      try {
        eventLoop.disable()
      } catch {
        /* already disabled */
      }
    }
  }, `${NS}: cpu sampler`)
}
