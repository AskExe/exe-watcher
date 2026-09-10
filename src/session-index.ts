import { stat } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
import { readFile, mkdir, rename, unlink, open } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { getCacheDir } from './cache-dir.js'
import type { DateRange, SessionSummary } from './types.js'

/**
 * Lightweight session file index. Stores per-file fingerprints (size + mtime)
 * and a flag indicating whether the file has API calls. Files flagged as empty
 * (h=0) are skipped entirely on subsequent invocations — this avoids reading
 * ~2,100 inactive session files on every 30s badge refresh.
 *
 * Files with data (h=1) are still fully parsed each time (only ~80 files).
 * The win comes from eliminating I/O on the ~97% of files that have no API calls.
 */

export const SESSION_INDEX_VERSION = 1
const INDEX_FILENAME = 'session-index.json'

type IndexEntry = {
  s: number  // sizeBytes
  m: number  // mtimeMs
  h: 0 | 1   // 0 = no API calls (skip), 1 = has data (parse)
}

type SessionIndex = {
  v: number  // version
  e: Record<string, IndexEntry>  // entries keyed by absolute path
}

let currentIndex: SessionIndex | null = null

function emptyIndex(): SessionIndex {
  return { v: SESSION_INDEX_VERSION, e: {} }
}

function indexPath(): string {
  return join(getCacheDir(), INDEX_FILENAME)
}

export async function loadSessionIndex(): Promise<SessionIndex> {
  if (currentIndex) return currentIndex
  try {
    const raw = await readFile(indexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as SessionIndex
    if (parsed.v !== SESSION_INDEX_VERSION) {
      currentIndex = emptyIndex()
      return currentIndex
    }
    currentIndex = parsed
    return currentIndex
  } catch {
    currentIndex = emptyIndex()
    return currentIndex
  }
}

export async function saveSessionIndex(index: SessionIndex): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const finalPath = indexPath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify(index)
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, finalPath)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* ignore */ }
    throw err
  }
  currentIndex = index
}

/**
 * Check if a session file can be skipped based on the index. Returns:
 * - 'skip': file is indexed as empty (h=0) and unchanged — caller should skip it entirely
 * - 'parse': file needs full parsing (new, changed, or has data)
 */
export async function checkSessionFile(
  filePath: string,
  index: SessionIndex,
  dateRange?: DateRange,
): Promise<'skip' | 'parse'> {
  const entry = index.e[filePath]
  if (!entry) return 'parse'

  let fileStat: { size: number; mtimeMs: number }
  try {
    fileStat = await stat(filePath)
  } catch {
    return 'parse'
  }

  // File changed since last index — needs re-parse
  if (fileStat.size !== entry.s || fileStat.mtimeMs !== entry.m) return 'parse'

  // File is unchanged and was previously found to have no API calls — skip
  if (entry.h === 0) return 'skip'

  // File has data — needs parsing (we don't cache summaries, too large)
  return 'parse'
}

/**
 * Record the result of parsing a file so future invocations can skip it.
 *
 * High-water mark: once a file is known to contain API calls (h=1), it is
 * never downgraded to h=0.  Active session files can change mid-scan, causing
 * a parse to return partial/empty data.  Downgrading would make the next run
 * skip the file entirely, dropping its cost from the total — the root cause
 * of the "costs drop $20 then reappear" bug.
 */
export function recordParseResult(
  filePath: string,
  index: SessionIndex,
  sizeBytes: number,
  mtimeMs: number,
  hasApiCalls: boolean,
): boolean {
  const prev = index.e[filePath]
  // Never downgrade h from 1 → 0: once we know a file has data, keep it.
  const h: 0 | 1 = hasApiCalls ? 1 : (prev?.h === 1 ? 1 : 0)
  if (prev?.s === sizeBytes && prev?.m === mtimeMs && prev?.h === h) return false
  index.e[filePath] = { s: sizeBytes, m: mtimeMs, h }
  return true
}

/** Remove entries for files no longer discovered. */
export function pruneIndex(index: SessionIndex, knownPaths: Set<string>): number {
  let pruned = 0
  for (const path of Object.keys(index.e)) {
    if (!knownPaths.has(path)) {
      delete index.e[path]
      pruned++
    }
  }
  return pruned
}

/** Clear the in-memory index and remove the on-disk file. Used by clearParserCaches(). */
export function clearSessionIndex(): void {
  currentIndex = null
  try { unlinkSync(indexPath()) } catch { /* ignore if missing */ }
}
