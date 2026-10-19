import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedFileParse } from '../src/parsed-file-cache.js'
import { setModelAliases } from '../src/models.js'
import { lockClaudeRecovery } from '../src/claude-recovery.js'
let directory = ''
afterEach(async () => { setModelAliases({}); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'watcher-fixed-prices-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', directory)
  const path = join(directory, 'session.jsonl'); await writeFile(path, 'first')
  return path
}
const call = (id: string, costUSD: number, provider = 'claude') => ({ provider, model: 'claude-sonnet-4-6',
  deduplicationKey: id, inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0, costUSD })

it('keeps counted amounts through pricing changes, appends, cache eviction and copied sessions', async () => {
  const path = await fixture()
  const initial = vi.fn(async () => [call('old', 2)])
  expect((await cachedFileParse(path, 'claude', initial))[0]!.costUSD).toBe(2)
  setModelAliases({ fixture: 'gpt-5' })
  const changed = vi.fn(async () => [call('old', 20)])
  expect((await cachedFileParse(path, 'claude', changed))[0]!.costUSD).toBe(2)
  expect(changed).not.toHaveBeenCalled()
  await rm(join(directory, 'parsed-files'), { recursive: true, force: true })
  expect((await cachedFileParse(path, 'claude', changed))[0]!.costUSD).toBe(2)
  await writeFile(path, 'first\nnew usage')
  const appended = await cachedFileParse(path, 'claude', async () => [call('old', 20), call('new', 3)])
  expect(appended.map(row => row.costUSD)).toEqual([2, 3])
  const copy = join(directory, 'copy.jsonl'); await writeFile(copy, 'copy')
  expect((await cachedFileParse(copy, 'claude', async () => [call('old', 200)]))[0]!.costUSD).toBe(2)
  expect((await stat(join(directory, 'recorded-costs.sqlite'))).mode & 0o777).toBe(0o600)
  expect((await readFile(join(directory, 'recorded-costs.sqlite'))).includes(Buffer.from('claude-sonnet'))).toBe(false)
})

it('scopes identities to the provider and allows new accounting quantities', async () => {
  const path = await fixture()
  await cachedFileParse(path, 'fixture', async () => [call('same', 2)])
  await writeFile(path, 'updated accounting')
  const rows = await cachedFileParse(path, 'fixture', async () => [call('same', 9), call('same', 4, 'codex'), { ...call('same', 5), outputTokens: 75 }])
  expect(rows.map(row => row.costUSD)).toEqual([2, 4, 5])
})

it('does not freeze an unknown price as a final zero', async () => {
  const path = await fixture()
  const unknown = { ...call('unknown', 0), model: 'private-unpriced-model' }
  expect((await cachedFileParse(path, 'fixture', async () => [unknown]))[0]!.costUSD).toBe(0)
  setModelAliases({ 'private-unpriced-model': 'claude-sonnet-4-6' })
  expect((await cachedFileParse(path, 'fixture', async () => [{ ...unknown, costUSD: 3 }]))[0]!.costUSD).toBe(3)
})

it('also fixes unchanged recovered Claude estimates across price refreshes', async () => {
  await fixture()
  const model = { name: 'Sonnet', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 2 }
  const first = { ...model, source: 'claude-stats-cache' as const, throughDate: '2026-10-15', models: [model], note: 'Recovered estimate' }
  expect(lockClaudeRecovery(first)!.costUSD).toBe(2)
  const newer = { ...first, costUSD: 20, models: [{ ...model, costUSD: 20 }] }
  expect(lockClaudeRecovery(newer)!.costUSD).toBe(2)
})
