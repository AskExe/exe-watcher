import { expect, it } from 'vitest'
import { observeTime, summarizeTime, unionIntervals, formatDuration, type TimeState, type TimeIndex, type TimeFile } from '../src/time-tracking.js'

const base = Date.parse('2026-07-01T10:00:00Z')
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString()
const range = { start: new Date(base), end: new Date(base + 3600_000) }
const state = (agent = 'agent'): TimeState => ({ agent, ai: [], user: [], observed: 0, dropped: 0 })
function file(provider: string, state: TimeState): TimeFile {
  return { provider, project: 'app', identity: '1', size: 1, mtime: 1, ctime: 1, offset: 1, anchor: '', state }
}
function report(files: TimeFile[]) {
  return summarizeTime({ version: 1, files: Object.fromEntries(files.map((f, i) => [String(i), f])), updatedAt: at(0), warnings: [] }, range)
}

it('adds parallel agent hours, unions elapsed time, and deduplicates copied sessions', () => {
  const a = state('codex:a'), b = state('claude:b')
  a.ai = [[base, base + 3600_000, 0]]; b.ai = [[base, base + 3600_000, 0]]
  const r = report([file('codex', a), file('claude', b), file('codex', structuredClone(a))])
  expect(r.aiRunningMs).toBe(2 * 3600_000)
  expect(r.elapsedBusyMs).toBe(3600_000)
  expect(r.userActiveMs).toBeNull()
  expect(r.coverage).toBe('partial')
})

it('does not recount run IDs inherited by a fork with a different session ID', () => {
  const a = state('codex:original'), fork = state('codex:fork')
  a.ai = [[base, base + 60_000, 0, 'same-turn']]
  fork.ai = [[base, base + 60_000, 0, 'same-turn'], [base + 120_000, base + 150_000, 0, 'new-turn']]
  expect(report([file('codex', a), file('codex', fork)]).aiRunningMs).toBe(90_000)
})

it('reads native Kimi step boundaries without treating gaps between steps as human time', () => {
  const s = state('kimi:session/main')
  for (const [second, type] of [[0, 'step.begin'], [60, 'step.end'], [65, 'step.begin'], [90, 'step.end']] as const) {
    observeTime('kimi', s, { type: 'context.append_loop_event', time: base + second * 1000, event: { type, uuid: `${second}` } })
  }
  expect(report([file('kimi', s)]).aiRunningMs).toBe(85_000)
  expect(s.user).toEqual([])
})

it('prefers the completed run over a shorter copy and sums inferred time across parallel agents', () => {
  const a = state('codex:original'), fork = state('codex:fork'), other = state('pi:parallel')
  a.ai = [[base, base + 30_000, 1, 'same-turn']]
  fork.ai = [[base, base + 60_000, 0, 'same-turn'], [base + 60_000, base + 120_000, 1, 'inferred-turn']]
  other.ai = [[base + 60_000, base + 120_000, 1, 'parallel-turn']]
  const result = report([file('codex', a), file('codex', fork), file('pi', other)])
  expect(result.aiRunningMs).toBe(180_000)
  expect(result.estimatedAiMs).toBe(120_000)
  expect(result.elapsedBusyMs).toBe(120_000)
})

it('clips cross-midnight, weekly and monthly windows and handles a 23-hour DST day', () => {
  const start = new Date('2026-03-08T00:00:00-05:00'), end = new Date('2026-03-09T00:00:00-04:00')
  expect(unionIntervals([[start.getTime() - 1000, end.getTime() + 1000, 0]], { start, end }))
    .toEqual([[start.getTime(), end.getTime(), 0]])
  expect(end.getTime() - start.getTime()).toBe(23 * 3600_000)
  const since = new Date('2025-07-01T00:00:00')
  expect(unionIntervals([[since.getTime() - 60_000, since.getTime() + 60_000, 0]])[0]?.[0]).toBe(since.getTime())
})

