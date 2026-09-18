import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, rm, stat, utimes, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCodexProvider } from '../src/providers/codex.js'
import { clearDiscoveryCache } from '../src/discovery-cache.js'
import { withScanBudget } from '../src/resource-budget.js'

/**
 * Codex embeds the full instruction blob in session_meta, so a discovery header
 * averages ~63 KiB across ~5,000 files — 311 MiB of the 1 GiB scan budget, charged
 * every 30 seconds before any date filter runs. These tests pin the two halves of
 * the fix: an unchanged file costs nothing, and any change at all costs a re-read.
 */

const HEADER_BYTES = 512 * 1024

let codexDir: string
let cacheDir: string
let previousCacheDir: string | undefined

function header(cwd: string, pad = 'x'): string {
  const entry = { type: 'session_meta', payload: { originator: 'codex_cli_rs', cwd, instructions: '' } }
  const skeleton = JSON.stringify(entry)
  return JSON.stringify({ ...entry, payload: { ...entry.payload, instructions: pad.repeat(HEADER_BYTES - skeleton.length) } })
}

async function writeSession(name: string, cwd: string, pad = 'x'): Promise<string> {
  const day = join(codexDir, 'sessions/2026/09/10')
  await mkdir(day, { recursive: true })
  const path = join(day, `rollout-${name}.jsonl`)
  await writeFile(path, header(cwd, pad) + '\nbody\n')
  return path
}

/** Counts FileHandle.read() calls, the syscall discovery is trying to avoid. */
async function countingReads<T>(fn: () => Promise<T>): Promise<{ result: T; reads: number }> {
  const handle = await open(join(codexDir, 'probe'), 'w')
  const spy = vi.spyOn(Object.getPrototypeOf(handle) as { read: unknown }, 'read')
  try {
    const result = await fn()
    return { result, reads: spy.mock.calls.length }
  } finally {
    spy.mockRestore()
    await handle.close()
    await unlink(join(codexDir, 'probe')).catch(() => {})
  }
}

async function discover() {
  clearDiscoveryCache()
  return createCodexProvider(codexDir).discoverSessions()
}

beforeEach(async () => {
  codexDir = await mkdtemp(join(tmpdir(), 'watcher-codexdir-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'watcher-cachedir-'))
  previousCacheDir = process.env['EXE_WATCHER_CACHE_DIR']
  process.env['EXE_WATCHER_CACHE_DIR'] = cacheDir
  clearDiscoveryCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  clearDiscoveryCache()
  if (previousCacheDir === undefined) delete process.env['EXE_WATCHER_CACHE_DIR']
  else process.env['EXE_WATCHER_CACHE_DIR'] = previousCacheDir
  await rm(codexDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

it('re-reads no header when the corpus is unchanged', async () => {
  await writeSession('a', '/work/alpha')
  await writeSession('b', '/work/beta')
  await writeSession('c', '/work/gamma')

  const cold = await countingReads(discover)
  expect(cold.result).toHaveLength(3)
  expect(cold.reads).toBeGreaterThanOrEqual(3)

  const warm = await countingReads(discover)
  expect(warm.reads).toBe(0)
  expect(warm.result).toEqual(cold.result)
})

it('charges a second scan a small fraction of one header', async () => {
  await writeSession('a', '/work/alpha')
  await writeSession('b', '/work/beta')
  await writeSession('c', '/work/gamma')

  // Cold: three 512 KiB headers cannot fit in a 64 KiB budget.
  await expect(withScanBudget(discover, 200_000, undefined, 64 * 1024)).rejects.toThrow(/Resource limit reached/)

  // Bank the headers without a budget, the way a full-budget refresh would.
  expect(await discover()).toHaveLength(3)

  // Warm: the whole of discovery now fits in that same 64 KiB, against 1.5 MiB of headers.
  const warm = await withScanBudget(discover, 200_000, undefined, 64 * 1024)
  expect(warm).toHaveLength(3)
})

it.each([
  ['appended to', async (path: string) => { await writeFile(path, 'more\n', { flag: 'a' }) }],
  ['truncated with its mtime restored', async (path: string) => {
    const before = await stat(path)
    const handle = await open(path, 'r+')
    try { await handle.truncate(HEADER_BYTES / 2) } finally { await handle.close() }
    await utimes(path, before.atime, before.mtime)
  }],
  ['rewritten in place at the same size and mtime', async (path: string) => {
    const before = await stat(path)
    await writeFile(path, header('/work/moved', 'y') + '\nbody\n')
    await utimes(path, before.atime, before.mtime)
  }],
  ['replaced by a new inode at the same path, size and mtime', async (path: string) => {
    const before = await stat(path)
    await unlink(path)
    await writeFile(path, header('/work/moved', 'y') + '\nbody\n')
    await utimes(path, before.atime, before.mtime)
  }],
])('re-reads a file that was %s', async (_label, mutate) => {
  const path = await writeSession('a', '/work/alpha')
  expect(await discover()).toEqual([{ path, project: 'work-alpha', provider: 'codex' }])
  expect((await countingReads(discover)).reads).toBe(0)

  await mutate(path)

  const after = await countingReads(discover)
  expect(after.reads).toBeGreaterThanOrEqual(1)
})

it('serves the new project after a file is replaced, never the stale one', async () => {
  const path = await writeSession('a', '/work/alpha')
  expect(await discover()).toEqual([{ path, project: 'work-alpha', provider: 'codex' }])

  const before = await stat(path)
  await unlink(path)
  await writeFile(path, header('/work/omega', 'y') + '\nbody\n')
  await utimes(path, before.atime, before.mtime)

  expect(await discover()).toEqual([{ path, project: 'work-omega', provider: 'codex' }])
})

it('caches the rejection of a non-codex file', async () => {
  const day = join(codexDir, 'sessions/2026/09/10')
  await mkdir(day, { recursive: true })
  await writeFile(join(day, 'rollout-other.jsonl'), JSON.stringify({ type: 'session_meta', payload: { originator: 'something-else' } }) + '\n')

  expect(await discover()).toEqual([])
  const warm = await countingReads(discover)
  expect(warm.reads).toBe(0)
  expect(warm.result).toEqual([])
})

it('does not memoize a header read while the file was still being written', async () => {
  const path = await writeSession('a', '/work/alpha')
  const handle = await open(join(codexDir, 'probe2'), 'w')
  const proto = Object.getPrototypeOf(handle) as { read: (...args: unknown[]) => Promise<unknown> }
  const original = proto.read
  // Append between the header read and the post-read fingerprint check.
  const spy = vi.spyOn(proto, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const out = await original.apply(this, args)
    await writeFile(path, 'late\n', { flag: 'a' })
    return out
  })
  try { await discover() } finally { spy.mockRestore(); await handle.close() }

  // The entry must not have been banked against the pre-append fingerprint.
  expect((await countingReads(discover)).reads).toBeGreaterThanOrEqual(1)
})
