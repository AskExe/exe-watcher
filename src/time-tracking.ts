import type { DateRange } from './types.js'

export const TIME_HISTORY_START = new Date('2025-07-01T00:00:00').getTime()
export const TIME_PROVIDERS = ['claude', 'codex', 'cursor', 'cursor-agent', 'copilot', 'opencode', 'kimi', 'pi', 'omp']
export type TimeInterval = [start: number, end: number, estimated: 0 | 1]
export type TimeState = {
  agent: string
  children?: Record<string, TimeState>
  child?: boolean
  pending?: number
  lastAssistant?: number
  lastEnd?: number
  ai: TimeInterval[]
  user: TimeInterval[]
  observed: number
  dropped: number
}
export type TimeFile = {
  provider: string; project: string; identity: string; size: number; mtime: number; ctime: number
  offset: number; anchor: string; dbOffset?: number; discarding?: boolean; unavailable?: boolean; state: TimeState
}
export type TimeIndex = { version: 1; files: Record<string, TimeFile>; updatedAt: string; warnings: string[] }
export type TimeReport = {
  since: string; through: string; aiRunningMs: number | null; elapsedBusyMs: number | null; userActiveMs: number | null
  estimatedAiMs: number; coverage: 'partial' | 'missing'; pendingFiles: number; indexedFiles: number
  firstRecordedAt: string | null; lastRecordedAt: string | null
  providers: Array<{ name: string; files: number; timedFiles: number; aiRunningMs: number | null; status: 'partial' | 'missing' }>
  notes: string[]
}

export function timestamp(value: unknown): number | undefined {
  const n = typeof value === 'number' ? (value < 100_000_000_000 ? value * 1000 : value)
    : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(n) && n >= TIME_HISTORY_START && n <= Date.now() + 86_400_000 ? n : undefined
}
function add(list: TimeInterval[], start: number | undefined, end: number | undefined, estimated: 0 | 1): void {
  if (start === undefined || end === undefined || end <= start || end - start > 31 * 86_400_000) return
  list.push([start, end, estimated])
}
function prompt(state: TimeState, at: number | undefined): void {
  if (at === undefined) return
  finishInferred(state)
  // This is an interaction-gap estimate, never a claim about attention or typing.
  if (!state.child && state.lastEnd !== undefined && at > state.lastEnd && at - state.lastEnd <= 5 * 60_000) {
    add(state.user, state.lastEnd, at, 1)
  }
  state.pending = at; state.lastAssistant = undefined
}
export function finishInferred(state: TimeState): void {
  if (state.pending !== undefined && state.lastAssistant !== undefined) {
    // A distant reply cannot prove the agent worked throughout a sleep/idle gap.
    if (state.lastAssistant - state.pending <= 30 * 60_000) add(state.ai, state.pending, state.lastAssistant, 1)
    else state.dropped++
    state.lastEnd = state.lastAssistant
  }
  state.pending = undefined; state.lastAssistant = undefined
}
function complete(state: TimeState, start: number | undefined, end: number | undefined, estimated: 0 | 1 = 0): void {
  add(state.ai, start, end, estimated)
  if (end !== undefined) state.lastEnd = end
  state.pending = undefined; state.lastAssistant = undefined
}

/** Only timestamps, boundaries and durations survive ingestion; no conversation text. */
export function observeTime(provider: string, state: TimeState, x: any): void {
  if (!x || typeof x !== 'object') return
  const at = timestamp(x.timestamp ?? x.time)
  if (provider === 'codex') {
    const p = x.payload ?? {}
    if (x.type === 'session_meta' && typeof p.id === 'string') {
      state.agent = `codex:${p.id}`
      state.child = typeof p.source === 'object' && p.source !== null && 'subagent' in p.source
    }
    if (x.type !== 'event_msg') return
    if (p.type === 'task_started') { state.observed++; prompt(state, timestamp(p.started_at) ?? at) }
    else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      const end = timestamp(p.completed_at) ?? at
      const duration = typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms) && p.duration_ms > 0 ? p.duration_ms : undefined
      const start = timestamp(p.started_at) ?? (end !== undefined && duration ? end - duration : state.pending)
      complete(state, start, end, duration || timestamp(p.started_at) ? 0 : 1)
    }
    return
  }
  if (provider === 'claude') {
    if (typeof x.sessionId === 'string') state.agent = `claude:${x.sessionId}${state.child ? ':' + state.agent.split(':').at(-1) : ''}`
    if (x.type === 'system' && x.subtype === 'turn_duration') {
      const duration = typeof x.durationMs === 'number' && Number.isFinite(x.durationMs) && x.durationMs > 0 ? x.durationMs : undefined
      complete(state, duration && at !== undefined ? at - duration : undefined, at)
    } else if (x.type === 'user' && !x.isMeta && (typeof x.message?.content === 'string' || x.message?.content?.some?.((b: any) => b?.type === 'text'))) {
      state.observed++; prompt(state, at)
    } else if (x.type === 'assistant') { state.observed++; state.lastAssistant = at ?? state.lastAssistant }
    return
  }
  if (provider === 'copilot') {
    if (x.type === 'assistant.turn_start') { state.observed++; state.pending = at }
    if (x.type === 'assistant.turn_end') complete(state, state.pending, at)
    // Old logs without paired boundaries can only supply an estimate.
    if (x.type === 'user.message') { state.observed++; prompt(state, at) }
    if (x.type === 'assistant.message') state.lastAssistant = at ?? state.lastAssistant
    return
  }
  if (provider === 'kimi') {
    const event = x.message ?? x.event ?? x.params ?? x
    const type = event.type ?? x.type
    if (type === 'TurnBegin' || type === 'turn.begin' || type === 'turn.start') { state.observed++; prompt(state, at) }
    else if (type === 'TurnEnd' || type === 'turn.end') complete(state, state.pending, at)
    else if (x.type === 'usage.record') state.observed++
    return
  }
  if (provider === 'pi' || provider === 'omp') {
    if (x.type === 'session' && typeof x.id === 'string') state.agent = `${provider}:${x.id}`
    if (x.type === 'message' && x.message?.role === 'user') { state.observed++; prompt(state, at) }
    else if (x.type === 'message' && x.message?.role === 'assistant') {
      state.observed++; state.lastAssistant = at ?? state.lastAssistant
      if (x.message.stopReason === 'stop') { finishInferred(state) }
    }
    return
  }
  if ((provider === 'cursor-agent' || provider === 'cursor') && x.type === 'result') {
    state.observed++
    const end = timestamp(x.timestamp ?? x.completed_at)
    if (typeof x.duration_ms === 'number' && end !== undefined) complete(state, end - x.duration_ms, end)
  }
}