it('uses Claude recorded durations, ignores tool-result prompts and estimates only short human gaps', () => {
  const s = state('claude:main')
  observeTime('claude', s, { type: 'user', timestamp: at(0), message: { content: 'prompt' } })
  observeTime('claude', s, { type: 'user', timestamp: at(30), message: { content: [{ type: 'tool_result' }] } })
  observeTime('claude', s, { type: 'system', subtype: 'turn_duration', durationMs: 60_000, timestamp: at(60) })
  observeTime('claude', s, { type: 'user', timestamp: at(120), message: { content: 'next' } })
  expect(report([file('claude', s)]).aiRunningMs).toBe(60_000)
  expect(report([file('claude', s)]).userActiveMs).toBe(60_000)
  const child = { ...state('claude:child'), child: true, lastEnd: base }
  observeTime('claude', child, { type: 'user', timestamp: at(60), message: { content: 'automated task' } })
  expect(child.user).toEqual([])
})

it('recovers Codex completions and interruptions without counting duplicated terminal records twice', () => {
  const s = state()
  observeTime('codex', s, { type: 'session_meta', payload: { id: 'session' } })
  observeTime('codex', s, { type: 'event_msg', timestamp: at(0), payload: { type: 'task_started', turn_id: 't' } })
  const complete = { type: 'event_msg', timestamp: at(60), payload: { type: 'task_complete', duration_ms: 60_000 } }
  observeTime('codex', s, complete); observeTime('codex', s, complete)
  observeTime('codex', s, { type: 'event_msg', timestamp: at(180), payload: { type: 'turn_aborted', duration_ms: 30_000 } })
  expect(report([file('codex', s)]).aiRunningMs).toBe(90_000)
  expect(s.agent).toBe('codex:session')
})

it.each(['copilot', 'kimi'])('reads recorded %s turn boundaries', provider => {
  const s = state(provider)
  const types = provider === 'copilot' ? ['assistant.turn_start', 'assistant.turn_end'] : ['TurnBegin', 'TurnEnd']
  types.forEach((type, i) => observeTime(provider, s, { type, timestamp: at(i * 60) }))
  expect(report([file(provider, s)]).aiRunningMs).toBe(60_000)
  expect(report([file(provider, s)]).estimatedAiMs).toBe(0)
})

it.each(['pi', 'omp'])('marks %s timestamp reconstruction as inferred and rejects long idle spans', provider => {
  const s = state(provider)
  observeTime(provider, s, { type: 'session', id: 's' })
  observeTime(provider, s, { type: 'message', timestamp: at(0), message: { role: 'user' } })
  observeTime(provider, s, { type: 'message', timestamp: at(60), message: { role: 'assistant', stopReason: 'stop' } })
  expect(report([file(provider, s)]).estimatedAiMs).toBe(60_000)
  const old = state(provider)
  observeTime(provider, old, { type: 'message', timestamp: at(0), message: { role: 'user' } })
  observeTime(provider, old, { type: 'message', timestamp: at(3500), message: { role: 'assistant', stopReason: 'stop' } })
  expect(report([file(provider, old)]).aiRunningMs).toBeNull()
})

it('does not convert missing clocks, isolated timestamps or open sessions into zero or elapsed work', () => {
  const s = state('cursor-agent:text')
  s.observed = 20
  s.pending = base
  const r = report([file('cursor-agent', s)])
  expect(r.aiRunningMs).toBeNull(); expect(r.elapsedBusyMs).toBeNull(); expect(r.userActiveMs).toBeNull()
  expect(r.providers.find(p => p.name === 'cursor-agent')?.status).toBe('missing')
  expect(formatDuration(null)).toBe('Unknown')
  expect(formatDuration(3_660_000)).toBe('1h 1m')
})

it('merges personal estimates across chats and respects provider/project filters', () => {
  const a = state('a'), b = state('b')
  a.user = [[base, base + 120_000, 1]]; b.user = [[base + 60_000, base + 180_000, 1]]
  a.ai = [[base, base + 60_000, 0]]; b.ai = [[base, base + 60_000, 0]]
  const x = file('claude', a), y = { ...file('codex', b), project: 'other' }
  expect(report([x, y]).userActiveMs).toBe(180_000)
  const index: TimeIndex = { version: 1, files: { a: x, b: y }, updatedAt: at(0), warnings: [] }
  expect(summarizeTime(index, range, 'claude').aiRunningMs).toBe(60_000)
  expect(summarizeTime(index, range, 'all', ['other']).aiRunningMs).toBe(60_000)
  expect(summarizeTime(index, range, 'all', undefined, ['app']).aiRunningMs).toBe(60_000)
})
