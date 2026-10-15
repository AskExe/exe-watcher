import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { refreshTimeIndex, readTimeIndex } from '../src/time-index.js'
import { summarizeTime } from '../src/time-tracking.js'
import type { SessionSource } from '../src/providers/types.js'
let dir: string
const start = Date.parse('2026-07-01T10:00:00Z')
const range = { start: new Date(start), end: new Date(start + 3600_000) }
const event = (seconds: number, type: string, payload = {}) => JSON.stringify({ timestamp: new Date(start + seconds * 1000).toISOString(), type: 'event_msg', payload: { type, ...payload } }) + '\n'
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'watcher-time-')); vi.stubEnv('EXE_WATCHER_CACHE_DIR', join(dir, 'cache')) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })
function source(path: string, provider = 'codex'): SessionSource { return { path, provider, project: 'fixture' } }
const duration = (index: Awaited<ReturnType<typeof readTimeIndex>>) => summarizeTime(index, range).aiRunningMs

it('tails append-only files under a read budget that cannot reread the transcript, and invalidates truncation', async () => {
  const path = join(dir, 'session.jsonl')
  await writeFile(path, event(0, 'task_started') + JSON.stringify({ type: 'padding', content: 'x'.repeat(100_000) }) + '\n' + event(60, 'task_complete', { duration_ms: 60_000 }))
  expect(duration(await refreshTimeIndex({ sources: [source(path)], history: true }))).toBe(60_000)
  await appendFile(path, event(120, 'task_started') + event(150, 'task_complete', { duration_ms: 30_000 }))
  vi.stubEnv('EXE_WATCHER_MAX_SCAN_BYTES', '4096')
  expect(duration(await refreshTimeIndex({ sources: [source(path)], history: true }))).toBe(90_000)
  await writeFile(path, event(0, 'task_complete', { duration_ms: 5000 }))
  expect(duration(await refreshTimeIndex({ sources: [source(path)], history: true }))).toBeNull() // clipped before range start
})

it('persists completed files on resource exhaustion and recovers on a later process-style reload', async () => {
  const paths = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  for (const path of paths) await writeFile(path, JSON.stringify({ type: 'padding', content: 'x'.repeat(40_000) }) + '\n' + event(60, 'task_complete', { duration_ms: 60_000 }))
  vi.stubEnv('EXE_WATCHER_MAX_SCAN_BYTES', '64000')
  const sources = paths.map(p => source(p))
  const first = await refreshTimeIndex({ sources, history: true })
  expect(summarizeTime(first, range).pendingFiles).toBeGreaterThan(0)
  expect(duration(await readTimeIndex())).toBe(60_000)
  const next = await refreshTimeIndex({ sources, history: true })
  expect(duration(next)).toBe(120_000)
  expect(summarizeTime(next, range).pendingFiles).toBe(0)
})

it('waits for a partial final record and keeps timings when a source is later removed', async () => {
  const path = join(dir, 'partial.jsonl'), body = event(60, 'task_complete', { duration_ms: 60_000 })
  await writeFile(path, body.slice(0, -20))
  expect(duration(await refreshTimeIndex({ sources: [source(path)], history: true }))).toBeNull()
  await appendFile(path, body.slice(-20))
  expect(duration(await refreshTimeIndex({ sources: [source(path)], history: true }))).toBe(60_000)
  await rm(path)
  expect(duration(await refreshTimeIndex({ sources: [], history: true }))).toBe(60_000)
})

it('resets a rotated file and labels text transcripts without clocks as unknown', async () => {
  const path = join(dir, 'a.jsonl'), replacement = join(dir, 'replacement.jsonl'), text = join(dir, 'chat.txt')
  await writeFile(path, event(60, 'task_complete', { duration_ms: 60_000 }))
  await refreshTimeIndex({ sources: [source(path)], history: true })
  await writeFile(replacement, event(60, 'task_complete', { duration_ms: 10_000 }))
  await rename(replacement, path); await writeFile(text, 'user: hello\nA: hello')
  const index = await refreshTimeIndex({ sources: [source(path), source(text, 'cursor-agent')], history: true })
  expect(duration(index)).toBe(10_000)
  expect(summarizeTime(index, range, 'cursor-agent').aiRunningMs).toBeNull()
})

