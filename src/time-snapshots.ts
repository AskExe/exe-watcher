import { summarizeTime, type TimeIndex, type TimeReport, type TimeRecoveryProgress } from './time-tracking.js'
import type { DateRange } from './types.js'

export type TimeSnapshots = {
  generated: string; provider: string; periods: Record<string, TimeReport>
  allPeriods?: Record<string, TimeReport>; recovery: TimeRecoveryProgress
}

/** One index pass, timing views only. Never reparse costs or refresh financial timestamps. */
export function buildTimeSnapshots(index: TimeIndex, ranges: Record<string, DateRange>, provider = 'all', include?: string[], exclude?: string[]): TimeSnapshots {
  const views = (scope: string) => Object.fromEntries(Object.entries(ranges).map(([key, range]) => [key, summarizeTime(index, range, scope, include, exclude)]))
  const periods = views(provider), allPeriods = provider === 'all' ? undefined : views('all')
  return { generated: new Date().toISOString(), provider, periods, allPeriods, recovery: (allPeriods ?? periods)['all']!.recovery }
}
