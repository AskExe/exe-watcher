import type { DailyCache, DailyEntry } from './daily-cache.js'
import { applyClaudeRecovery, type HistoricalRecovery } from './claude-recovery.js'
import { buildPeriodDataFromDays, filterDaysToProvider } from './day-aggregator.js'
import { buildMenubarPayload, buildProjectSpendFromDays, type MenubarPayload } from './menubar-json.js'
import { getModelCosts } from './models.js'
import type { TimeReport } from './time-tracking.js'
import { createHash } from 'node:crypto'

export type PeriodSnapshot = {
  savedHistory?: { through: string; message: string; progressToken?: string }
  time?: TimeReport
  current: MenubarPayload['current']
  projectSpend: MenubarPayload['projectSpend']
  diagnostics: MenubarPayload['diagnostics']
  historyValidatedAt: number
}
export type SnapshotWindow = { key: string; start: string; label: string }

export function hasRecordedHistory(cache: DailyCache, today: string): boolean {
  return cache.days.some(day => day.date < today && (day.cost > 0 || day.calls > 0 || day.inputTokens > 0 || day.outputTokens > 0))
}

/** A staged provider scan is not a complete replacement for committed history. */
export function assertHistoryComplete(cache: DailyCache, start: string, today: string): void {
  if (start >= today) return
  const required = Math.round((Date.parse(today) - Date.parse(start)) / 86_400_000)
  const dates = new Set(cache.days.filter(d => d.date >= start && d.date < today).map(d => d.date))
  if (cache.needsRepricing || cache.historyBuild || cache.missingProviders?.length ||
      cache.partialDates?.some(d => d >= start && d < today) || dates.size !== required) {
    throw new Error('Historical usage is incomplete. The history rebuild has saved its progress; keeping the last successful total. Refresh again to resume.')
  }
}

/** Roll up cached closed days and replace today's bucket with its fresh parse.
 * Missing/partial dates never become apparently complete historical totals.
 */
export function buildPeriodSnapshots(
  cache: DailyCache, todayDays: DailyEntry[], today: string,
  windows: SnapshotWindow[], provider: string, names: Map<string, string>,
  recovery: HistoricalRecovery | null, parseTimeMs: number, warnings: string[],
): Record<string, PeriodSnapshot> {
  const closed = cache.days.filter(d => d.date < today)
  const live = todayDays.filter(d => d.date === today)
  const dates = new Set(closed.map(d => d.date))
  const partial = new Set(cache.partialDates ?? [])
  const days = [...closed, ...live].sort((a, b) => a.date.localeCompare(b.date))
  const periodDays = (start: string) => days.filter(d => d.date >= start)
  const week = windows.find(w => w.key === 'week')!
  const month = windows.find(w => w.key === '30days')!
  const result: Record<string, PeriodSnapshot> = {}
  for (const window of windows) {
    const required = Math.max(0, Math.round((Date.parse(today) - Date.parse(window.start)) / 86_400_000))
    const covered = [...dates].filter(d => d >= window.start && !partial.has(d)).length
    const incomplete = window.key !== 'today' && (cache.needsRepricing || cache.historyBuild || cache.missingProviders?.length || covered !== required)
    // An All view can show committed amounts while newer dates are recovered.
    // Never manufacture a historical total from today's usage alone.
    const committed = closed.filter(day => day.date >= window.start).sort((a, b) => a.date.localeCompare(b.date))
    const savedHistory = incomplete && window.key === 'all' && committed.some(day => day.cost > 0 || day.calls > 0 || day.inputTokens > 0 || day.outputTokens > 0)
      ? { through: committed.at(-1)!.date,
        progressToken: createHash('sha256').update(JSON.stringify([cache.lastComputedDate, cache.days.length,
          cache.historyBuild?.completedProviders, cache.historyBuild?.chunked, cache.missingProviders, cache.partialDates])).digest('hex'),
        message: `Saved history through ${committed.at(-1)!.date}${live.length ? ', plus today' : ''}. Some history is still missing; this is not the complete All total.` }
      : undefined
    if (incomplete && !savedHistory) continue
    const selected = periodDays(window.start)
    const scoped = provider === 'all' ? selected : filterDaysToProvider(selected, provider)
    const data = buildPeriodDataFromDays(scoped, window.label)
    const totals: Record<string, number> = {}
    for (const day of scoped) for (const [name, usage] of Object.entries(day.providers)) {
      totals[name] = (totals[name] ?? 0) + usage.cost
    }
    const notes = [...warnings]
    for (const model of data.models) {
      if (getModelCosts(model.name)) continue
      const note = `No API pricing for model "${model.name}"; its tokens are counted but its cost is excluded. Configure a model alias only when the underlying API model is known.`
      if (!notes.includes(note)) notes.push(note)
    }
    if (window.key === 'all' && recovery && (provider === 'all' || provider === 'claude')) {
      applyClaudeRecovery(data, recovery)
      totals.claude = (totals.claude ?? 0) + recovery.costUSD
      if (!notes.includes(recovery.note)) notes.push(recovery.note)
    }
    const providers = provider === 'all'
      ? Object.entries(totals).map(([name, cost]) => ({ name: names.get(name) ?? name, cost }))
      : [{ name: names.get(provider) ?? provider, cost: data.cost }]
    const built = buildMenubarPayload(data, providers, null)
    result[window.key] = {
      ...(savedHistory ? { savedHistory } : {}),
      current: built.current,
      projectSpend: buildProjectSpendFromDays(selected, live, periodDays(week.start), periodDays(month.start)),
      diagnostics: { daysCount: selected.length, parseTimeMs, warnings: notes },
      // Do not perpetually freshen historical validation with every daily update.
      historyValidatedAt: cache.revalidatedAt ?? 0,
    }
  }
  return result
}
