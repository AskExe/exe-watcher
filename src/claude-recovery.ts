import { readFile, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { getCacheDir } from './cache-dir.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { calculateCost, getShortModelName } from './models.js'
import { parseHistoryStartDate } from './history-start.js'
import type { DailyEntry } from './daily-cache.js'

export type RecoveryTokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export type ClaudeUsageSnapshot = {
  firstSessionDate: string
  lastComputedDate: string
  modelUsage: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
}
export type HistoricalRecovery = RecoveryTokens & {
  source: 'claude-stats-cache'
  throughDate: string
  costUSD: number
  models: Array<RecoveryTokens & { name: string; model: string; costUSD: number }>
  note: string
}
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
const emptyTokens = (): RecoveryTokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

/** Claude retains cumulative model counters after deleting old transcripts. Keep
 * them separate from dated usage: no fabricated calls, projects, or activity days. */
export async function readClaudeUsageSnapshot(): Promise<ClaudeUsageSnapshot | null> {
  const root = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  const path = join(root, 'stats-cache.json')
  const savedPath = join(getCacheDir(), `claude-lifetime-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`)
  const read = async (file: string): Promise<ClaudeUsageSnapshot | null> => {
    try {
      if ((await stat(file)).size > 2 * 1024 ** 2) return null
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (!data || typeof data.firstSessionDate !== 'string' || !parseHistoryStartDate(data.lastComputedDate) || !data.modelUsage || typeof data.modelUsage !== 'object') return null
      if (!Number.isFinite(new Date(data.firstSessionDate).getTime())) return null
      if (parseHistoryStartDate(data.lastComputedDate)!.getTime() > Date.now()) return null
      return data
    } catch { return null }
  }
  const current = await read(path), saved = await read(savedPath)
  if (!current) return saved
  const combined = structuredClone(current)
  if (saved) {
    combined.firstSessionDate = saved.firstSessionDate < current.firstSessionDate ? saved.firstSessionDate : current.firstSessionDate
    combined.lastComputedDate = saved.lastComputedDate > current.lastComputedDate ? saved.lastComputedDate : current.lastComputedDate
    for (const [model, counters] of Object.entries(saved.modelUsage)) {
      if (!counters || typeof counters !== 'object') continue
      const row = combined.modelUsage[model] ??= {}
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const) {
        if (Number.isFinite(counters[key]) && (counters[key] ?? 0) >= 0) row[key] = Math.max(row[key] ?? 0, counters[key] ?? 0)
      }
    }
  }
  // Preserve a cumulative floor if Claude cleans up transcripts or rebuilds its
  // own statistics cache. Reconcile at the latest checkpoint, never add snapshots.
  const payload = JSON.stringify(combined)
  if (await readFile(savedPath, 'utf8').catch(() => '') !== payload) {
    await mkdir(getCacheDir(), { recursive: true })
    const tmp = `${savedPath}.${randomUUID()}.tmp`
    try { await writeFile(tmp, payload, { mode: 0o600 }); await rename(tmp, savedPath) }
    catch { /* Recovery remains readable when persistence is unavailable. */ }
    finally { await unlink(tmp).catch(() => {}) }
  }
  return combined
}

export function sumClaudeModelTokens(days: DailyEntry[], throughDate: string): Map<string, RecoveryTokens> {
  const totals = new Map<string, RecoveryTokens>()
  for (const day of days) {
    if (day.date > throughDate) continue
    for (const [model, usage] of Object.entries(day.providers.claude?.models ?? {})) {
      const name = getShortModelName(model)
      const total = totals.get(name) ?? emptyTokens()
      for (const field of fields) total[field] += usage[field]
      totals.set(name, total)
    }
  }
  return totals
}

/** Add only the per-model/token residual missing from the detailed logs up to
 * the snapshot checkpoint. Later logs are already in the normal totals. Cache
 * TTL and fast-mode details are unavailable, so recovery is a standard-price
 * estimate using 5m writes and short-context rates. */
export function recoverClaudeUsage(snapshot: ClaudeUsageSnapshot | null, recorded: Map<string, RecoveryTokens>, rangeStart: Date): HistoricalRecovery | null {
  if (!snapshot || rangeStart > new Date(snapshot.firstSessionDate)) return null
  const models: HistoricalRecovery['models'] = []
  for (const [model, counters] of Object.entries(snapshot.modelUsage)) {
    if (!counters || typeof counters !== 'object') continue
    const saved: RecoveryTokens = {
      inputTokens: counters.inputTokens ?? 0, outputTokens: counters.outputTokens ?? 0,
      cacheReadTokens: counters.cacheReadInputTokens ?? 0, cacheWriteTokens: counters.cacheCreationInputTokens ?? 0,
    }
    if (fields.some(field => !Number.isFinite(saved[field]) || saved[field] < 0)) continue
    const name = getShortModelName(model)
    const detailed = recorded.get(name) ?? emptyTokens()
    const residual = emptyTokens()
    for (const field of fields) residual[field] = Math.max(0, saved[field] - detailed[field])
    if (fields.every(field => residual[field] === 0)) continue
    // Lifetime counters are not a single request; their aggregate size cannot
    // select a long-context tier. Missing per-request tiers remain an estimate.
    const costUSD = calculateCost(model, residual.inputTokens, residual.outputTokens, residual.cacheWriteTokens, residual.cacheReadTokens, 0, 'standard', 0)
    models.push({ model, name, ...residual, costUSD })
  }
  if (!models.length) return null
  const totals = emptyTokens()
  for (const row of models) for (const field of fields) totals[field] += row[field]
  return {
    source: 'claude-stats-cache', throughDate: snapshot.lastComputedDate, ...totals,
    costUSD: models.reduce((sum, row) => sum + row.costUSD, 0), models,
    note: 'Includes historical Claude token counters missing from retained transcripts, reconciled per model and token type to avoid double-counting. Their dates, calls, projects, request sizes, cache TTL and speed are unavailable; recovered cost uses latest standard API rates, short-context rates and 5-minute cache writes. Time-based discounts cannot be reconstructed. Earlier usage without logs or counters remains unknown.',
  }
}

export async function getClaudeRecoveryForRange(range: { start: Date; end: Date }, signal?: AbortSignal): Promise<HistoricalRecovery | null> {
  const snapshot = await readClaudeUsageSnapshot()
  if (!snapshot || range.start > new Date(snapshot.firstSessionDate)) return null
  const checkpointEnd = new Date(snapshot.lastComputedDate + 'T23:59:59.999')
  if (range.end < checkpointEnd) return null
  const { parseAllSessions } = await import('./parser.js')
  const projects = await parseAllSessions({ start: range.start, end: checkpointEnd }, 'claude', true, signal)
  const recorded = new Map<string, RecoveryTokens>()
  for (const project of projects) for (const session of project.sessions) {
    for (const [model, row] of Object.entries(session.modelBreakdown)) {
      const total = recorded.get(model) ?? emptyTokens()
      total.inputTokens += row.tokens.inputTokens; total.outputTokens += row.tokens.outputTokens
      total.cacheReadTokens += row.tokens.cacheReadInputTokens; total.cacheWriteTokens += row.tokens.cacheCreationInputTokens
      recorded.set(model, total)
    }
  }
  return recoverClaudeUsage(snapshot, recorded, range.start)
}
