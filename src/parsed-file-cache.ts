import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile, rename, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getCacheDir } from './cache-dir.js'
import { getPricingFingerprint } from './models.js'
import { chargeRead, ResourceBudgetError } from './resource-budget.js'
import { acquireFileLock } from './file-lock.js'
import { readDiscoveryFact, rememberDiscoveryFact } from './discovery-cache.js'
import type { DateRange } from './types.js'
import { lockRecordedCosts } from './recorded-costs.js'

const VERSION = 4
const compress = promisify(gzip)
const decompress = promisify(gunzip)
const MAX_ENTRY = 16 * 1024 * 1024
const MAX_DISK = 256 * 1024 * 1024
let mutationCount = 0
export const parsedFileProgress = () => mutationCount

export type FileParseProgress = {
  load<T>(valid: (value: unknown) => value is T): Promise<{ offset: number; state: T } | undefined>
  save(state: unknown, offset: number): Promise<void>
}

/** Bound serialization itself, including checkpoints, before building a large
 * string alongside the live parser state. Array index overhead is conservative. */
function encodeEntry(value: unknown): string | undefined {
  let bytes = 0
  try {
    return JSON.stringify(value, (key, item) => {
      bytes += key ? Buffer.byteLength(JSON.stringify(key)) + 2 : 0
      bytes += item && typeof item === 'object' ? 2 : Buffer.byteLength(JSON.stringify(item) ?? 'null')
      if (bytes > MAX_ENTRY) throw new Error('parsed entry limit')
      return item
    })
  } catch { return undefined }
}

function fileProgress(path: string, dir: string, cachePath: string, before: string | null): FileParseProgress {
  let startingOffset = 0
  return {
    async load<T>(valid: (value: unknown) => value is T) {
      if (!before) return
      try {
        const size = (await stat(cachePath)).size
        if (size > MAX_ENTRY) return
        chargeRead(size)
        const saved = JSON.parse((await decompress(await readFile(cachePath), { maxOutputLength: MAX_ENTRY })).toString('utf8'))
        if (saved.v !== VERSION || saved.fingerprint !== before || !Number.isSafeInteger(saved.offset) ||
            saved.offset <= 0 || saved.offset > Number(before.split(':')[2]) || !valid(saved.state)) return
        startingOffset = saved.offset
        return { offset: saved.offset as number, state: saved.state as T }
      } catch (error) { if (error instanceof ResourceBudgetError) throw error }
    },
    async save(state, offset) {
      // Do not claim progress on an unfinished line, a moving/replaced snapshot,
      // or an unchanged cursor. Completed files and checkpoints share one quota.
      if (!before || offset <= startingOffset || offset > Number(before.split(':')[2]) || await fingerprint(path) !== before) return
      // Appends, truncation and replacements all invalidate a checkpoint. Never
      // reuse partial state unless it describes this exact source snapshot.
      const payload = encodeEntry({ v: VERSION, fingerprint: before, offset, state })
      if (payload) await storeParsedEntry(dir, cachePath, payload)
    },
  }
}

async function fingerprint(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    const wal = await stat(`${path}-wal`).catch(() => null)
    return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, wal?.size, wal?.mtimeMs].join(':')
  } catch { return null }
}

/** Durable, versioned per-file parsed results. Date filtering and cross-file dedup
 * happen after replay. Changed/truncated/replaced files are reparsed from a fixed snapshot.
 */
export async function cachedFileParse<T>(path: string, kind: string, parse: (progress: FileParseProgress) => Promise<T[]>, warnings?: string[], range?: DateRange): Promise<T[]> {
  const dir = join(getCacheDir(), 'parsed-files')
  const key = createHash('sha256').update(`${VERSION}:${kind}:${path}`).digest('hex')
  const cachePath = join(dir, `v${VERSION}-${key}.json.gz`)
  const progressPath = join(dir, `v${VERSION}-progress-${key}.json.gz`)
  const legacyKey = createHash('sha256').update(`3:${kind}:${path}:${getPricingFingerprint()}`).digest('hex')
  const legacyPath = join(dir, `v3-${legacyKey}.json.gz`)
  const fingerprintPath = kind === 'opencode' ? path.slice(0, path.lastIndexOf(':')) : path
  const before = await fingerprint(fingerprintPath)
  const rangeKind = `usage-range:3:${kind}` // Existing verified date bounds do not depend on prices.
  const bounds = range && before
    ? await readDiscoveryFact<{ first: number; last: number; warnings?: string[] }>(rangeKind, path, before) : undefined
  if (range && bounds && (bounds.last < range.start.getTime() || bounds.first > range.end.getTime())) {
    if (Array.isArray(bounds.warnings)) warnings?.push(...bounds.warnings)
    return []
  }
  const rememberRange = async (data: T[]) => {
    if (!range || !before || bounds || await fingerprint(fingerprintPath) !== before) return
    let first = Infinity, last = -Infinity
    for (const row of data) {
      const timestamp = (row as { timestamp?: unknown } | null)?.timestamp
      const value = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
      // Unknown timestamps cannot prove that the entire file is outside a window.
      if (!Number.isFinite(value)) return
      first = Math.min(first, value); last = Math.max(last, value)
    }
    // Empty files have no billable records in any window. JSON cannot store Infinity.
    await rememberDiscoveryFact(rangeKind, path, before, { first: data.length ? first : 0, last: data.length ? last : -1, warnings })
  }
  let migrated: T[] | undefined
  if (before) {
    for (const candidate of [cachePath, legacyPath]) {
      try {
        const s = await stat(candidate)
        if (s.size <= MAX_ENTRY) {
          chargeRead(s.size)
          const saved = JSON.parse((await decompress(await readFile(candidate), { maxOutputLength: MAX_ENTRY })).toString('utf8'))
          if ((saved.v === VERSION || saved.v === 3) && saved.fingerprint === before && Array.isArray(saved.data)) {
            if (Array.isArray(saved.warnings)) warnings?.push(...saved.warnings.filter((w: unknown) => typeof w === 'string'))
            await rememberRange(saved.data)
            if (saved.v === VERSION && saved.pricesLocked === true) {
              if (!saved.hasUnpricedUsage || saved.pricingFingerprint === getPricingFingerprint()) return saved.data as T[]
              continue // Only previously unknown prices need another parse.
            }
            migrated = saved.data as T[]
            break
          }
        }
      } catch (err) { if (err instanceof ResourceBudgetError) throw err }
    }
  }
  const data = migrated ?? await parse(fileProgress(fingerprintPath, dir, progressPath, before))
  const hasUnpricedUsage = lockRecordedCosts(data)
  if (!before || await fingerprint(fingerprintPath) !== before) return data
  await rememberRange(data)
  // No cache can describe a moving snapshot as current. Stable files only; appends
  // invalidate by size/mtime/ctime and preserve incomplete final lines for reparse.
  const payload = encodeEntry({ v: VERSION, fingerprint: before, data, warnings, pricesLocked: true,
    hasUnpricedUsage, pricingFingerprint: getPricingFingerprint() })
  if (payload) await storeParsedEntry(dir, cachePath, payload, progressPath)
  return data
}

