import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { getCacheDir } from './cache-dir.js'
import { acquireFileLock } from './file-lock.js'
import { chargeRead, chargeRecord, withScanBudget } from './resource-budget.js'
import { observeTime, summarizeTime, TIME_HISTORY_START, unionIntervals, type TimeFile, type TimeIndex, type TimeReport } from './time-tracking.js'
import type { SessionSource } from './providers/types.js'
import type { DateRange } from './types.js'
import { expandOpenCodeTimingSources, scanTimeDatabase } from './time-sqlite.js'

const compress = promisify(gzip), decompress = promisify(gunzip)
const MAX_INDEX = 32 * 1024 ** 2, MAX_DISK = 16 * 1024 ** 2, MAX_FILES = 20_000
const BLOCK = 2 * 1024 ** 2
const indexPath = () => join(getCacheDir(), 'time-index-v1.json.gz')
const empty = (): TimeIndex => ({ version: 1, files: Object.create(null), updatedAt: new Date().toISOString(), warnings: [] })

export async function readTimeIndex(): Promise<TimeIndex> {
  try {
    if ((await stat(indexPath())).size > MAX_DISK) throw new Error('Timing index exceeds its disk limit')
    const value = JSON.parse((await decompress(await readFile(indexPath()), { maxOutputLength: MAX_INDEX })).toString('utf8'))
    if (value.version !== 1 || !value.files || typeof value.files !== 'object' || Object.keys(value.files).length > MAX_FILES) throw new Error('Invalid timing index')
    for (const row of Object.values(value.files) as TimeFile[]) {
      if (!row?.state || !Array.isArray(row.state.ai) || !Array.isArray(row.state.user) || typeof row.state.agent !== 'string' || !Number.isSafeInteger(row.offset) || row.offset < 0) throw new Error('Invalid timing entry')
    }
    return value as TimeIndex
  } catch (error) {
    const result = empty()
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.warnings.push('Saved timing index could not be read; timing coverage is unknown until recovered.')
    return result
  }
}

async function save(index: TimeIndex): Promise<void> {
  const data = JSON.stringify(index)
  if (Buffer.byteLength(data) > MAX_INDEX) throw new Error('Timing index reached its 32 MiB memory/disk snapshot limit; use a narrower history range.')
  const encoded = await compress(Buffer.from(data))
  if (encoded.length > MAX_DISK) throw new Error('Timing index reached its 16 MiB compressed disk limit.')
  const path = indexPath(), temp = `${path}.${randomUUID()}.tmp`
  await mkdir(getCacheDir(), { recursive: true })
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}

async function expandSources(sources: SessionSource[]): Promise<SessionSource[]> {
  const out: SessionSource[] = []
  const databases = new Set<string>()
  for (const source of sources) {
    chargeRead(0)
    if (source.provider === 'opencode') {
      const path = source.path.slice(0, source.path.lastIndexOf(':'))
      if (!databases.has(path)) { out.push(...expandOpenCodeTimingSources(source)); databases.add(path) }
      continue
    }
    if (source.provider !== 'claude') { out.push(source); continue }
    for (const entry of await readdir(source.path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push({ ...source, path: join(source.path, entry.name) })
      else if (entry.isDirectory()) {
        const folder = join(source.path, entry.name, 'subagents')
        for (const agent of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
          if (agent.isFile() && agent.name.endsWith('.jsonl')) out.push({ ...source, path: join(folder, agent.name) })
        }
      }
    }
  }
  return [...new Map(out.map(x => [`${x.provider}:${x.path}`, x])).values()]
}

async function anchor(path: string, offset: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(256, offset)), tail = Buffer.alloc(Math.min(256, offset))
    await handle.read(head, 0, head.length, 0)
    await handle.read(tail, 0, tail.length, Math.max(0, offset - tail.length))
    chargeRead(head.length + tail.length)
    return createHash('sha256').update(head).update(tail).digest('hex')
  } finally { await handle.close() }
}
function fresh(source: SessionSource, identity: string, size: number, mtime: number, ctime: number): TimeFile {
  const child = source.path.includes('/subagents/') || basename(source.path).startsWith('agent-')
  const agent = source.provider === 'copilot' ? basename(dirname(source.path))
    : source.provider === 'kimi' ? `${basename(dirname(dirname(source.path)))}/${basename(dirname(source.path))}`
    : `${child ? basename(dirname(dirname(source.path))) + '/' : ''}${basename(source.path, '.jsonl')}`
  return { provider: source.provider, project: source.project, identity, size, mtime, ctime, offset: 0, anchor: '',
    state: { agent: `${source.provider}:${agent}`, child, ai: [], user: [], observed: 0, dropped: 0 } }
}

/** One fixed-size snapshot block. Complete-line cursors survive an interrupted backfill.
 * Incomplete final JSON waits for its append; oversize records are skipped explicitly.
 */
async function scanBlock(source: SessionSource, row: TimeFile): Promise<void> {
  const handle = await open(source.path, 'r')
  let consumed = 0
  try {
    const length = Math.min(BLOCK, row.size - row.offset)
    chargeRead(length)
    const allocated = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(allocated, 0, length, row.offset)
    const buffer = allocated.subarray(0, bytesRead)
    let start = 0
    for (;;) {
      const newline = buffer.indexOf(10, start)
      const atEnd = newline < 0
      const end = atEnd ? bytesRead : newline
      if (end > bytesRead) break
      if (row.discarding) {
        consumed = atEnd ? bytesRead : end + 1
        if (!atEnd) row.discarding = false
      } else {
        const line = buffer.toString('utf8', start, end).trim()
        chargeRecord()
        if (line) {
          try {
            const entry = JSON.parse(line)
            observeTime(source.provider, row.state, entry)
          } catch {
            if (atEnd && row.offset + bytesRead >= row.size) break
            if (!atEnd) row.state.dropped++
            else { row.discarding = true; row.state.dropped++ }
          }
        }
        consumed = atEnd ? bytesRead : end + 1
      }
      if (atEnd) break
      start = end + 1
      if (start >= bytesRead) break
    }
  } finally {
    row.offset += consumed
    try { if (consumed) row.anchor = await anchor(source.path, row.offset) }
    finally { await handle.close() }
  }
}

