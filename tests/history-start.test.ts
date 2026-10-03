import { afterEach, expect, it, vi } from 'vitest'
import { parseHistoryStartDate, resolveHistoryStart } from '../src/history-start.js'
vi.mock('../src/parser.js', () => ({ getDiscoveredSources: async () => [] }))
afterEach(() => vi.restoreAllMocks())
it('rejects rollover dates and parses valid history starts', () => {
  expect(parseHistoryStartDate('2025-07-01')).toEqual(new Date(2025, 6, 1))
  expect(parseHistoryStartDate('2025-02-31')).toBeNull()
  expect(parseHistoryStartDate('bad')).toBeNull()
})
it('keeps a configured coding journey older than a year', async () => {
  expect(await resolveHistoryStart('2025-07-01', [], new Date(2026, 8, 30))).toEqual(new Date(2025, 6, 1))
})
it('keeps the oldest available cache date without a rolling cutoff', async () => {
  expect(await resolveHistoryStart(undefined, ['2025-01-01', '2026-09-29'], new Date(2026, 8, 30))).toEqual(new Date(2025, 0, 1))
})
