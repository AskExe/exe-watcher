import type { DailyCache, DailyEntry } from './daily-cache.js'
import { addNewDays } from './daily-cache.js'
import { fillMissingDays } from './day-aggregator.js'
import { mergeCounters } from './report-summary.js'
import { ResourceBudgetError } from './resource-budget.js'
import { nextBackfillCursor, shouldSkipBlockedChunk } from './progressive-backfill.js'

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const date = (s: string) => new Date(`${s}T00:00:00`)

/** Persist completed providers (or days for an oversized provider) before
 * continuing. A CLI timeout can only lose its current scan, not the rebuild.
 * Staging remains separate from committed days until all providers finish.
 */
export async function completeHistoryBuild(
  cache: DailyCache, start: Date, end: Date, providers: string[],
  scan: (provider: string, start: Date, end: Date) => Promise<DailyEntry[]>,
  save: (cache: DailyCache) => Promise<void>,
): Promise<DailyCache> {
  const stage = cache.historyBuild ? structuredClone(cache.historyBuild) : { start: key(start), end: key(end), completedProviders: [], days: [] }
  let current: DailyCache = { ...cache, historyBuild: stage }
  const first = date(stage.start)
  const last = date(stage.end); last.setHours(23, 59, 59, 999)
  const merge = (incoming: DailyEntry[]) => {
    const byDate = new Map(stage.days.map(d => [d.date, d]))
    for (const row of incoming) {
      if (row.date < stage.start || row.date > stage.end) continue
      const previous = byDate.get(row.date)
      if (previous) mergeCounters(previous, row)
      else byDate.set(row.date, structuredClone(row))
    }
    stage.days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  }
  for (const provider of providers) {
    if (stage.completedProviders.includes(provider)) continue
    if (!stage.chunked) {
      try {
        merge(await scan(provider, first, last))
        stage.completedProviders.push(provider)
        await save(current)
        continue
      } catch (err) {
        if (!(err instanceof ResourceBudgetError)) throw err
        stage.chunked = { provider, nextDate: stage.start }
        await save(current)
      }
    }
    // Fall back only for the oversized provider, preserving other providers.
    if (stage.chunked.provider !== provider) throw new Error('Historical provider cursor mismatch')
    for (let day = date(stage.chunked.nextDate); day <= last;) {
      const next = new Date(day); next.setDate(next.getDate() + 1)
      const dayEnd = new Date(next.getTime() - 1)
      const dayKey = key(day)
      if (shouldSkipBlockedChunk(current.backfill, dayKey)) {
        stage.partialDates = [...new Set([...(stage.partialDates ?? []), dayKey])]
      } else {
        try {
          const incoming = await scan(provider, day, dayEnd)
          merge(incoming.filter(row => row.date === dayKey))
        } catch (err) {
          if (!(err instanceof ResourceBudgetError)) throw err
          current.backfill = nextBackfillCursor(current.backfill, dayKey)
          await save(current)
          return current
        }
      }
      current.backfill = null
      stage.chunked.nextDate = key(next)
      await save(current)
      day = next
    }
    delete stage.chunked
    stage.completedProviders.push(provider)
    await save(current)
  }
  const rebuilt = fillMissingDays(first, last, stage.days)
  current = {
    ...current, ...addNewDays(current, rebuilt, stage.end, { coveredThrough: stage.end }),
    historyBuild: undefined, revalidatedAt: Date.now(),
    partialDates: [...new Set([...(cache.partialDates ?? []).filter(d => d < stage.start || d > stage.end), ...(stage.partialDates ?? [])])],
    backfill: null,
  }
  // A suspended build may span a day rollover. Only clear repricing after
  // its original range is committed; the caller then fills the new-day gap.
  if (cache.needsRepricing) {
    delete current.needsRepricing
    delete current.previousHistoryStart
  }
  await save(current)
  return current
}
