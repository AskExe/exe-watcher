import { describe, expect, it } from 'vitest'
import { buildPeriodSnapshots } from '../src/period-snapshots.js'
import { DAILY_CACHE_VERSION, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { fillMissingDays } from '../src/day-aggregator.js'

const date = (value: string) => new Date(`${value}T00:00:00`)
const windows = [
  { key: 'today', start: '2026-10-14', label: 'Today' },
  { key: 'week', start: '2026-10-08', label: 'Last 7 Days' },
  { key: '30days', start: '2026-09-15', label: 'Last 30 Days' },
  { key: 'month', start: '2026-10-01', label: 'October' },
  { key: 'all', start: '2026-07-01', label: 'All Time' },
]
function live(cost: number): DailyEntry {
  const day = fillMissingDays(date('2026-10-14'), date('2026-10-14'), [])[0]!
  return { ...day, cost, calls: 1, inputTokens: 100,
    providers: { claude: { ...day, calls: 1, cost, inputTokens: 100 } } }
}
function fixture(): DailyCache {
  const days = fillMissingDays(date('2026-07-01'), date('2026-10-13'), [])
  for (const [key, cost] of [['2026-10-01', 7], ['2026-10-13', 10]] as const) {
    const d = days.find(d => d.date === key)!; d.cost = cost
    d.providers.claude = { ...live(cost).providers.claude! }
  }
  return { version: DAILY_CACHE_VERSION, scopeKey: 'global', lastComputedDate: '2026-10-13', days, revalidatedAt: 12345 }
}
const build = (cache: DailyCache, cost = 2, provider = 'all') => buildPeriodSnapshots(
  cache, [live(cost)], '2026-10-14', windows, provider, new Map([['claude', 'Claude']]), null, 1, [],
)
describe('period snapshots', () => {
  it('rolls up every covered window from one daily parse and replaces today', () => {
    const cache = fixture(); cache.days.push(live(99))
    const snapshots = build(cache)
    expect(Object.keys(snapshots)).toHaveLength(5)
    expect(snapshots.today!.current.cost).toBe(2)
    expect(snapshots.week!.current.cost).toBe(12)
    expect(snapshots.month!.current.cost).toBe(19)
    expect(snapshots.all!.current.cost).toBe(19)
    expect(build(cache, 3).all!.current.cost).toBe(20)
    expect(cache.days.at(-1)!.cost).toBe(99)
    expect(snapshots.all!.historyValidatedAt).toBe(12345)
  })
  it('does not claim missing or incomplete dates are complete totals', () => {
    const cache = fixture(); cache.days = cache.days.filter(d => d.date !== '2026-10-13')
    expect(Object.keys(build(cache))).toEqual(['today'])
    const partial = fixture(); partial.partialDates = ['2026-10-13']
    expect(Object.keys(build(partial))).toEqual(['today'])
    const repricing = fixture(); repricing.needsRepricing = true
    expect(Object.keys(build(repricing))).toEqual(['today'])
    const missingProvider = fixture(); missingProvider.missingProviders = ['kimi']
    expect(Object.keys(build(missingProvider))).toEqual(['today'])
  })
  it('uses the same provider buckets for aggregates and filtered views', () => {
    const cache = fixture()
    expect(build(cache).all!.current.providers.claude).toBe(build(cache, 2, 'claude').all!.current.cost)
    expect(build(cache, 2, 'codex').all!.current.cost).toBe(0)
  })
  it('keeps unpriced-model warnings when usage comes only from cached closed days', () => {
    const cache = fixture()
    cache.days[0]!.models['kimi-for-coding'] = { calls: 1, cost: 0, inputTokens: 100,
      outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(build(cache).all!.diagnostics!.warnings.some(w => w.includes('kimi-for-coding') && w.includes('tokens are counted'))).toBe(true)
  })
  it('adds undated lifetime recovery only to All Time without inventing calls', () => {
    const tokens = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const recovery = { ...tokens, source: 'claude-stats-cache' as const, throughDate: '2026-10-01', costUSD: 5,
      models: [{ ...tokens, name: 'sonnet', model: 'sonnet', costUSD: 5 }], note: 'Recovered retained usage' }
    const snapshots = buildPeriodSnapshots(fixture(), [live(2)], '2026-10-14', windows, 'all', new Map([['claude', 'Claude']]), recovery, 1, [])
    expect(snapshots.all!.current.cost).toBe(24)
    expect(snapshots.all!.current.providers.claude).toBe(24)
    expect(snapshots.all!.current.calls).toBe(build(fixture()).all!.current.calls)
    expect(snapshots.all!.current.callsIncomplete).toBe(true)
    expect(snapshots.all!.current.topModels.find(m => m.name === 'sonnet')).toMatchObject({ calls: 0, callsIncomplete: true })
    expect(snapshots.month!.current.cost).toBe(19)
    expect(snapshots.month!.current.callsIncomplete).toBe(false)
    expect(snapshots.all!.diagnostics!.warnings).toEqual([recovery.note])
  })

  it('keeps recovery coverage in cached All Time and Claude snapshots, excluding other providers', () => {
    const tokens = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const recovery = { ...tokens, source: 'claude-stats-cache' as const, throughDate: '2026-10-01', costUSD: 5,
      models: [{ ...tokens, name: 'Opus 4.6', model: 'claude-opus-4-6', costUSD: 5 }], note: 'Recovered retained usage' }
    const cache = fixture()
    const day = cache.days.at(-1)!
    day.models['Opus 4.6'] = { ...tokens, calls: 18, cost: 1 }
    day.providers.claude!.models = structuredClone(day.models)
    for (const provider of ['all', 'claude', 'codex']) {
      const snapshots = buildPeriodSnapshots(cache, [live(2)], '2026-10-14', windows, provider,
        new Map([['claude', 'Claude']]), recovery, 1, [])
      const persisted = JSON.parse(JSON.stringify(snapshots)) as typeof snapshots
      expect(persisted.all!.current.callsIncomplete).toBe(provider !== 'codex')
      if (provider !== 'codex') {
        expect(persisted.all!.current.topModels).toEqual([{ name: 'Opus 4.6', cost: 6, calls: 18, callsIncomplete: true }])
      }
      expect(persisted.today!.current.callsIncomplete).toBe(false)
    }
  })
})
