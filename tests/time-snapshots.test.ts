import { expect, it } from 'vitest'
import { buildTimeSnapshots } from '../src/time-snapshots.js'
import type { TimeIndex, TimeFile } from '../src/time-tracking.js'

it('returns scoped time windows and global queue progress without financial data', () => {
  const start = Date.parse('2026-07-01T10:00:00Z')
  const file = (provider: string, second: number, pending = false): TimeFile => ({
    provider, project: 'fixture', identity: provider, size: 20, offset: pending ? 1 : 20,
    mtime: 1, ctime: 1, anchor: '', state: { agent: provider, observed: 1, dropped: 0,
      ai: [[start + second * 1000, start + (second + 30) * 1000, 0]], user: [] },
  })
  const index: TimeIndex = { version: 1, updatedAt: new Date(start).toISOString(), warnings: [],
    files: { a: file('codex', 0), b: file('claude', 120, true) } }
  const ranges = {
    today: { start: new Date(start + 100_000), end: new Date(start + 180_000) },
    week: { start: new Date(start), end: new Date(start + 180_000) },
    all: { start: new Date('2025-07-01T00:00:00Z'), end: new Date(start + 180_000) },
  }
  const result = buildTimeSnapshots(index, ranges, 'codex')
  expect(result.periods.today?.aiRunningMs).toBeNull()
  expect(result.periods.week?.aiRunningMs).toBe(30_000)
  expect(result.allPeriods?.today?.aiRunningMs).toBe(30_000)
  expect(result.periods.all?.recovery.runnableFiles).toBe(0)
  expect(result.recovery.runnableFiles).toBe(1)
  expect(Object.keys(result).sort()).toEqual(['allPeriods', 'generated', 'periods', 'provider', 'recovery'])
})
