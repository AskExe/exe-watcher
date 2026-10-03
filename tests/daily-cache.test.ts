import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getPricingFingerprint, setModelAliases } from '../src/models.js'

import {
  addNewDays,
  buildDailyCacheScopeKey,
  DAILY_CACHE_VERSION,
  DEFAULT_DAILY_CACHE_SCOPE,
  type DailyCache,
  type DailyEntry,
  getDaysInRange,
  loadDailyCache,
  saveDailyCache,
  withDailyCacheLock,
} from '../src/daily-cache.js'

function emptyDay(date: string, cost = 0, calls = 0): DailyEntry {
  return {
    date,
    cost,
    calls,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
  }
}

const TMP_CACHE_ROOT = join(tmpdir(), `exe-watcher-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(() => {
  process.env['EXE_WATCHER_CACHE_DIR'] = TMP_CACHE_ROOT
})

afterEach(async () => {
  setModelAliases({})
  delete process.env['EXE_WATCHER_CACHE_DIR']
  if (existsSync(TMP_CACHE_ROOT)) {
    await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
  }
})

describe('loadDailyCache', () => {
  it('invalidates stored history when effective model pricing changes', async () => {
    await saveDailyCache({ version: DAILY_CACHE_VERSION, scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-10', days: [emptyDay('2026-04-10', 10)] })
    expect((await loadDailyCache()).days).toHaveLength(1)
    setModelAliases({ 'custom-model': 'gpt-6-astra' })
    expect((await loadDailyCache()).days).toEqual([])
  })
  it('returns an empty cache when the file does not exist', async () => {
    const cache = await loadDailyCache()
    expect(cache.version).toBe(DAILY_CACHE_VERSION)
    expect(cache.scopeKey).toBe(DEFAULT_DAILY_CACHE_SCOPE)
    expect(cache.lastComputedDate).toBeNull()
    expect(cache.days).toEqual([])
  })

  it('returns an empty cache when the file contains invalid JSON', async () => {
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), 'not valid json{{', 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toEqual([])
  })

  it('returns an empty cache when the version does not match', async () => {
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION - 999,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 10)],
    }
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), JSON.stringify(saved), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toEqual([])
    expect(cache.scopeKey).toBe(DEFAULT_DAILY_CACHE_SCOPE)
    expect(cache.lastComputedDate).toBeNull()
  })

  it('round-trips a valid cache through save and load', async () => {
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-09', 12.5, 40), emptyDay('2026-04-10', 7.25, 28)],
    }
    await saveDailyCache(saved)
    const loaded = await loadDailyCache()
    expect(loaded).toEqual({ ...saved, pricingFingerprint: getPricingFingerprint() })
  })

  it('round-trips a scoped cache through save and load without touching global cache', async () => {
    const scopeKey = buildDailyCacheScopeKey(['jarvis-repo'], ['sandbox'])
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey,
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 42, 9)],
    }
    await saveDailyCache(saved)
    const loaded = await loadDailyCache(scopeKey)
    expect(loaded).toEqual({ ...saved, pricingFingerprint: getPricingFingerprint() })
    const global = await loadDailyCache()
    expect(global.days).toEqual([])
  })
})

describe('saveDailyCache', () => {
  it('writes atomically so no temp file is left after a successful save', async () => {
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 5)],
    }
    await saveDailyCache(saved)
    const { readdir } = await import('fs/promises')
    const files = await readdir(TMP_CACHE_ROOT)
    const tempLeftovers = files.filter(f => f.endsWith('.tmp'))
    expect(tempLeftovers).toEqual([])
    const finalFile = await readFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), 'utf-8')
    expect(JSON.parse(finalFile)).toEqual({ ...saved, pricingFingerprint: getPricingFingerprint() })
  })
})

describe('addNewDays', () => {
  it('returns a new cache with the added days sorted ascending by date', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-08',
      days: [emptyDay('2026-04-07', 3), emptyDay('2026-04-08', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-10', 9), emptyDay('2026-04-09', 7)], '2026-04-10')
    expect(updated.days.map(d => d.date)).toEqual(['2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'])
    expect(updated.scopeKey).toBe(DEFAULT_DAILY_CACHE_SCOPE)
    expect(updated.lastComputedDate).toBe('2026-04-10')
  })

  it('replaces existing days with incoming data (last write wins)', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-08',
      days: [emptyDay('2026-04-08', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-08', 99)], '2026-04-08')
    const aprilEight = updated.days.find(d => d.date === '2026-04-08')!
    expect(aprilEight.cost).toBe(99)
  })

  it('does not regress lastComputedDate if incoming newestDate is older', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-05', 3)], '2026-04-05')
    expect(updated.lastComputedDate).toBe('2026-04-10')
  })

  it('uses coveredThrough instead of advancing from a sparse future day', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
      lastComputedDate: '2026-04-08',
      days: [emptyDay('2026-04-08', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-10', 3)], '2026-04-10', { coveredThrough: '2026-04-09' })
    expect(updated.lastComputedDate).toBe('2026-04-09')
  })
})

describe('getDaysInRange', () => {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    scopeKey: DEFAULT_DAILY_CACHE_SCOPE,
    lastComputedDate: '2026-04-10',
    days: [
      emptyDay('2026-04-05', 1),
      emptyDay('2026-04-06', 2),
      emptyDay('2026-04-07', 3),
      emptyDay('2026-04-08', 4),
      emptyDay('2026-04-09', 5),
      emptyDay('2026-04-10', 6),
    ],
  }

  it('returns inclusive start and end range', () => {
    const days = getDaysInRange(cache, '2026-04-07', '2026-04-09')
    expect(days.map(d => d.date)).toEqual(['2026-04-07', '2026-04-08', '2026-04-09'])
  })

  it('returns empty when range is entirely outside cache', () => {
    expect(getDaysInRange(cache, '2026-03-01', '2026-03-10')).toEqual([])
    expect(getDaysInRange(cache, '2026-05-01', '2026-05-10')).toEqual([])
  })

  it('clips to available cache days when range extends beyond', () => {
    const days = getDaysInRange(cache, '2026-04-09', '2026-04-20')
    expect(days.map(d => d.date)).toEqual(['2026-04-09', '2026-04-10'])
  })
})

describe('withDailyCacheLock', () => {
  it('serializes concurrent operations', async () => {
    const sequence: string[] = []
    const op = async (tag: string): Promise<void> => {
      await withDailyCacheLock(async () => {
        sequence.push(`start-${tag}`)
        await new Promise(r => setTimeout(r, 20))
        sequence.push(`end-${tag}`)
      })
    }
    await Promise.all([op('a'), op('b'), op('c')])
    for (let i = 0; i < sequence.length; i += 2) {
      expect(sequence[i]?.startsWith('start-')).toBe(true)
      expect(sequence[i + 1]?.startsWith('end-')).toBe(true)
      expect(sequence[i]!.slice(6)).toBe(sequence[i + 1]!.slice(4))
    }
  })
})
