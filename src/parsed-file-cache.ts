import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile, rename, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getCacheDir } from './cache-dir.js'
import { getPricingFingerprint } from './models.js'
import { chargeRead, ResourceBudgetError } from './resource-budget.js'
import { acquireFileLock } from './file-lock.js'

const VERSION = 3
const compress = promisify(gzip)
const decompress = promisify(gunzip)
const MAX_ENTRY = 16 * 1024 * 1024
const MAX_DISK = 256 * 1024 * 1024
let maintainedDir = ''

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
export async function cachedFileParse<T>(path: string, kind: string, parse: () => Promise<T[]>, warnings?: string[]): Promise<T[]> {
  const dir = join(getCacheDir(), 'parsed-files')
  const key = createHash('sha256').update(`${VERSION}:${kind}:${path}:${getPricingFingerprint()}`).digest('hex')
  const cachePath = join(dir, `v${VERSION}-${key}.json.gz`)
  const fingerprintPath = kind === 'opencode' ? path.slice(0, path.lastIndexOf(':')) : path
  const before = await fingerprint(fingerprintPath)
  if (before) {
    try {
      const s = await stat(cachePath)
      if (s.size <= MAX_ENTRY) {
        chargeRead(s.size)
        const saved = JSON.parse((await decompress(await readFile(cachePath), { maxOutputLength: MAX_ENTRY })).toString('utf8'))
        if (saved.v === VERSION && saved.fingerprint === before && Array.isArray(saved.data)) {
          if (Array.isArray(saved.warnings)) warnings?.push(...saved.warnings.filter((w: unknown) => typeof w === 'string'))
          return saved.data as T[]
        }
      }
    } catch (err) { if (err instanceof ResourceBudgetError) throw err }
  }
  const data = await parse()
  if (!before || await fingerprint(fingerprintPath) !== before) return data
  // No cache can describe a moving snapshot as current. Stable files only; appends
  // invalidate by size/mtime/ctime and preserve incomplete final lines for reparse.
  const payload = JSON.stringify({ v: VERSION, fingerprint: before, data, warnings })
  if (Buffer.byteLength(payload) > MAX_ENTRY) return data
  await mkdir(dir, { recursive: true })
  const encoded = await compress(Buffer.from(payload))
  const release = await acquireFileLock(join(dir, 'writes.lock'))
  try {
    const quotaPath = join(dir, 'quota')
    if (maintainedDir !== dir) {
      const files = await readdir(dir)
      const rows = []
      for (const name of files) {
        if (!name.endsWith('.json') && !name.endsWith('.json.gz') && !name.endsWith('.tmp')) continue
        // Obsolete parser versions can never be replayed; reclaim their quota.
        if (!name.startsWith(`v${VERSION}-`)) { await unlink(join(dir, name)).catch(() => {}); continue }
        const p = join(dir, name), s = await stat(p).catch(() => null)
        if (s) rows.push({ path: p, size: s.size, mtime: s.mtimeMs })
      }
      let total = rows.reduce((n, r) => n + r.size, 0)
      for (const row of rows.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= MAX_DISK) break
        await unlink(row.path).catch(() => {})
        total -= row.size
      }
      await writeFile(quotaPath, String(total), { mode: 0o600 })
      maintainedDir = dir
    }
    // Concurrent readers/writers never see partial JSON; identical results incur no rewrite.
    if (!(await readFile(cachePath).catch(() => Buffer.alloc(0))).equals(encoded)) {
      const total = Number(await readFile(quotaPath, 'utf8').catch(() => String(MAX_DISK)))
      const oldSize = (await stat(cachePath).catch(() => null))?.size ?? 0
      let nextSize = total - oldSize + encoded.length
      if (!Number.isFinite(nextSize)) return data
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
        if (nextSize > MAX_DISK) return data
      }
      const tmp = `${cachePath}.${randomUUID()}.tmp`
      try {
        // Reserve before writing: a crash can over-count disk use, never under-count it.
        await writeFile(quotaPath, String(nextSize), { mode: 0o600 })
        await writeFile(tmp, encoded, { mode: 0o600 }); await rename(tmp, cachePath)
      }
      finally { await unlink(tmp).catch(() => {}) }
    }
  } finally { await release() }
  return data
}
