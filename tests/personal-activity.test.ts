import { expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readActivityHistory, summarizeActivity, type ActivityHistory } from '../src/personal-activity.js'
import { estimateSessions, personalTimeMs, summarizeTime, type TimeIndex } from '../src/time-tracking.js'

const base = Date.parse('2026-07-01T00:00:00Z'), minute = 60_000
const range = { start: new Date(base), end: new Date(base + 86_400_000) }
const history = (): ActivityHistory => ({ version: 1, startedAt: new Date(base).toISOString(),
  updatedAt: new Date(base + 3600_000).toISOString(), enabled: true,
  days: [{ start: base, end: base + 86_400_000, active: { codex: 120_000, claude: 60_000 }, contextual: { codex: 30_000 } }] })
const folders: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

it('estimates nearby main-chat sessions with explicit sensitivity and no padding', () => {
  const points = [0, 5, 17, 42, 100].map(x => base + x * minute)
  const result = estimateSessions([...points, points[0]!], range)!
  expect(result.lowerMs).toBe(5 * minute)
  expect(result.milliseconds).toBe(17 * minute)
  expect(result.upperMs).toBe(42 * minute)
  expect(estimateSessions([base], range)).toBeUndefined()
  expect(estimateSessions([base, base + 2 * 3600_000], range)).toBeUndefined()
  const clipped = estimateSessions(points, { start: new Date(base + 15 * minute), end: new Date(base + 35 * minute) })!
  expect(clipped.milliseconds).toBe(2 * minute)
  expect(clipped.upperMs).toBe(20 * minute)
})

it('keeps provider/project scope and children out of personal sessions; never changes AI time', () => {
  const state = (agent: string, child = false) => ({ agent, child, observed: 0, dropped: 0, user: [],
    ai: [0, 5, 10].map(x => [base + x * minute, base + (x + 1) * minute, 0] as [number, number, 0]) })
  const file = (provider: string, child = false) => ({ provider, project: provider, identity: provider, size: 1, offset: 1, mtime: 0, ctime: 0, anchor: '', state: state(provider, child) })
  const index: TimeIndex = { version: 1, updatedAt: new Date(base).toISOString(), warnings: [], files: { a: file('codex'), b: file('claude', true) } }
  expect(summarizeTime(index, range).sessionEstimate?.milliseconds).toBe(10 * minute)
  expect(summarizeTime(index, range, 'claude').sessionEstimate).toBeUndefined()
  expect(summarizeTime(index, range, 'all', ['claude']).sessionEstimate).toBeUndefined()
  expect(summarizeTime(index, range).aiRunningMs).toBe(6 * minute)
  const saved = history(); saved.startedAt = new Date(base + 7 * minute).toISOString()
  const result = summarizeTime(index, range, 'all', undefined, undefined, saved)
  expect(result.sessionEstimate?.milliseconds).toBe(7 * minute)
  expect(result.appActivity?.activeMs).toBe(180_000)
  expect(summarizeTime(index, range, 'all', ['codex'], undefined, saved).appActivity).toBeUndefined()
})

it('sums daily app totals once and respects provider and day boundaries', () => {
  expect(summarizeActivity(history(), range)?.activeMs).toBe(180_000)
  expect(summarizeActivity(history(), range, 'codex')?.contextualMs).toBe(30_000)
  expect(summarizeActivity(history(), range, 'kimi')?.activeMs).toBe(0)
  expect(summarizeActivity(history(), { start: new Date(base + 1), end: range.end })?.activeMs).toBe(0)
  expect(summarizeActivity(undefined, range)).toBeUndefined()
})

it('keeps unknown personal time unknown and preserves old cached estimates', () => {
  const index: TimeIndex = { version: 1, files: {}, updatedAt: new Date(base).toISOString(), warnings: [] }
  const time = summarizeTime(index, range)
  expect(personalTimeMs(time)).toBeNull()
  expect(personalTimeMs(undefined)).toBeNull()
  expect(personalTimeMs({ ...time, personalTimeVersion: undefined, userActiveMs: 60_000 })).toBe(60_000)
  expect(personalTimeMs({ ...time, appActivity: summarizeActivity(history(), range) })).toBe(210_000)
})

it('reads a bounded native ledger and refuses invalid, overlapping and symlink histories', () => {
  const folder = mkdtempSync(join(tmpdir(), 'watcher-activity-')); folders.push(folder)
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', folder)
  const path = join(folder, 'personal-activity-v1.json')
  expect(readActivityHistory()).toBeUndefined()
  writeFileSync(path, JSON.stringify(history()))
  expect(readActivityHistory()?.version).toBe(1)
  const bad = history(); bad.days.push(bad.days[0]!)
  writeFileSync(path, JSON.stringify(bad)); expect(readActivityHistory()).toBeUndefined()
  bad.days = [{ ...history().days[0]!, active: { codex: -1 } }]
  writeFileSync(path, JSON.stringify(bad)); expect(readActivityHistory()).toBeUndefined()
  rmSync(path); const other = join(folder, 'other.json'); writeFileSync(other, JSON.stringify(history()))
  symlinkSync(other, path); expect(readActivityHistory()).toBeUndefined()
})
