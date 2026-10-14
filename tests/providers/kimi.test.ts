import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKimiProvider } from '../../src/providers/kimi.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from '../../src/day-aggregator.js'
import { buildProjectSpendFromDays } from '../../src/menubar-json.js'
import { clearParserCaches, parseAllSessions } from '../../src/parser.js'
import { ResourceBudgetError, withScanBudget } from '../../src/resource-budget.js'

let root: string
let previousHome: string | undefined
let previousCache: string | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watcher-kimi-'))
  previousHome = process.env.KIMI_CODE_HOME; previousCache = process.env.EXE_WATCHER_CACHE_DIR
  process.env.KIMI_CODE_HOME = root; process.env.EXE_WATCHER_CACHE_DIR = join(root, 'cache')
  clearParserCaches()
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome
  if (previousCache === undefined) delete process.env.EXE_WATCHER_CACHE_DIR; else process.env.EXE_WATCHER_CACHE_DIR = previousCache
  clearParserCaches(); await rm(root, { recursive: true, force: true })
})
const time = new Date(2026, 9, 12, 12).getTime()
const usage = (extra: Record<string, unknown> = {}) => ({ type: 'usage.record', agentId: 'agent-0', time,
  model: 'kimi-code/k3-256k', usage: { inputOther: 100, output: 50, inputCacheRead: 500, inputCacheCreation: 10 }, ...extra })
async function file(records: unknown[], agent = 'agent-0', session = 'session_one'): Promise<string> {
  const directory = join(root, 'sessions/wd_fixture_123456abcdef', session, 'agents', agent)
  await mkdir(directory, { recursive: true }); const path = join(directory, 'wire.jsonl')
  await writeFile(path, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n')
  return path
}
async function calls(): Promise<ParsedProviderCall[]> {
  const provider = createKimiProvider(root), out: ParsedProviderCall[] = [], seen = new Set<string>()
  for (const source of await provider.discoverSessions()) for await (const call of provider.createSessionParser(source, seen).parse()) out.push(call)
  return out
}
describe('native Kimi Code usage', () => {
  it('discovers main and subagent wire logs with workspace project names', async () => {
    await writeFile(join(root, 'workspaces.json'), JSON.stringify({ workspaces: { wd_fixture_123456abcdef: { root: '/repos/fixture' } } }))
    await file([usage()]); await file([usage({ agentId: 'agent-1', time: time + 1 })], 'agent-1')
    await writeFile(join(root, 'api-key.json'), 'not a usage log')
    const sources = await createKimiProvider(root).discoverSessions()
    expect(sources).toHaveLength(2); expect(sources.every(s => s.project === 'fixture' && s.provider === 'kimi')).toBe(true)
  })
  it('uses only billed usage and keeps uncached/cache tokens separate', async () => {
    await file([usage(), { type: 'token_counting.measured', tokens: 99999, time }, { type: 'context.append_message', usage: { inputOther: 99999 } }])
    const rows = await calls(); expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: 'kimi-k3', inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 500, cacheCreationInputTokens: 10 })
    expect(rows[0]!.costUSD).toBeGreaterThan(0)
  })
  it('preserves tokens for the rotating coding alias without inventing a model price', async () => {
    await file([usage({ model: 'kimi-code/kimi-for-coding' })]); const rows = await calls()
    expect(rows[0]).toMatchObject({ model: 'kimi-for-coding', inputTokens: 100, outputTokens: 50, costUSD: 0 })
  })
  it('deduplicates copied usage records across forked session files', async () => {
    await file([usage(), usage()]); await file([usage()], 'agent-0', 'session_fork')
    expect(await calls()).toHaveLength(1)
  })
  it('keeps malformed and negative usage out of totals', async () => {
    await file(['{broken', usage({ usage: { inputOther: -1 } }), usage({ usage: { inputOther: '100' } }), usage()])
    expect(await calls()).toHaveLength(1)
  })
  it('does not follow a session symlink into another profile', async () => {
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'wire.jsonl'), JSON.stringify(usage()))
    await mkdir(join(root, 'sessions')); await symlink(outside, join(root, 'sessions/linked'))
    expect(await createKimiProvider(root).discoverSessions()).toEqual([])
  })
  it('feeds the normal daily and provider rollups, including GLM used through Kimi Code', async () => {
    await file([usage(), usage({ time: time + 1, model: 'zai/glm-5.3' })])
    const days = aggregateProjectsIntoDays(await parseAllSessions(undefined, 'kimi', true))
    expect(days).toHaveLength(1); expect(days[0]!.calls).toBe(2)
    expect(days[0]!.inputTokens).toBe(200); expect(days[0]!.outputTokens).toBe(100)
    expect(days[0]!.cacheReadTokens).toBe(1000); expect(days[0]!.providers.kimi!.calls).toBe(2)
    expect(Object.keys(days[0]!.models)).toContain('zai/glm-5.3')
  })
  it('keeps prototype-like model names from modifying shared objects', async () => {
    await writeFile(join(root, 'workspaces.json'), JSON.stringify({ workspaces: { wd_fixture_123456abcdef: { root: '/repos/__proto__' } } }))
    await file([usage({ model: '__proto__' })])
    const before = Object.getOwnPropertyNames(Object.prototype)
    const days = aggregateProjectsIntoDays(await parseAllSessions(undefined, 'kimi', true))
    expect(days[0]!.inputTokens).toBe(100)
    expect(buildPeriodDataFromDays(days, 'test').calls).toBe(1)
    buildProjectSpendFromDays(days, days, days, days)
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before)
    expect(({} as Record<string, unknown>).cost).toBeUndefined()
  })
  it('preserves scan budgets rather than swallowing a resource failure', async () => {
    await file([usage()]); const previous = process.env.EXE_WATCHER_MAX_SCAN_BYTES
    process.env.EXE_WATCHER_MAX_SCAN_BYTES = '1'
    try { await expect(withScanBudget(() => calls())).rejects.toBeInstanceOf(ResourceBudgetError) }
    finally { if (previous === undefined) delete process.env.EXE_WATCHER_MAX_SCAN_BYTES; else process.env.EXE_WATCHER_MAX_SCAN_BYTES = previous }
  })
})