export function unionIntervals(intervals: TimeInterval[], range?: DateRange): TimeInterval[] {
  const start = Math.max(TIME_HISTORY_START, range?.start.getTime() ?? TIME_HISTORY_START)
  const end = Math.min(range?.end.getTime() ?? Date.now(), Date.now())
  const sorted = intervals.filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] > x[0])
    .map(([a, b, estimate]): TimeInterval => [Math.max(a, start), Math.min(b, end), estimate])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: TimeInterval[] = []
  for (const row of sorted) {
    const last = out.at(-1)
    if (last && row[0] <= last[1]) { last[1] = Math.max(last[1], row[1]); last[2] = Math.max(last[2], row[2]) as 0 | 1 }
    else out.push([...row])
  }
  return out
}
const sum = (rows: TimeInterval[]) => rows.reduce((n, [a, b]) => n + b - a, 0)
export function summarizeTime(index: TimeIndex, range: DateRange, provider = 'all', include?: string[], exclude?: string[]): TimeReport {
  const matches = (name: string, terms?: string[]) => terms?.some(t => name.toLowerCase().includes(t.toLowerCase()))
  const files = Object.values(index.files).filter(f => (provider === 'all' || f.provider === provider)
    && (!include?.length || matches(f.project, include)) && !matches(f.project, exclude))
  const agents = new Map<string, TimeInterval[]>(), user: TimeInterval[] = [], estimated: TimeInterval[] = []
  const byProvider = new Map<string, { files: number; timedFiles: number; agents: Map<string, TimeInterval[]> }>()
  let pendingFiles = 0
  for (const file of files) {
    if (file.offset < file.size || file.unavailable) pendingFiles++
    const row = byProvider.get(file.provider) ?? { files: 0, timedFiles: 0, agents: new Map<string, TimeInterval[]>() }
    row.files++
    // A running/unclosed fragment is deliberately not extended to "now" or across idle gaps.
    let timed = false
    for (const original of [file.state, ...Object.values(file.state.children ?? {})]) {
      const state = { ...original, ai: [...original.ai] }
      finishInferred(state)
      const ai = unionIntervals(state.ai, range)
      timed ||= ai.length > 0
      for (const map of [agents, row.agents]) {
        const list = map.get(state.agent) ?? []
        for (const interval of ai) list.push(interval)
        map.set(state.agent, list)
      }
      for (const interval of state.user) user.push(interval)
      for (const interval of ai) if (interval[2]) estimated.push(interval)
    }
    if (timed) row.timedFiles++
    byProvider.set(file.provider, row)
  }
  const all = [...agents.values()].flatMap(v => unionIntervals(v, range))
  const busy = unionIntervals(all, range), human = unionIntervals(user, range)
  return {
    since: new Date(Math.max(TIME_HISTORY_START, range.start.getTime())).toISOString(), through: range.end.toISOString(),
    aiRunningMs: all.length ? sum(all) : null, elapsedBusyMs: busy.length ? sum(busy) : null,
    userActiveMs: human.length ? sum(human) : null, estimatedAiMs: sum(unionIntervals(estimated, range)),
    coverage: all.length ? 'partial' : 'missing', pendingFiles, indexedFiles: files.length,
    firstRecordedAt: busy.length ? new Date(busy[0]![0]).toISOString() : null,
    lastRecordedAt: busy.length ? new Date(busy.at(-1)![1]).toISOString() : null,
    providers: (provider === 'all' ? TIME_PROVIDERS : [provider]).map(name => {
      const row = byProvider.get(name)
      const duration = row ? [...row.agents.values()].reduce((n, a) => n + sum(unionIntervals(a, range)), 0) : 0
      return { name, files: row?.files ?? 0, timedFiles: row?.timedFiles ?? 0, aiRunningMs: duration || null, status: duration ? 'partial' : 'missing' }
    }),
    notes: [
      'Retained local records only, since July 1, 2025. Missing history is unknown, not zero. Run time can include tools and waiting.',
      'Your time is an estimate of reply-to-next-prompt gaps up to 5 minutes, merged across chats. Longer idle gaps and subagents are excluded; unidentified automation may be included. It does not measure attention.',
      ...(estimated.length ? ['Some AI time is inferred from prompt/response timestamps, limited to spans up to 30 minutes. Longer unmeasured gaps stay unknown.'] : []),
      ...(pendingFiles ? ['Timing recovery is incomplete. Saved progress will resume on later updates; usage costs are unaffected.'] : []),
      ...(files.some(f => f.state.dropped) ? ['Some malformed or oversized timing records could not be recovered; their time is unknown.'] : []),
      ...index.warnings,
    ],
  }
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'Unknown'
  if (ms < 60_000) return '<1 min'
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60)
  return hours ? `${hours.toLocaleString()}h ${minutes % 60}m` : `${minutes}m`
}