it('recovers Cursor conversation clocks without merging parallel conversations into one agent', async () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const path = join(dir, 'cursor.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value TEXT)')
  for (const conversationId of ['a', 'b']) db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(`bubbleId:${conversationId}:${conversationId}-bubble`, JSON.stringify({ conversationId, timingInfo: { clientStartTime: start, clientEndTime: start + 60_000 } }))
  db.close()
  const index = await refreshTimeIndex({ sources: [source(path, 'cursor')], history: true })
  expect(duration(index)).toBe(120_000)
  expect(summarizeTime(index, range).elapsedBusyMs).toBe(60_000)
})

it('includes OpenCode archived sessions and subagents, using completed message clocks', async () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const path = join(dir, 'opencode.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_archived INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const id of ['parent', 'child']) {
    db.prepare('INSERT INTO session VALUES (?,?,?,?)').run(id, '/fixture', id === 'child' ? 'parent' : null, 123)
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, id, start, JSON.stringify({ role: 'assistant', time: { created: start, completed: start + 60_000 } }))
  }
  db.close()
  const index = await refreshTimeIndex({ sources: [source(path + ':parent', 'opencode')], history: true })
  expect(duration(index)).toBe(120_000)
  expect(summarizeTime(index, range).elapsedBusyMs).toBe(60_000)
})

it('keeps separate Kimi main agents and isolates an unsupported database', async () => {
  const paths = ['session_a', 'session_b'].map(id => join(dir, id, 'agents', 'main', 'wire.jsonl'))
  for (const [i, path] of paths.entries()) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, [
      { type: 'context.append_loop_event', time: start, event: { type: 'step.begin', uuid: `step-${i}` } },
      { type: 'context.append_loop_event', time: start + 60_000, event: { type: 'step.end' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n')
  }
  const unsupported = join(dir, 'unsupported.db')
  await writeFile(unsupported, 'not a database')
  const index = await refreshTimeIndex({ sources: [...paths.map(path => source(path, 'kimi')), source(unsupported + ':root', 'opencode')], history: true })
  expect(duration(index)).toBe(120_000)
  expect(summarizeTime(index, range).elapsedBusyMs).toBe(60_000)
  expect(index.warnings).toContain('An OpenCode database has no readable timing schema; its time is unknown.')
})

it('recovers OpenCode interaction gaps while excluding identified child sessions', async () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const path = join(dir, 'opencode.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const id of ['main', 'child']) {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run(id, '/fixture', id === 'child' ? 'main' : null)
    for (const [seconds, data] of [[0, { role: 'assistant', time: { created: start, completed: start + 60_000 } }], [120, { role: 'user' }]] as const) {
      db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(`${id}-${seconds}`, id, start + seconds * 1000, JSON.stringify(data))
    }
  }
  db.close()
  const index = await refreshTimeIndex({ sources: [source(path + ':main', 'opencode')], history: true })
  expect(duration(index)).toBe(120_000)
  expect(summarizeTime(index, range).userActiveMs).toBe(60_000)
})

it('recovers Cursor interaction gaps from saved user clocks without loading text', async () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const path = join(dir, 'cursor.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value TEXT)')
  for (const [key, data] of [
    ['reply', { type: 2, timingInfo: { clientStartTime: start, clientEndTime: start + 60_000 } }],
    ['prompt', { type: 1, createdAt: new Date(start + 120_000).toISOString() }],
  ] as const) db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(`bubbleId:chat:${key}`, JSON.stringify({ conversationId: 'chat', ...data }))
  db.close()
  const index = await refreshTimeIndex({ sources: [source(path, 'cursor')], history: true })
  expect(summarizeTime(index, range).userActiveMs).toBe(60_000)
})

it('cancellation preserves previously recovered time and does not change cost history', async () => {
  const path = join(dir, 's.jsonl'), costs = join(dir, 'cache', 'daily-cache.json')
  await writeFile(path, event(60, 'task_complete', { duration_ms: 60_000 }))
  await refreshTimeIndex({ sources: [source(path)], history: true })
  await writeFile(costs, '{"sentinel":42}')
  const controller = new AbortController(); controller.abort()
  const index = await refreshTimeIndex({ sources: [source(path)], signal: controller.signal })
  expect(duration(index)).toBe(60_000)
  expect(await readFile(costs, 'utf8')).toBe('{"sentinel":42}')
})
