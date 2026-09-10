import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, stat, rm, appendFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedFileParse } from '../src/parsed-file-cache.js'
import { acquireFileLock } from '../src/file-lock.js'
import { readSessionLines } from '../src/fs-utils.js'
import { withScanBudget, chargeRead, ResourceBudgetError } from '../src/resource-budget.js'
import { createPiProvider, createOmpProvider } from '../src/providers/pi.js'

let dir = ''
afterEach(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  dir = await mkdtemp(join(tmpdir(), 'watcher-resources-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', join(dir, 'cache'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, 'first\n')
  return path
}
it('reuses unchanged parsed results without rewriting and invalidates appends, truncation and replacement', async () => {
  const path = await fixture()
  const parse = vi.fn(async () => (await readFile(path, 'utf8')).split('\n'))
  const first = await cachedFileParse(path, 'test', parse)
  const cacheDir = join(dir, 'cache', 'parsed-files')
  const filename = (await readdir(cacheDir)).find(p => p.endsWith('.json'))!
  const before = await stat(join(cacheDir, filename))
  expect(await cachedFileParse(path, 'test', parse)).toEqual(first)
  expect(parse).toHaveBeenCalledTimes(1)
  expect((await stat(join(cacheDir, filename))).ino).toBe(before.ino)
  await appendFile(path, 'partial')
  expect(await cachedFileParse(path, 'test', parse)).toEqual(['first', 'partial'])
  await appendFile(path, '-completed\n')
  expect(await cachedFileParse(path, 'test', parse)).toEqual(['first', 'partial-completed', ''])
  await writeFile(path, 'reset\n')
  expect(await cachedFileParse(path, 'test', parse)).toEqual(['reset', ''])
  await rm(path); await writeFile(path, 'other\n')
  expect(await cachedFileParse(path, 'test', parse)).toEqual(['other', ''])
  expect(parse).toHaveBeenCalledTimes(5)
})
it('does not persist results if the source changes during parsing', async () => {
  const path = await fixture()
  const parse = vi.fn(async () => { await appendFile(path, 'new\n'); return ['old'] })
  await cachedFileParse(path, 'moving', parse)
  await cachedFileParse(path, 'moving', parse)
  expect(parse).toHaveBeenCalledTimes(2)
})
it('reads only the initial snapshot when an active transcript grows', async () => {
  const path = await fixture()
  const gen = readSessionLines(path)
  expect((await gen.next()).value).toBe('first')
  await appendFile(path, 'second\n')
  expect((await gen.next()).done).toBe(true)
  const next = []
  for await (const line of readSessionLines(path)) next.push(line)
  expect(next).toEqual(['first', 'second'])
})
it('fails visibly on scan budget exhaustion rather than returning partial success', async () => {
  await expect(withScanBudget(async () => chargeRead(1024 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(ResourceBudgetError)
})
it('excludes a second owner and reclaims a dead owner', async () => {
  await fixture()
  const path = join(dir, 'scan.lock')
  const release = await acquireFileLock(path)
  await expect(acquireFileLock(path, 60)).rejects.toThrow('Another Watcher scan')
  await release()
  await writeFile(path, '2147483647:dead')
  const releaseNext = await acquireFileLock(path, 500)
  expect(await readFile(path, 'utf8')).toMatch(new RegExp(`^${process.pid}:`))
  await releaseNext()
})
it('Pi and OMP discovery use headers within the same read budget as Codex', async () => {
  await fixture()
  await mkdir(join(dir, 'project'))
  await writeFile(join(dir, 'project', 'session.jsonl'), JSON.stringify({type:'session',cwd:'/work/project'}) + '\n' + 'x'.repeat(8 * 1024 * 1024))
  expect(await withScanBudget(() => createPiProvider(dir).discoverSessions())).toHaveLength(1)
  expect(await withScanBudget(() => createOmpProvider(dir).discoverSessions())).toHaveLength(1)
})

it('preserves classification beyond the retained prompt prefix', async () => {
  const { compactUserMessage, classifyTurn } = await import('../src/classifier.js')
  const text = 'padding '.repeat(1000) + ' fix broken test'
  const full = { userMessage: text, assistantCalls: [], timestamp: '', sessionId: '' } as any
  const compact = { ...full, ...compactUserMessage(text) }
  expect(compact.userMessage.length).toBe(512)
  expect(classifyTurn(compact).category).toBe(classifyTurn(full).category)
})
it('reclaims an abandoned reaper without bypassing a live scan owner', async () => {
  await fixture()
  const path = join(dir, 'scan.lock')
  await writeFile(path, '2147483647:dead')
  await writeFile(`${path}.reaper`, '2147483647:dead-reaper')
  const release = await acquireFileLock(path, 500)
  await expect(acquireFileLock(path, 60)).rejects.toThrow('Another Watcher scan')
  await release()
})
it('streams a large single record and rejects an oversized one', async () => {
  const path = await fixture()
  await writeFile(path, 'x'.repeat(9 * 1024 * 1024) + '\nend\n')
  const lengths = []
  for await (const line of readSessionLines(path)) lengths.push(line.length)
  expect(lengths).toEqual([9 * 1024 * 1024, 3])
  await writeFile(path, 'x'.repeat(32 * 1024 * 1024 + 1))
  await expect((async () => { for await (const _ of readSessionLines(path)) {} })()).rejects.toBeInstanceOf(ResourceBudgetError)
})

it('replays parser warnings with cached results', async () => {
  const path = await fixture()
  const first: string[] = []
  await cachedFileParse(path, 'warnings', async () => { first.push('partial source'); return ['data'] }, first)
  const next: string[] = []
  const parse = vi.fn(async () => ['other'])
  expect(await cachedFileParse(path, 'warnings', parse, next)).toEqual(['data'])
  expect(parse).not.toHaveBeenCalled()
  expect(next).toEqual(['partial source'])
})
it('invalidates database cache for WAL changes and database identity', async () => {
  const path = await fixture()
  const { writeCachedResults, readCachedResults, getDbFingerprint } = await import('../src/cursor-cache.js')
  await writeCachedResults(path, [])
  expect(await readCachedResults(path)).toEqual([])
  const before = await getDbFingerprint(path)
  await writeFile(`${path}-wal`, 'new transaction')
  expect(await readCachedResults(path)).toBeNull()
  await writeCachedResults(path, [], before)
  expect(await readCachedResults(path)).toBeNull()
  await writeCachedResults(path, [])
  const other = join(dir, 'other.db')
  await writeFile(other, 'first\n')
  expect(await readCachedResults(other)).toBeNull()
})
