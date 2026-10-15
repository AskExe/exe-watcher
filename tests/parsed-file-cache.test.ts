import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedFileParse } from '../src/parsed-file-cache.js'
let dir = ''
afterEach(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }) })
it('compresses durable results and replays them without parsing again', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-parsed-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'fixture')
  const parse = vi.fn(async () => [{ outputTokens: 200, padding: 'same text '.repeat(1000) }])
  expect(await cachedFileParse(path, 'fixture', parse)).toEqual(await cachedFileParse(path, 'fixture', parse))
  expect(parse).toHaveBeenCalledTimes(1)
})
it('reclaims space instead of permanently refusing new results at the disk cap', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-quota-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'first.jsonl'); await writeFile(path, 'first')
  await cachedFileParse(path, 'fixture', async () => [1])
  const cacheDir = join(dir, 'parsed-files'); await mkdir(cacheDir, { recursive: true })
  const old = join(cacheDir, 'v3-old.json.gz')
  const handle = await open(old, 'w'); await handle.truncate(256 * 1024 ** 2); await handle.close()
  await writeFile(join(cacheDir, 'quota'), String(256 * 1024 ** 2))
  const second = join(dir, 'second.jsonl'); await writeFile(second, 'second')
  const parse = vi.fn(async () => [2])
  expect(await cachedFileParse(second, 'fixture', parse)).toEqual([2])
  expect(await cachedFileParse(second, 'fixture', parse)).toEqual([2])
  expect(parse).toHaveBeenCalledTimes(1)
  expect(Number(await readFile(join(cacheDir, 'quota'), 'utf8'))).toBeLessThan(256 * 1024 ** 2)
})

it('reuses the durable quota across launches instead of inventorying unchanged cache entries', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-warm-quota-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const cacheDir = join(dir, 'parsed-files'); await mkdir(cacheDir)
  // A prior process already accounted for this obsolete entry. It is harmless
  // until space is needed, so new parsing need not enumerate and stat it again.
  const old = join(cacheDir, 'v2-retained.json')
  await writeFile(old, '{}')
  await writeFile(join(cacheDir, 'quota'), '2')
  const path = join(dir, 'new.jsonl'); await writeFile(path, 'new')
  expect(await cachedFileParse(path, 'fixture', async () => [7])).toEqual([7])
  expect(await readFile(old, 'utf8')).toBe('{}')
  expect(Number(await readFile(join(cacheDir, 'quota'), 'utf8'))).toBeGreaterThan(2)
})

it.each(['', 'corrupt'])('repairs a %j quota ledger before trusting the disk budget', async quota => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-repair-quota-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const cacheDir = join(dir, 'parsed-files'); await mkdir(cacheDir)
  const retained = join(cacheDir, 'v3-existing.json.gz'); await writeFile(retained, 'retained bytes')
  await writeFile(join(cacheDir, 'quota'), quota)
  const path = join(dir, 'new.jsonl'); await writeFile(path, 'new')
  await cachedFileParse(path, 'fixture', async () => [7])
  expect(await readFile(retained, 'utf8')).toBe('retained bytes')
  expect(Number(await readFile(join(cacheDir, 'quota'), 'utf8'))).toBeGreaterThan(Buffer.byteLength('retained bytes'))
})

it('uses verified record timestamps to skip unrelated files even after pricing changes', async () => {
  const { clearDiscoveryCache, flushDiscoveryCache } = await import('../src/discovery-cache.js')
  const { setModelAliases } = await import('../src/models.js')
  dir = await mkdtemp(join(tmpdir(), 'watcher-usage-range-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'fixture')
  const parse = vi.fn(async () => [{ timestamp: '2026-10-14T12:00:00Z', cost: 5 }])
  const day = (date: string) => ({ start: new Date(date + 'T00:00:00Z'), end: new Date(date + 'T23:59:59Z') })
  try {
    expect(await cachedFileParse(path, 'fixture', parse, [], day('2026-10-14'))).toHaveLength(1)
    await flushDiscoveryCache(); clearDiscoveryCache()
    setModelAliases({ fixture: 'gpt-5' })
    expect(await cachedFileParse(path, 'fixture', parse, [], day('2025-07-01'))).toEqual([])
    expect(parse).toHaveBeenCalledTimes(1)
    // Appends invalidate the range; metadata from an older snapshot cannot hide new usage.
    await writeFile(path, 'appended fixture')
    await cachedFileParse(path, 'fixture', parse, [], day('2025-07-01'))
    expect(parse).toHaveBeenCalledTimes(2)
  } finally { setModelAliases({}); clearDiscoveryCache() }
})

it('keeps cached schema warnings when deriving ranges from legacy parsed entries', async () => {
  const { clearDiscoveryCache } = await import('../src/discovery-cache.js')
  dir = await mkdtemp(join(tmpdir(), 'watcher-range-warnings-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'fixture')
  const legacyWarnings = ['fixture schema warning']
  const parse = async () => [{ timestamp: '2026-10-14T12:00:00Z' }]
  await cachedFileParse(path, 'fixture', parse, legacyWarnings)
  const range = { start: new Date('2026-10-14T00:00:00Z'), end: new Date('2026-10-14T23:59:59Z') }
  await cachedFileParse(path, 'fixture', parse, [], range)
  const warnings: string[] = []
  await cachedFileParse(path, 'fixture', parse, warnings, { ...range, end: new Date('2025-07-01T00:00:00Z') })
  expect(warnings).toEqual(legacyWarnings)
  clearDiscoveryCache()
})
