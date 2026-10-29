import { CloudError } from './error.js'
import type { DailyCache } from '../daily-cache.js'
import type { TimeReport } from '../time-tracking.js'

export const PROVIDERS = ['claude', 'codex', 'cursor', 'cursor-agent', 'copilot', 'opencode', 'kimi', 'pi', 'omp'] as const
export const MAX_SNAPSHOT_SIZE = 8 * 1024 * 1024
export type CloudDay = {
  date: string
  provider: string
  apiEquivalentUSD: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
export type WatcherSnapshot = {
  format: 'watcher-history-v1'
  deviceId: string
  capturedAt: string
  timezone: string
  costBasis: 'recorded-api-equivalent-not-invoices'
  days: CloudDay[]
  timing: {
    since: string
    through: string
    aiRunningMs: number | null
    elapsedBusyMs: number | null
    estimatedAiMs: number
    coverage: 'partial' | 'missing'
  } | null
  partialDates: string[]
  missingProviders: string[]
}
export const isUUID = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const amount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
function exact(v: unknown, keys: string): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',')
}
function invalid(): never { throw new CloudError('Invalid Watcher history; existing local data was preserved.') }

/** Strict allowlist on both capture and restore: no paths, prompts, account data or arbitrary labels. */
export function decodeSnapshot(bytes: Uint8Array): WatcherSnapshot {
  if (!bytes.length || bytes.length > MAX_SNAPSHOT_SIZE) invalid()
  const x = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!exact(x, 'format,deviceId,capturedAt,timezone,costBasis,days,timing,partialDates,missingProviders') ||
      x.format !== 'watcher-history-v1' || !isUUID(x.deviceId) || !instant(x.capturedAt) ||
      x.costBasis !== 'recorded-api-equivalent-not-invoices' || typeof x.timezone !== 'string' || x.timezone.length > 80 ||
      !Array.isArray(x.days) || x.days.length > 40_000 || !Array.isArray(x.partialDates) || !x.partialDates.every(date) ||
      !Array.isArray(x.missingProviders) || !x.missingProviders.every(p => PROVIDERS.includes(p))) invalid()
  try { new Intl.DateTimeFormat('en', { timeZone: x.timezone }).format() } catch { invalid() }
  const seen = new Set<string>()
  for (const d of x.days) {
    if (!exact(d, 'date,provider,apiEquivalentUSD,calls,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens') ||
        !date(d.date) || !PROVIDERS.includes(d.provider as typeof PROVIDERS[number]) || !amount(d.apiEquivalentUSD) ||
        !['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(k => count(d[k])) ||
        seen.has(`${d.date}:${d.provider}`)) invalid()
    seen.add(`${d.date}:${d.provider}`)
  }
  if (x.timing !== null) {
    const t = x.timing
    if (!exact(t, 'since,through,aiRunningMs,elapsedBusyMs,estimatedAiMs,coverage') ||
        !instant(t.since) || !instant(t.through) || t.since > t.through ||
        ![t.aiRunningMs, t.elapsedBusyMs].every(v => v === null || amount(v)) || !amount(t.estimatedAiMs) ||
        !['partial', 'missing'].includes(t.coverage as string)) invalid()
  }
  return x as unknown as WatcherSnapshot
}

export function captureSnapshot(cache: DailyCache, deviceId: string, time: TimeReport | null, now = new Date()): WatcherSnapshot {
  if (cache.scopeKey !== 'global' || cache.days.length === 0) throw new CloudError('No saved global history yet. Refresh Watcher before backing up.')
  const days: CloudDay[] = []
  for (const day of cache.days) for (const provider of PROVIDERS) {
    const p = day.providers[provider]
    if (p) days.push({ date: day.date, provider, apiEquivalentUSD: p.cost, calls: p.calls,
      inputTokens: p.inputTokens, outputTokens: p.outputTokens, cacheReadTokens: p.cacheReadTokens, cacheWriteTokens: p.cacheWriteTokens })
  }
  const snapshot: WatcherSnapshot = {
    format: 'watcher-history-v1', deviceId, capturedAt: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, costBasis: 'recorded-api-equivalent-not-invoices', days,
    timing: time ? { since: time.since, through: time.through, aiRunningMs: time.aiRunningMs,
      elapsedBusyMs: time.elapsedBusyMs, estimatedAiMs: time.estimatedAiMs, coverage: time.coverage } : null,
    partialDates: [...new Set(cache.partialDates ?? [])], missingProviders: (cache.missingProviders ?? []).filter(p => PROVIDERS.includes(p as typeof PROVIDERS[number])),
  }
  return decodeSnapshot(new TextEncoder().encode(JSON.stringify(snapshot)))
}

export function summarizeSnapshot(snapshot: WatcherSnapshot, month?: string) {
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new CloudError('Use a YYYY-MM month.')
  const days = snapshot.days.filter(d => !month || d.date.startsWith(month))
  const providerTotals = PROVIDERS.map(provider => ({ provider, apiEquivalentUSD: days.filter(d => d.provider === provider).reduce((n, d) => n + d.apiEquivalentUSD, 0) })).filter(p => p.apiEquivalentUSD > 0)
  return { deviceId: snapshot.deviceId, capturedAt: snapshot.capturedAt, month: month ?? null,
    apiEquivalentUSD: days.reduce((n, d) => n + d.apiEquivalentUSD, 0), calls: days.reduce((n, d) => n + d.calls, 0),
    providers: providerTotals, timing: month ? null : snapshot.timing,
    partial: snapshot.partialDates.length > 0 || snapshot.missingProviders.length > 0,
    costBasis: snapshot.costBasis }
}

/** A cleared/rebuilding local cache must not erase older backed-up accounting. */
export function mergeSnapshotHistory(previous: WatcherSnapshot, current: WatcherSnapshot): WatcherSnapshot {
  if (previous.deviceId !== current.deviceId) throw new CloudError('History belongs to a different device.')
  const rows = new Map(previous.days.map(row => [`${row.date}:${row.provider}`, row]))
  for (const row of current.days) {
    const old = rows.get(`${row.date}:${row.provider}`)
    if (old && ['apiEquivalentUSD', 'calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(field =>
      row[field as keyof CloudDay] < old[field as keyof CloudDay])) {
      throw new CloudError('Local accounting is still rebuilding or differs from your backup. Your completed cloud history was preserved; refresh Watcher before retrying.')
    }
    rows.set(`${row.date}:${row.provider}`, row)
  }
  const days = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider))
  const currentDates = new Set(current.days.map(row => row.date))
  const result = { ...current, days, timing: current.timing ?? previous.timing,
    partialDates: [...new Set([...previous.partialDates.filter(d => !currentDates.has(d)), ...current.partialDates])],
    missingProviders: [...new Set([...previous.missingProviders, ...current.missingProviders])] }
  return decodeSnapshot(new TextEncoder().encode(JSON.stringify(result)))
}
