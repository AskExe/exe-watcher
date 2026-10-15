import { openDatabase } from './sqlite.js'
import { chargeRecord } from './resource-budget.js'
import { timestamp, type TimeFile, type TimeState } from './time-tracking.js'
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
function interval(state: TimeState, startValue: unknown, endValue: unknown): void {
  const start = timestamp(startValue), end = timestamp(endValue)
  state.observed++
  if (start !== undefined && end !== undefined && end > start && end - start <= 31 * 86_400_000) state.ai.push([start, end, 0])
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
        json_extract(value, '$.timingInfo.clientStartTime') AS started,
        COALESCE(json_extract(value, '$.timingInfo.clientEndTime'), json_extract(value, '$.timingInfo.clientSettleTime')) AS completed
        FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid LIMIT ? OFFSET ?`, [PAGE, file.dbOffset ?? 0])
      for (const row of rows) {
        chargeRecord()
        const conversation = typeof row.conversation === 'string' ? row.conversation : String(row.key).split(':')[1]
        interval(stateFor(file, `cursor:${conversation}`), row.started, row.completed)
      }
    } else {
      rows = db.query(`SELECT id,
        json_extract(data, '$.role') AS role,
        COALESCE(json_extract(data, '$.time.created'), time_created) AS started,
        json_extract(data, '$.time.completed') AS completed
        FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ? OFFSET ?`, [source.path.slice(separator + 1), PAGE, file.dbOffset ?? 0])
      const state = stateFor(file, `opencode:${source.path.slice(separator + 1)}`)
      for (const row of rows) {
        chargeRecord()
        if (row.role === 'assistant') interval(state, row.started, row.completed)
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
