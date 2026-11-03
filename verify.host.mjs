/**
 * Host-side verification harness for dsh-usage-stats.
 *
 * Loads the real plugin entry, feeds it the real session projection cache
 * (through a storageDomain-shaped adapter over the on-disk records) and calls
 * the three registered route handlers, printing the real payloads.
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJ = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')

const files = (await readdir(PROJ)).filter((f) => f.endsWith('.json'))
const entries = new Map()
for (const file of files) {
  try {
    const raw = await readFile(join(PROJ, file), 'utf-8')
    const parsed = JSON.parse(raw)
    const record = parsed?.record
    if (!record) continue
    entries.set(file.replace(/\.json$/, ''), record)
  } catch {
    /* skip unreadable records */
  }
}

// storageDomain-shaped adapter over the real records.
const table = {
  get: (k) => entries.get(k),
  entries: () => entries.entries(),
  keys: () => entries.keys(),
  size: () => entries.size,
  put: async () => {},
  delete: async () => {},
  update: async () => {},
}

const routes = new Map()
const disposers = []

const ctx = {
  get: (name) => {
    if (name === 'storageDomain') {
      return {
        get: (domain) => (domain === 'session_projcache' ? { table: () => table } : undefined),
      }
    }
    if (name === 'connection') {
      return {
        fetch: {
          register: (route) => {
            if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
            routes.set(route.path, route)
            disposers.push(async () => {})
            return async () => {}
          },
        },
      }
    }
    return undefined
  },
  effect: (fn, label) => {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  logger: {
    warn: (m) => console.log('[warn]', m),
    error: (m) => console.log('[error]', m),
  },
}

const { apply, Config } = await import('./index.js')

// validate the declared config through the standard-schema entry point.
const parsedConfig = Config['~standard'].validate({
  budgetAmount: 100,
  budgetPeriod: 'month',
  defaultRange: '30d',
  refreshIntervalMs: 5000,
  topSessions: 200,
  currency: 'CNY',
})
if (parsedConfig.issues) {
  console.log('CONFIG ISSUES', parsedConfig.issues)
  process.exit(1)
}

apply(ctx, parsedConfig.value)

console.log('registered routes:', [...routes.keys()])

async function call(path, body) {
  const route = routes.get(path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const request = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const response = await route.fetch(request)
  const json = await response.json()
  return { status: response.status, json }
}

for (const range of ['24h', '7d', '14d', '30d', 'all']) {
  const { status, json } = await call('/api/dsh-usage-stats/overview', { range })
  const v = json.value
  console.log(`\n=== overview range=${range} status=${status} ok=${json.ok} ===`)
  if (!json.ok) {
    console.log(json)
    continue
  }
  console.log('sessions:', v.sessions, 'fallbackSessions:', v.fallbackSessions)
  console.log('totals:', v.totals)
  console.log('cost:', v.cost, 'currency', v.currency, 'symbol', v.symbol, 'rate', v.exchangeRate)
  console.log('budget:', v.budget)
  console.log('timeline days:', v.timeline.length, v.timeline.map((d) => `${d.date}:${d.tokens}t/$${d.costUsd.toFixed(4)}`).join(' | '))
  console.log('models:', v.models.map((m) => `${m.key}=${m.tokens}t/$${m.costUsd.toFixed(4)}${m.estimated ? '(est)' : ''}`))
  console.log('perf:', v.perf)
  console.log('estimatedModels:', v.estimatedModels)
  console.log('pricingSource:', v.pricingSource, 'priceError:', v.priceError)
}

const sess = await call('/api/dsh-usage-stats/sessions', { range: '30d', limit: 5 })
console.log('\n=== sessions status=' + sess.status + ' ok=' + sess.json.ok + ' ===')
if (sess.json.ok) {
  console.log('total sessions in range:', sess.json.value.total)
  for (const s of sess.json.value.sessions) {
    console.log(
      `- ${s.id.slice(0, 12)} tokens=${s.tokens.total} cost=$${s.costUsd.toFixed(4)}(${s.costDisplay.toFixed(4)} ${s.symbol})` +
      ` turns=${s.stats.turns} model=${s.model ? s.model.provider + ':' + s.model.model : '-'} title=${(s.title || '').slice(0, 30)}`,
    )
  }
} else {
  console.log(sess.json)
}

const cpu = await call('/api/dsh-usage-stats/cpu', {})
console.log('\n=== cpu status=' + cpu.status + ' ok=' + cpu.json.ok + ' ===')
if (cpu.json.ok) {
  console.log('current:', cpu.json.value.current)
  console.log('history points:', cpu.json.value.history.length)
} else {
  console.log(cpu.json)
}

for (const dispose of disposers) {
  try {
    dispose?.()
  } catch {
    /* ignore */
  }
}
process.exit(0)
