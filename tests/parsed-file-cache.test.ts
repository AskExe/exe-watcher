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
