import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedFileParse, parsedFileProgress } from '../src/parsed-file-cache.js'
import { ResourceBudgetError } from '../src/resource-budget.js'
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

it('accounts for the replaced entry after a source shrinks', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-replace-quota-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'large source')
  await cachedFileParse(path, 'fixture', async () => Array.from({ length: 100 }, (_, n) => ({ n, text: String(n).repeat(100) })))
  const cacheDir = join(dir, 'parsed-files')
  const before = Number(await readFile(join(cacheDir, 'quota'), 'utf8'))
  await writeFile(path, 'small source')
  await cachedFileParse(path, 'fixture', async () => [1])
  const quota = Number(await readFile(join(cacheDir, 'quota'), 'utf8'))
  const sizes = await Promise.all((await readdir(cacheDir)).filter(name => name.endsWith('.json.gz')).map(async name => (await stat(join(cacheDir, name))).size))
  expect(quota).toBe(sizes.reduce((sum, size) => sum + size, 0))
  expect(quota).toBeLessThan(before)
})

it('keeps unfinished state separate, counts actual progress, and reclaims it on completion', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-cursor-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'one\ntwo\n')
  const start = parsedFileProgress()
  await expect(cachedFileParse(path, 'fixture', async progress => {
    await progress.save([1], 4)
    throw new ResourceBudgetError('fixture')
  })).rejects.toBeInstanceOf(ResourceBudgetError)
  expect(parsedFileProgress()).toBe(start + 1)
  const cacheDir = join(dir, 'parsed-files')
  expect((await readdir(cacheDir)).filter(name => name.endsWith('.json.gz'))).toHaveLength(1)
  await expect(cachedFileParse(path, 'fixture', async progress => {
    expect(await progress.load(Array.isArray)).toEqual({ offset: 4, state: [1] })
    await progress.save([1], 4) // The same cursor cannot keep background retries alive.
    throw new ResourceBudgetError('fixture')
  })).rejects.toBeInstanceOf(ResourceBudgetError)
  expect(parsedFileProgress()).toBe(start + 1)
  expect(await cachedFileParse(path, 'fixture', async progress => {
    expect(await progress.load(Array.isArray)).toEqual({ offset: 4, state: [1] })
    return [1, 2]
  })).toEqual([1, 2])
  const files = (await readdir(cacheDir)).filter(name => name.endsWith('.json.gz'))
  expect(files).toHaveLength(1)
  expect(files[0]).not.toContain('progress')
  expect((await stat(join(cacheDir, files[0]!))).mode & 0o777).toBe(0o600)
  expect(Number(await readFile(join(cacheDir, 'quota'), 'utf8'))).toBe((await stat(join(cacheDir, files[0]!))).size)
})

it.each(['appended source', 'rewrite!', 'x'])('invalidates unfinished state after a changed source: %j', async content => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-cursor-invalid-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'one\ntwo\n')
  await expect(cachedFileParse(path, 'fixture', async progress => {
    await progress.save([1], 4)
    throw new ResourceBudgetError('fixture')
  })).rejects.toBeInstanceOf(ResourceBudgetError)
  await writeFile(path, content)
  await cachedFileParse(path, 'fixture', async progress => {
    expect(await progress.load(Array.isArray)).toBeUndefined()
    return [2]
  })
})

it('bounds checkpoint storage and rejects moving source snapshots', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-cursor-limit-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, 'one\ntwo\n')
  const start = parsedFileProgress()
  await expect(cachedFileParse(path, 'fixture', async progress => {
    await progress.save('x'.repeat(17 * 1024 ** 2), 4)
    await writeFile(path, 'changed source')
    await progress.save([1], 4)
    throw new ResourceBudgetError('fixture')
  })).rejects.toBeInstanceOf(ResourceBudgetError)
  expect(parsedFileProgress()).toBe(start)
})