export type TimeRefreshOptions = { history?: boolean; signal?: AbortSignal; sources?: SessionSource[] }
/** Automatic work is capped at 16 MiB / ~0.75s, manual history at 256 MiB / 15s.
 * No timer or daemon: callers already react to client usage-file changes.
 */
export async function refreshTimeIndex(options: TimeRefreshOptions = {}): Promise<TimeIndex> {
  const index = await readTimeIndex()
  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireFileLock(join(getCacheDir(), 'time-index.lock'), 100)
  } catch { index.warnings.push('Another timing update is running; showing the saved timing snapshot.'); return index }
  // Re-read under the lease so concurrent manual recovery cannot be overwritten.
  let current = await readTimeIndex()
  current.warnings = []
  let changed = false
  try {
    await withScanBudget(async () => {
      const sources = options.sources ?? await (await import('./parser.js')).getDiscoveredSources()
      const expanded = await expandSources(sources)
      const candidates = []
      let fileCount = Object.keys(current.files).length
      for (const source of expanded) {
        chargeRead(0)
        const database = source.provider === 'opencode' ? source.path.slice(0, source.path.lastIndexOf(':')) : source.path
        const s = await stat(database).catch(() => null)
        if (!s) continue
        const wal = ['cursor', 'opencode'].includes(source.provider) ? await stat(database + '-wal').catch(() => null) : null
        candidates.push({ source, s, wal })
      }
      // Recent clients become useful first; pending historical files still advance on recovery.
      candidates.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs || a.source.path.localeCompare(b.source.path))
      const deadline = Date.now() + (options.history ? 15_000 : 750)
      // Even unvisited files must be visible as pending, not successful zeroes.
      for (const { source, s, wal } of candidates) {
        const key = createHash('sha256').update(`${source.provider}:${source.path}`).digest('hex')
        if (!current.files[key] && fileCount < MAX_FILES) {
          current.files[key] = fresh(source, `${s.dev}:${s.ino}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`, s.size, s.mtimeMs, s.ctimeMs)
          changed = true; fileCount++
        } else if (current.files[key] && (current.files[key]!.size !== s.size || current.files[key]!.mtime !== s.mtimeMs || current.files[key]!.ctime !== s.ctimeMs)) {
          current.files[key]!.unavailable = true; changed = true
        }
      }
      for (const { source, s, wal } of candidates) {
        chargeRead(0)
        const key = createHash('sha256').update(`${source.provider}:${source.path}`).digest('hex')
        const identity = `${s.dev}:${s.ino}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`
        let row = current.files[key]
        if (row && row.identity === identity && row.size === s.size && row.mtime === s.mtimeMs && row.ctime === s.ctimeMs && row.offset >= row.size) continue
        if (Date.now() >= deadline) break
        if (!row && fileCount >= MAX_FILES) { current.warnings.push('Timing file limit reached; additional files remain unknown.'); break }
        // A shrink, replacement, or rewrite invalidates timings from that snapshot.
        // Appends must preserve both the header and the prior cursor boundary.
        const appended = row && row.identity === identity && s.size > row.size && row.offset > 0
          && row.anchor === await anchor(source.path, row.offset)
        const unchangedPartial = row && row.identity === identity && s.size === row.size && row.mtime === s.mtimeMs && row.ctime === s.ctimeMs
        if (!row) fileCount++
        if (!row || (!appended && !unchangedPartial)) row = fresh(source, identity, s.size, s.mtimeMs, s.ctimeMs)
        row.size = s.size; row.mtime = s.mtimeMs; row.ctime = s.ctimeMs
        current.files[key] = row; changed = true
        try {
          if (source.provider === 'cursor' || source.provider === 'opencode') await scanTimeDatabase(source, row)
          else if (source.provider === 'cursor-agent' && !source.path.endsWith('.jsonl')) {
            // Saved Cursor Agent text transcripts have neither turn clocks nor durations.
            row.offset = row.size
          } else await scanBlock(source, row)
          row.state.ai = unionIntervals(row.state.ai)
          row.state.user = unionIntervals(row.state.user)
          row.unavailable = false
        } catch (error) {
          row.unavailable = true
          throw error
        }
      }

    }, options.history ? 2_000_000 : 200_000, options.signal, (options.history ? 256 : 16) * 1024 ** 2)
  } catch (error) {
    current.warnings = [`Timing update paused: ${error instanceof Error ? error.message : String(error)}`]
  } finally {
    if (changed) {
      current.updatedAt = new Date().toISOString()
      try { await save(current) } catch (error) { current.warnings.push(String(error)) }
    }
    await release()
  }
  return current
}

export async function getTimeReport(range: DateRange, provider = 'all', include?: string[], exclude?: string[], signal?: AbortSignal): Promise<TimeReport> {
  try { return summarizeTime(await refreshTimeIndex({ signal }), range, provider, include, exclude) }
  catch (error) {
    const index = await readTimeIndex()
    index.warnings.push(`Timing unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return summarizeTime(index, range, provider, include, exclude)
  }
}
