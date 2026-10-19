import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getCacheDir } from './cache-dir.js'
import { getModelCosts } from './models.js'
import { chargeRead } from './resource-budget.js'
import { getSqliteLoadError, isSqliteAvailable } from './sqlite.js'

const require = createRequire(import.meta.url)
const BATCH = 128
let opened: { path: string; db: DatabaseSync } | undefined

function database(): DatabaseSync {
  const directory = getCacheDir()
  const path = join(directory, 'recorded-costs.sqlite')
  if (opened?.path === path && existsSync(path)) return opened.db
  opened?.db.close(); opened = undefined
  if (!isSqliteAvailable()) throw new Error(getSqliteLoadError())
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('Watcher pricing ledger must be a regular file')
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(path)
  chmodSync(path, 0o600)
  // One MiB of SQLite page cache, bounded lock waits and a 512 MiB data ceiling.
  // Only hashes and dollar amounts are retained; no prompts or conversation bodies.
  db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-1024; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
  const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size)
  db.exec(`PRAGMA max_page_count=${Math.floor(512 * 1024 * 1024 / pageSize)}`)
  db.exec('CREATE TABLE IF NOT EXISTS costs (id BLOB PRIMARY KEY, usd REAL NOT NULL CHECK(usd >= 0)) WITHOUT ROWID')
  opened = { path, db }
  return db
}

type CostRow = { record: Record<string, unknown>; id: Buffer }
function costRow(value: unknown): CostRow | 'unpriced' | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const { provider, model, deduplicationKey, costUSD } = record
  if (typeof provider !== 'string' || typeof model !== 'string' || typeof deduplicationKey !== 'string' || !deduplicationKey ||
      typeof costUSD !== 'number' || !Number.isFinite(costUSD) || costUSD < 0) return null
  // An unpriced model has an unknown cost, not a final zero-dollar price.
  if (costUSD === 0 && !getModelCosts(model)) return 'unpriced'
  const usage = (record.usage ?? record) as Record<string, unknown>
  const fields = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'cacheCreation1hInputTokens', 'webSearchRequests']
  const tokens = fields.map(field => usage[field] ?? 0)
  if (!tokens.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null
  // Updated accounting (more tokens, a different model or speed) is new data.
  // A pricing feed change alone can never change this identity.
  const id = createHash('sha256').update(JSON.stringify([provider, deduplicationKey, model, record.speed ?? 'standard', ...tokens])).digest()
  return { record, id }
}

/** Fix the first observed cost of each billable usage record, independently of
 * temporary parsed-file eviction, appends, copies and later pricing refreshes.
 * Stable parsed files bypass this ledger entirely after their first locking pass.
 */
export function lockRecordedCosts(data: unknown[]): boolean {
  let db: DatabaseSync | undefined
  let batch: CostRow[] = []
  let hasUnpricedUsage = false
  const flush = () => {
    if (!batch.length) return
    chargeRead(0) // Honour the enclosing scan's deadline, cancellation and heap guard.
    db ??= database()
    const placeholders = batch.map(() => '?').join(',')
    const query = db.prepare(`SELECT id, usd FROM costs WHERE id IN (${placeholders})`)
    const read = () => new Map(query.all(...batch.map(row => row.id)).map(row => {
      const cost = Number(row.usd)
      if (!Number.isFinite(cost) || cost < 0) throw new Error('Watcher pricing ledger contains an invalid recorded cost')
      return [Buffer.from(row.id as Uint8Array).toString('hex'), cost] as const
    }))
    let known = read()
    const missing = batch.filter(row => !known.has(row.id.toString('hex')))
    if (missing.length) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT OR IGNORE INTO costs (id, usd) VALUES (?, ?)')
        for (const row of missing) insert.run(row.id, row.record.costUSD as number)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      // If another process won the insertion, its already-recorded price wins.
      known = read()
    }
    chargeRead(known.size * 40)
    for (const row of batch) row.record.costUSD = known.get(row.id.toString('hex'))!
    batch = []
  }
  const add = (value: unknown) => {
    const row = costRow(value)
    if (row === 'unpriced') hasUnpricedUsage = true
    else if (row) batch.push(row)
    if (batch.length === BATCH) flush()
  }
  for (const entry of data) {
    if (entry && typeof entry === 'object' && Array.isArray((entry as { assistantCalls?: unknown }).assistantCalls)) {
      for (const call of (entry as { assistantCalls: unknown[] }).assistantCalls) add(call)
    } else add(entry)
  }
  flush()
  return hasUnpricedUsage
}