async function storeParsedEntry(dir: string, cachePath: string, payload: string, obsolete?: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const encoded = await compress(Buffer.from(payload))
  const release = await acquireFileLock(join(dir, 'writes.lock'))
  try {
    const quotaPath = join(dir, 'quota')
    // Writers reserve quota under this lock before publishing each entry. Reuse
    // that ledger across CLI launches instead of stat'ing every cached file on
    // the first changed session of every scan (tens of thousands on large homes).
    const quota = await readFile(quotaPath, 'utf8').catch(() => '')
    let total = /^\d+$/.test(quota) ? Number(quota) : NaN
    const writeQuota = async (bytes: number) => {
      const tmp = `${quotaPath}.${randomUUID()}.tmp`
      try {
        await writeFile(tmp, String(bytes), { mode: 0o600 })
        await rename(tmp, quotaPath)
      } finally { await unlink(tmp).catch(() => {}) }
    }
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_DISK) {
      const files = await readdir(dir)
      const rows = []
      for (const name of files) {
        if (!name.endsWith('.json') && !name.endsWith('.json.gz') && !name.endsWith('.tmp')) continue
        // Obsolete parser versions can never be replayed; reclaim their quota.
        if (!name.startsWith(`v${VERSION}-`) && !name.startsWith('v3-')) { await unlink(join(dir, name)).catch(() => {}); continue }
        const p = join(dir, name), s = await stat(p).catch(() => null)
        if (s) rows.push({ path: p, size: s.size, mtime: s.mtimeMs })
      }
      total = rows.reduce((n, r) => n + r.size, 0)
      for (const row of rows.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= MAX_DISK) break
        await unlink(row.path).catch(() => {})
        total -= row.size
      }
      await writeQuota(total)
    }
    // Concurrent readers/writers never see partial JSON; identical results incur no rewrite.
    if (!(await readFile(cachePath).catch(() => Buffer.alloc(0))).equals(encoded)) {
      const oldSize = (await stat(cachePath).catch(() => null))?.size ?? 0
      // Reserve both the existing entry and its replacement until rename succeeds.
      // A crash while a smaller replacement is pending must never under-count disk use.
      let nextSize = total + encoded.length
      if (!Number.isFinite(nextSize)) return
      if (nextSize > MAX_DISK) {
        // Make room in batches so reaching the cap never disables future caching.
        const rows = []
        for (const name of await readdir(dir)) {
          if (!name.endsWith('.json.gz')) continue
          const p = join(dir, name)
          if (p === cachePath) continue
          const s = await stat(p).catch(() => null)
          if (s) rows.push({ path: p, size: s.size, mtime: s.mtimeMs })
        }
        for (const row of rows.sort((a, b) => a.mtime - b.mtime)) {
          if (nextSize <= MAX_DISK * 0.75) break
          await unlink(row.path).catch(() => {})
          nextSize -= row.size
        }
        if (nextSize > MAX_DISK) return
      }
      const tmp = `${cachePath}.${randomUUID()}.tmp`
      try {
        // Reserve before writing: a crash can over-count disk use, never under-count it.
        await writeQuota(nextSize)
        await writeFile(tmp, encoded, { mode: 0o600 }); await rename(tmp, cachePath)
        mutationCount++
        if (oldSize) await writeQuota(nextSize - oldSize)
        total = nextSize - oldSize
      }
      finally { await unlink(tmp).catch(() => {}) }
    }
    if (obsolete) {
      const size = (await stat(obsolete).catch(() => null))?.size ?? 0
      if (size) { await unlink(obsolete); await writeQuota(Math.max(0, total - size)) }
    }
  } finally { await release() }
}
