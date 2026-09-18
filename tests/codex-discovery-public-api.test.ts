// The discovery-header cache, asserted through the provider's PUBLIC API only — no
// import of the cache module itself. Written this way deliberately: the file runs
// unmodified against the pre-cache tree, where both assertions fail (27 header reads,
// and a blown budget), so it is a real regression test rather than a tautology, and it
// survives any refactor of where the cache lives.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCodexProvider } from '../src/providers/codex.js'
import { withScanBudget } from '../src/resource-budget.js'

const HEADER_BYTES = 512 * 1024

let codexDir: string
let cacheDir: string

function header(cwd: string): string {
  const entry = { type: 'session_meta', payload: { originator: 'codex_cli_rs', cwd, instructions: '' } }
  const skeleton = JSON.stringify(entry)
  return JSON.stringify({ ...entry, payload: { ...entry.payload, instructions: 'x'.repeat(HEADER_BYTES - skeleton.length) } })
}

async function writeSession(name: string, cwd: string): Promise<void> {
  const day = join(codexDir, 'sessions/2026/09/10')
  await mkdir(day, { recursive: true })
  await writeFile(join(day, `rollout-${name}.jsonl`), header(cwd) + '\nbody\n')
}

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

beforeEach(async () => {
  codexDir = await mkdtemp(join(tmpdir(), 'watcher-red-codex-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'watcher-red-cache-'))
  process.env['EXE_WATCHER_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env['EXE_WATCHER_CACHE_DIR']
  await rm(codexDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

it('reads no headers on a second scan over an unchanged corpus', async () => {
  await writeSession('a', '/work/alpha')
  await writeSession('b', '/work/beta')
  await writeSession('c', '/work/gamma')
  const provider = createCodexProvider(codexDir)

  const cold = await countingReads(() => provider.discoverSessions())
  expect(cold.result).toHaveLength(3)

  const warm = await countingReads(() => provider.discoverSessions())
  expect(warm.reads).toBe(0)
})

it('fits a second scan in a budget far smaller than one header', async () => {
  await writeSession('a', '/work/alpha')
  await writeSession('b', '/work/beta')
  await writeSession('c', '/work/gamma')
  const provider = createCodexProvider(codexDir)

  expect(await provider.discoverSessions()).toHaveLength(3)

  const warm = await withScanBudget(() => provider.discoverSessions(), 200_000, undefined, 64 * 1024)
  expect(warm).toHaveLength(3)
})
