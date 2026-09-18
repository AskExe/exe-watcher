import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { join } from 'path'

import { getCacheDir } from './cache-dir.js'
import type { BackfillCursor } from './progressive-backfill.js'

// v6: Codex pricing fixes (no reasoning double-count; long-context tiers use full prompt
// input including cached tokens). Bump to evict historical day rows computed with v5 math so
// report/CLI/menubar-json do not disagree across cached vs freshly parsed periods.
export const DAILY_CACHE_VERSION = 6
export const DEFAULT_DAILY_CACHE_SCOPE = 'global'
const DAILY_CACHE_FILENAME = 'daily-cache.json'

export type DailyModelTotals = {
  calls: number
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type DailyCategoryTotals = {
  turns: number
  cost: number
  editTurns: number
  oneShotTurns: number
}

export type ProviderDailyBreakdown = {
  calls: number
  cost: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  editTurns: number
  oneShotTurns: number
  models: Record<string, DailyModelTotals>
  categories: Record<string, DailyCategoryTotals>
}

export type DailyEntry = {
  date: string
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  editTurns: number
  oneShotTurns: number
  models: Record<string, DailyModelTotals>
  categories: Record<string, DailyCategoryTotals>
  providers: Record<string, ProviderDailyBreakdown>
  projects: Record<string, { cost: number; sessions: number }>
}

export type DailyCache = {
  version: number
  scopeKey: string
  lastComputedDate: string | null
  days: DailyEntry[]
  revalidatedAt?: number
  /** Slice the last run aborted on, so the next run resumes there instead of restarting. */
  backfill?: BackfillCursor | null
  /** Days recorded without a complete scan because they exhausted their retries. */
  partialDates?: string[]
}

type AddNewDaysOptions = {
  coveredThrough?: string | null
}

function getCachePath(scopeKey: string): string {
  if (scopeKey === DEFAULT_DAILY_CACHE_SCOPE) {
    return join(getCacheDir(), DAILY_CACHE_FILENAME)
  }
  return join(getCacheDir(), `daily-cache-${scopeKey}.json`)
}

function emptyCache(scopeKey: string): DailyCache {
  return { version: DAILY_CACHE_VERSION, scopeKey, lastComputedDate: null, days: [] }
}

function normalizeScopeTerms(values?: string[]): string[] {
  return [...new Set((values ?? []).map(value => value.trim().toLowerCase()).filter(Boolean))].sort()
}

export function buildDailyCacheScopeKey(include?: string[], exclude?: string[]): string {
  const normalizedInclude = normalizeScopeTerms(include)
  const normalizedExclude = normalizeScopeTerms(exclude)
  if (normalizedInclude.length === 0 && normalizedExclude.length === 0) {
    return DEFAULT_DAILY_CACHE_SCOPE
  }
  const raw = JSON.stringify({ include: normalizedInclude, exclude: normalizedExclude })
  return `scope-${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`
}

function isValidCache(parsed: unknown): parsed is DailyCache {
  if (!parsed || typeof parsed !== 'object') return false
  const c = parsed as Partial<DailyCache>
  if (c.version !== DAILY_CACHE_VERSION) return false
  if (typeof c.scopeKey !== 'string' || c.scopeKey.length === 0) return false
  if (!Array.isArray(c.days)) return false
  return true
}

export async function loadDailyCache(scopeKey = DEFAULT_DAILY_CACHE_SCOPE): Promise<DailyCache> {
  const path = getCachePath(scopeKey)
  if (!existsSync(path)) return emptyCache(scopeKey)
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidCache(parsed)) return emptyCache(scopeKey)
    if (parsed.scopeKey !== scopeKey) return emptyCache(scopeKey)
    return parsed
  } catch {
    return emptyCache(scopeKey)
  }
}

export async function saveDailyCache(cache: DailyCache): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const scopeKey = cache.scopeKey || DEFAULT_DAILY_CACHE_SCOPE
  const finalPath = getCachePath(scopeKey)
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify({ ...cache, scopeKey })
  if (await readFile(finalPath, 'utf8').catch(() => '') === payload) return
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, finalPath)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* ignore */ }
    throw err
  }
}

export function addNewDays(
  cache: DailyCache,
  incoming: DailyEntry[],
  newestDate: string,
  options: AddNewDaysOptions = {},
): DailyCache {
  const byDate = new Map(cache.days.map(d => [d.date, d]))
  for (const day of incoming) {
    byDate.set(day.date, day)
  }
  const merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  const candidateLast = options.coveredThrough ?? newestDate
  const nextLast = cache.lastComputedDate && cache.lastComputedDate > candidateLast
    ? cache.lastComputedDate
    : candidateLast
  return {
    version: DAILY_CACHE_VERSION,
    scopeKey: cache.scopeKey || DEFAULT_DAILY_CACHE_SCOPE,
    lastComputedDate: nextLast,
    days: merged,
    revalidatedAt: cache.revalidatedAt,
    backfill: cache.backfill,
    partialDates: cache.partialDates,
  }
}

export function getDaysInRange(cache: DailyCache, start: string, end: string): DailyEntry[] {
  return cache.days.filter(d => d.date >= start && d.date <= end)
}

let lockChain: Promise<unknown> = Promise.resolve()

export function withDailyCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(() => fn())
  lockChain = next.catch(() => undefined)
  return next
}
