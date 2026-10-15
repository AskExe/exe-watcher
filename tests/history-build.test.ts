import { expect, it } from 'vitest'
import { completeHistoryBuild } from '../src/history-build.js'
import { DAILY_CACHE_VERSION, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { fillMissingDays } from '../src/day-aggregator.js'
import { ResourceBudgetError } from '../src/resource-budget.js'

const first = new Date(2026, 9, 1)
const last = new Date(2026, 9, 2, 23, 59, 59, 999)
function row(day: Date, cost: number, provider: string): DailyEntry {
  const entry = fillMissingDays(day, day, [])[0]!
  return { ...entry, cost, calls: 1, providers: { [provider]: { ...entry, calls: 1, cost } } }
}
it('resumes a timed-out provider build without rescanning completed providers or exposing partial prices', async () => {
  const original: DailyCache = { version: DAILY_CACHE_VERSION, scopeKey: 'global', days: [], lastComputedDate: null, needsRepricing: true }
  let saved = structuredClone(original)
  const save = async (c: DailyCache) => { saved = structuredClone(c) }
  let failed = false
  await expect(completeHistoryBuild(original, first, last, ['claude', 'codex'], async provider => {
    if (provider === 'claude') return [row(first, 5, provider)]
    if (!failed) { failed = true; throw new ResourceBudgetError('fixture') }
    throw new Error('process terminated')
  }, save)).rejects.toThrow('process terminated')
  expect(saved.days).toEqual([])
  expect(saved.needsRepricing).toBe(true)
  expect(saved.historyBuild!.completedProviders).toEqual(['claude'])
  const calls: string[] = []
  const complete = await completeHistoryBuild(saved, first, last, ['claude', 'codex'], async (provider, from) => {
    calls.push(provider); return [row(from, 2, provider)]
  }, save)
  expect(calls).toEqual(['codex', 'codex'])
  expect(complete.days.map(d => d.cost)).toEqual([7, 2])
  expect(complete.days[0]!.providers.claude!.cost).toBe(5)
  expect(complete.historyBuild).toBeUndefined()
  expect(complete.needsRepricing).toBeUndefined()
  expect(complete.lastComputedDate).toBe('2026-10-02')
  expect(original.days).toEqual([])
})
it('commits changed days by replacement rather than adding them twice', async () => {
  const cache: DailyCache = { version: DAILY_CACHE_VERSION, scopeKey: 'global', days: [row(first, 99, 'claude')], lastComputedDate: '2026-10-01' }
  const complete = await completeHistoryBuild(cache, first, first, ['claude'], async () => [row(first, 4, 'claude')], async () => {})
  expect(complete.days[0]!.cost).toBe(4)
  expect(cache.days[0]!.cost).toBe(99)
})
