import type { DailyCache } from './daily-cache.js'
import { buildPeriodDataFromDays, filterDaysToProvider } from './day-aggregator.js'
import { buildMenubarPayload } from './menubar-json.js'
import { hasRecordedHistory } from './period-snapshots.js'

/** Immediate, offline recovery of committed amounts. No session discovery,
 * pricing requests, usage parsing, timing indexing, or cache writes. */
export function buildSavedHistory(cache: DailyCache, today: string, provider: string, window = { start: '0000-01-01', label: 'All Time' }) {
  if (!hasRecordedHistory(cache, today)) throw new Error('No saved history yet. Watcher is recovering local usage.')
  const closed = cache.days.filter(day => day.date >= window.start && day.date < today).sort((a, b) => a.date.localeCompare(b.date))
  if (!closed.some(day => day.cost > 0 || day.calls > 0 || day.inputTokens > 0 || day.outputTokens > 0)) throw new Error('No saved usage in this period yet. Watcher is recovering local usage.')
  const days = provider === 'all' ? closed : filterDaysToProvider(closed, provider)
  const current = buildPeriodDataFromDays(days, window.label)
  const totals = new Map<string, number>()
  for (const day of days) for (const [name, data] of Object.entries(day.providers)) totals.set(name, (totals.get(name) ?? 0) + data.cost)
  const payload = buildMenubarPayload(current, [...totals].map(([name, cost]) => ({ name, cost })), null)
  return { ...payload, savedHistory: { through: closed.at(-1)!.date,
    message: `Saved ${window.label} history through ${closed.at(-1)!.date}. Newer usage has not loaded yet.` } }
}
