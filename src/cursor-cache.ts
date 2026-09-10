import { readFile, mkdir, stat, rename } from 'fs/promises'
import { open } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { getPricingFingerprint } from './models.js'
import { chargeRead, ResourceBudgetError } from './resource-budget.js'

import { getCacheDir } from './cache-dir.js'
import type { ParsedProviderCall } from './providers/types.js'

type ResultCache = {
  fingerprint: string
  calls: ParsedProviderCall[]
}

const CACHE_FILE = 'cursor-results.json'

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

export async function getDbFingerprint(dbPath: string): Promise<string | null> {
  try {
    const s = await stat(dbPath)
    const wal = await stat(`${dbPath}-wal`).catch(() => null)
    return [dbPath, s.dev, s.ino, s.ctimeMs, s.mtimeMs, s.size, wal?.ino, wal?.ctimeMs, wal?.mtimeMs, wal?.size, getPricingFingerprint()].join(':')
  } catch { return null }
}

export async function readCachedResults(dbPath: string): Promise<ParsedProviderCall[] | null> {
  try {
    const fp = await getDbFingerprint(dbPath)
    if (!fp) return null

    const size = (await stat(getCachePath())).size
    if (size > 16 * 1024 * 1024) return null
    chargeRead(size)
    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache

    if (cache.fingerprint === fp) {
      return cache.calls
    }
    return null
  } catch (err) {
    if (err instanceof ResourceBudgetError) throw err
    return null
  }
}

export async function writeCachedResults(dbPath: string, calls: ParsedProviderCall[], expected?: string | null): Promise<void> {
  try {
    const fp = await getDbFingerprint(dbPath)
    if (!fp || (expected !== undefined && expected !== fp)) return

    const dir = getCacheDir()
    await mkdir(dir, { recursive: true })
    const cache: ResultCache = {
      fingerprint: fp,
      calls,
    }
    const payload = JSON.stringify(cache)
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) return
    const finalPath = getCachePath()
    const tmpPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(tmpPath, 'w', 0o600)
    try {
      await handle.writeFile(payload, { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, finalPath)
  } catch {}
}
