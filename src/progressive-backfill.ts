const MS_PER_DAY = 24 * 60 * 60 * 1000

export const DEFAULT_COLD_START_HISTORY_DAYS = 7
export const DEFAULT_PROGRESSIVE_CHUNK_DAYS = 30
export const ALL_TIME_HISTORY_DAYS = 365
export const THIRTY_DAY_HISTORY_DAYS = 30
export const WEEK_HISTORY_DAYS = 7

export type ProgressiveBackfillPeriod = 'today' | 'week' | '30days' | 'month' | 'all'

export function resolveColdStartHistoryDays(period: ProgressiveBackfillPeriod, now = new Date()): number {
  switch (period) {
    case 'today':
      return 1
    case 'week':
      return WEEK_HISTORY_DAYS
    case '30days':
      return THIRTY_DAY_HISTORY_DAYS
    case 'month':
      return Math.max(now.getDate(), 1)
    case 'all':
      return ALL_TIME_HISTORY_DAYS
  }
}

type ProgressiveBackfillStartInput = {
  lastComputedDate: string | null
  oldestCachedDate: string | null
  todayStart: Date
  yesterdayEnd: Date
  backfillDays: number
  coldStartHistoryDays?: number
  progressiveChunkDays?: number
}

function nextLocalMidnight(dateString: string): Date {
  return new Date(
    parseInt(dateString.slice(0, 4), 10),
    parseInt(dateString.slice(5, 7), 10) - 1,
    parseInt(dateString.slice(8, 10), 10) + 1,
  )
}

export function computeProgressiveBackfillStart({
  lastComputedDate,
  oldestCachedDate,
  todayStart,
  yesterdayEnd,
  backfillDays,
  coldStartHistoryDays = DEFAULT_COLD_START_HISTORY_DAYS,
  progressiveChunkDays = DEFAULT_PROGRESSIVE_CHUNK_DAYS,
}: ProgressiveBackfillStartInput): Date {
  const fullBackfillStart = new Date(todayStart.getTime() - backfillDays * MS_PER_DAY)
  const neededStart = new Date(todayStart.getTime() - (coldStartHistoryDays - 1) * MS_PER_DAY)

  if (!lastComputedDate) {
    // Cold start: fill from the period's required start date.
    const priorHistoryDays = Math.max(coldStartHistoryDays - 1, 0)
    return new Date(todayStart.getTime() - priorHistoryDays * MS_PER_DAY)
  }

  // Forward gap: cache doesn't reach yesterday yet.
  const gapStart = nextLocalMidnight(lastComputedDate)
  if (gapStart.getTime() <= yesterdayEnd.getTime()) {
    if (gapStart < fullBackfillStart) return fullBackfillStart
    if ((yesterdayEnd.getTime() - gapStart.getTime()) > progressiveChunkDays * MS_PER_DAY) {
      return new Date(yesterdayEnd.getTime() - progressiveChunkDays * MS_PER_DAY)
    }
    return gapStart
  }

  // Backward gap: cache covers through yesterday but doesn't go far enough back
  // for the requested period. E.g., cache has 7 days but user wants 30 days.
  // Fill the ENTIRE missing range at once — no chunking. Each period should get
  // its full data on the first request (today=1d, week=7d, 30d=30d, all=365d).
  if (oldestCachedDate && neededStart.getTime() < new Date(oldestCachedDate).getTime()) {
    return neededStart < fullBackfillStart ? fullBackfillStart : neededStart
  }

  return gapStart
}

/** One backfill slice. Scanned, aggregated and persisted as a unit so that a
 *  budget abort on a later slice can never discard an earlier one. */
export type BackfillChunk = { start: Date; end: Date }

/** A slice that aborted on the resource budget, with how many runs have tried it.
 *  Persisted in the daily cache so the next run resumes instead of restarting. */
export type BackfillCursor = { blockedDate: string; attempts: number }

export const DEFAULT_BACKFILL_CHUNK_DAYS = 1
/** After this many consecutive aborts a slice is recorded as incomplete and skipped.
 *  Without it, one unscannable day blocks every newer day forever. */
export const MAX_BLOCKED_CHUNK_ATTEMPTS = 2

/** Split [start, end] into local-midnight-aligned slices, oldest first.
 *  Each slice ends at the last millisecond of its final day, clamped to `end`. */
export function planBackfillChunks(start: Date, end: Date, chunkDays = DEFAULT_BACKFILL_CHUNK_DAYS): BackfillChunk[] {
  const size = Math.max(1, Math.floor(chunkDays))
  const chunks: BackfillChunk[] = []
  if (start.getTime() > end.getTime()) return chunks
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  if (cursor.getTime() < start.getTime()) cursor = new Date(start.getTime())
  while (cursor.getTime() <= end.getTime()) {
    const dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
    const lastDay = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + size - 1)
    const chunkEnd = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1).getTime() - 1
    chunks.push({ start: new Date(cursor.getTime()), end: new Date(Math.min(chunkEnd, end.getTime())) })
    cursor = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + size)
  }
  return chunks
}

/** Count an abort against `date`, resetting the counter when a different slice blocks. */
export function nextBackfillCursor(prev: BackfillCursor | null | undefined, date: string): BackfillCursor {
  return prev && prev.blockedDate === date
    ? { blockedDate: date, attempts: prev.attempts + 1 }
    : { blockedDate: date, attempts: 1 }
}

/** True once `date` has exhausted its retries and must be skipped to keep progress monotone. */
export function shouldSkipBlockedChunk(
  cursor: BackfillCursor | null | undefined,
  date: string,
  maxAttempts = MAX_BLOCKED_CHUNK_ATTEMPTS,
): boolean {
  return !!cursor && cursor.blockedDate === date && cursor.attempts >= maxAttempts
}
