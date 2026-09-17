import { describe, expect, it } from 'vitest'

import {
  ALL_TIME_HISTORY_DAYS,
  computeProgressiveBackfillStart,
  DEFAULT_COLD_START_HISTORY_DAYS,
  DEFAULT_PROGRESSIVE_CHUNK_DAYS,
  MAX_BLOCKED_CHUNK_ATTEMPTS,
  nextBackfillCursor,
  planBackfillChunks,
  resolveColdStartHistoryDays,
  shouldSkipBlockedChunk,
  THIRTY_DAY_HISTORY_DAYS,
  WEEK_HISTORY_DAYS,
} from '../src/progressive-backfill.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

function localDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second, ms)
}

describe('computeProgressiveBackfillStart', () => {
  it('backfills enough prior days to make a full cold-start history window', () => {
    const todayStart = localDate(2026, 5, 5)
    const yesterdayEnd = new Date(todayStart.getTime() - 1)

    const start = computeProgressiveBackfillStart({
      lastComputedDate: null,
      todayStart,
      yesterdayEnd,
      backfillDays: 365,
    })

    expect(start.getTime()).toBe(todayStart.getTime() - (DEFAULT_COLD_START_HISTORY_DAYS - 1) * MS_PER_DAY)
  })

  it('clamps stale caches to the full backfill window', () => {
    const todayStart = localDate(2026, 5, 5)
    const yesterdayEnd = new Date(todayStart.getTime() - 1)

    const start = computeProgressiveBackfillStart({
      lastComputedDate: '2025-01-01',
      todayStart,
      yesterdayEnd,
      backfillDays: 30,
    })

    expect(start).toEqual(localDate(2026, 4, 5))
  })

  it('limits warm-cache catch-up to the progressive chunk size', () => {
    const todayStart = localDate(2026, 5, 5)
    const yesterdayEnd = new Date(todayStart.getTime() - 1)

    const start = computeProgressiveBackfillStart({
      lastComputedDate: '2026-03-01',
      todayStart,
      yesterdayEnd,
      backfillDays: 365,
    })

    expect(start.getTime()).toBe(yesterdayEnd.getTime() - DEFAULT_PROGRESSIVE_CHUNK_DAYS * MS_PER_DAY)
  })

  it('starts from the next day when the cache is only slightly behind', () => {
    const todayStart = localDate(2026, 5, 5)
    const yesterdayEnd = new Date(todayStart.getTime() - 1)

    const start = computeProgressiveBackfillStart({
      lastComputedDate: '2026-05-03',
      todayStart,
      yesterdayEnd,
      backfillDays: 365,
    })

    expect(start).toEqual(localDate(2026, 5, 4))
  })
})


describe('resolveColdStartHistoryDays', () => {
  it('matches each menubar period to the history window it needs on cold start', () => {
    const now = localDate(2026, 5, 5, 12)

    expect(resolveColdStartHistoryDays('today', now)).toBe(1)
    expect(resolveColdStartHistoryDays('week', now)).toBe(WEEK_HISTORY_DAYS)
    expect(resolveColdStartHistoryDays('30days', now)).toBe(THIRTY_DAY_HISTORY_DAYS)
    expect(resolveColdStartHistoryDays('month', now)).toBe(5)
    expect(resolveColdStartHistoryDays('all', now)).toBe(ALL_TIME_HISTORY_DAYS)
  })
})


describe('planBackfillChunks', () => {
  it('splits a multi-day gap into day-aligned slices, oldest first', () => {
    const chunks = planBackfillChunks(localDate(2026, 9, 15), new Date(localDate(2026, 9, 18).getTime() - 1))

    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.start).toEqual(localDate(2026, 9, 15))
    expect(chunks[0]!.end).toEqual(new Date(localDate(2026, 9, 16).getTime() - 1))
    expect(chunks[2]!.start).toEqual(localDate(2026, 9, 17))
    expect(chunks[2]!.end).toEqual(new Date(localDate(2026, 9, 18).getTime() - 1))
  })

  it('never runs past the requested end', () => {
    const end = localDate(2026, 9, 16, 10, 30)
    const chunks = planBackfillChunks(localDate(2026, 9, 15), end, 5)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.end).toEqual(end)
  })

  it('returns nothing when the range is empty', () => {
    expect(planBackfillChunks(localDate(2026, 9, 16), localDate(2026, 9, 15))).toEqual([])
  })
})

describe('backfill cursor', () => {
  it('counts repeat aborts on the same slice and resets when a different one blocks', () => {
    const first = nextBackfillCursor(null, '2026-09-15')
    expect(first).toEqual({ blockedDate: '2026-09-15', attempts: 1 })

    const second = nextBackfillCursor(first, '2026-09-15')
    expect(second.attempts).toBe(2)

    expect(nextBackfillCursor(second, '2026-09-16')).toEqual({ blockedDate: '2026-09-16', attempts: 1 })
  })

  it('only skips a slice once it has exhausted its retries', () => {
    expect(shouldSkipBlockedChunk(null, '2026-09-15')).toBe(false)
    expect(shouldSkipBlockedChunk({ blockedDate: '2026-09-15', attempts: 1 }, '2026-09-15')).toBe(false)
    expect(shouldSkipBlockedChunk({ blockedDate: '2026-09-15', attempts: MAX_BLOCKED_CHUNK_ATTEMPTS }, '2026-09-15')).toBe(true)
    expect(shouldSkipBlockedChunk({ blockedDate: '2026-09-15', attempts: MAX_BLOCKED_CHUNK_ATTEMPTS }, '2026-09-16')).toBe(false)
  })
})
