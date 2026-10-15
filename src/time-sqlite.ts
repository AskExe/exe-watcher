import { openDatabase } from './sqlite.js'
import { chargeRecord } from './resource-budget.js'
import { observeTime, timestamp, type TimeFile, type TimeState } from './time-tracking.js'
import type { SessionSource } from './providers/types.js'

const PAGE = 1000
function stateFor(file: TimeFile, agent: string): TimeState {
  const children = file.state.children ??= Object.create(null)
  // Keys come from data; defineProperty also makes __proto__ a harmless own key.
  if (!Object.hasOwn(children, agent)) Object.defineProperty(children, agent, {
    value: { agent, ai: [], user: [], observed: 0, dropped: 0 }, enumerable: true, writable: true,
  })
  return children[agent]!
}
function interval(state: TimeState, startValue: unknown, endValue: unknown, id: string, estimated: 0 | 1 = 0): void {
  const start = timestamp(startValue), end = timestamp(endValue)
  state.observed++
  if (start !== undefined && end !== undefined && end > start && end - start <= 31 * 86_400_000) state.ai.push([start, end, estimated, id])
  if (end !== undefined) state.lastEnd = end
}

/** Read only clocks/IDs in pages; never load stored prompts, images or code blocks. */
export async function scanTimeDatabase(source: SessionSource, file: TimeFile): Promise<void> {
  const separator = source.path.lastIndexOf(':')
  const path = source.provider === 'opencode' ? source.path.slice(0, separator) : source.path
  const db = openDatabase(path)
  try {
    let rows: Record<string, unknown>[]
    if (source.provider === 'cursor') {
      rows = db.query(`SELECT key,
        json_extract(value, '$.conversationId') AS conversation,
        json_extract(value, '$.type') AS role,
        json_extract(value, '$.createdAt') AS created,
        json_extract(value, '$.timingInfo.clientStartTime') AS started,
        COALESCE(json_extract(value, '$.timingInfo.clientEndTime'), json_extract(value, '$.timingInfo.clientSettleTime')) AS completed
        FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid LIMIT ? OFFSET ?`, [PAGE, file.dbOffset ?? 0])
      for (const row of rows) {
        chargeRecord()
        const conversation = typeof row.conversation === 'string' ? row.conversation : String(row.key).split(':')[1]
        const state = stateFor(file, `cursor:${conversation}`)
        if (row.role === 1) observeTime('cursor', state, { type: 'user', timestamp: row.created })
        else interval(state, row.started, row.completed, `${String(row.key).split(':').at(-1)}:${String(row.started)}`)
      }
    } else {
      // Old messages can be closed in bulk weeks later. Their completion clocks
      // cannot prove continuous work. Retain only a short observed prefix then.
      const hasParts = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'part'").length > 0
      const evidence = hasParts ? `(SELECT MAX(part.time_created) FROM part WHERE part.message_id = message.id
        AND part.time_created >= message.time_created AND part.time_created <= message.time_created + 1800000)` : 'NULL'
      rows = db.query(`SELECT message.id, session.parent_id AS parent,
        json_extract(data, '$.role') AS role,
        COALESCE(json_extract(data, '$.time.created'), message.time_created) AS started,
        json_extract(message.data, '$.time.completed') AS completed, ${evidence} AS observed_end
        FROM message JOIN session ON message.session_id = session.id
        WHERE message.session_id = ? ORDER BY message.time_created, message.id LIMIT ? OFFSET ?`, [source.path.slice(separator + 1), PAGE, file.dbOffset ?? 0])
      const state = stateFor(file, `opencode:${source.path.slice(separator + 1)}`)
      for (const row of rows) {
        chargeRecord()
        state.child = !!row.parent
        if (row.role === 'user') observeTime('opencode', state, { type: 'user', timestamp: row.started })
        else if (row.role === 'assistant') {
          const started = timestamp(row.started), completed = timestamp(row.completed)
          if (started !== undefined && (completed === undefined || completed < started || completed - started > 30 * 60_000)) {
            state.dropped++
            const observed = timestamp(row.observed_end)
            if (observed !== undefined && observed - started <= 30 * 60_000) interval(state, started, observed, String(row.id), 1)
          } else interval(state, row.started, row.completed, String(row.id))
        }
      }
    }
    file.dbOffset = (file.dbOffset ?? 0) + rows.length
    file.offset = rows.length < PAGE ? file.size : 0
  } finally { db.close() }
}

/** Include archived sessions and subagents in a discovered OpenCode database. */
export function expandOpenCodeTimingSources(source: SessionSource): SessionSource[] {
  const path = source.path.slice(0, source.path.lastIndexOf(':'))
  const db = openDatabase(path)
  try {
    return db.query('SELECT id, directory FROM session LIMIT 20000').map(row => ({
      provider: 'opencode', path: `${path}:${String(row.id)}`,
      project: typeof row.directory === 'string' ? row.directory.replace(/^\//, '').replace(/\//g, '-') : source.project,
    }))
  } finally { db.close() }
}
