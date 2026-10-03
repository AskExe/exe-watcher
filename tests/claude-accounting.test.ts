import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAllSessions, clearParserCaches } from '../src/parser.js'
import { calculateCost, getPricingWarnings } from '../src/models.js'
import { claude } from '../src/providers/claude.js'

let dir: string
const model = 'claude-opus-4-6'
function assistant(id: string, output: number, timestamp = '2026-08-01T12:00:00Z', extra = {}) {
  return { type: 'assistant', timestamp, message: { id, model, content: [], usage: { input_tokens: 100,
    output_tokens: output, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, ...extra } } }
}
async function session(name: string, entries: unknown[], root = dir) {
  const project = join(root, 'projects', 'accounting-fixture')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, `${name}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
}
async function read(range?: { start: Date; end: Date }) {
  return (await parseAllSessions(range, 'claude')).find(p => p.project === 'accounting-fixture')
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-accounting-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir)
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', join(dir, 'cache'))
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'config'))
  clearParserCaches()
})
afterEach(async () => { clearParserCaches(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })

describe('Claude API-equivalent accounting', () => {
  it('counts final streamed usage once, preserves tools, and survives parsed-cache replay', async () => {
    const early = assistant('streamed', 2)
    const final = assistant('streamed', 500)
    final.message.content = [{ type: 'tool_use', name: 'Edit', id: 'tool', input: {} }] as never
    await session('stream', [early, final, early, final])
    const project = await read()
    expect(project?.totalApiCalls).toBe(1)
    expect(project?.sessions[0]?.totalOutputTokens).toBe(500)
    expect(project?.totalCostUSD).toBeCloseTo(calculateCost(model, 100, 500, 1000, 2000, 0))
    expect(project?.sessions[0]?.toolBreakdown.Edit?.calls).toBe(1)
    clearParserCaches()
    expect((await read())?.totalCostUSD).toBe(project?.totalCostUSD)
  })

  it('does not let an assistant block without usage hide a later metered block', async () => {
    const early = { type: 'assistant', message: { id: 'late', model, content: [] } }
    await session('late', [early, assistant('late', 500)])
    expect((await read())?.totalApiCalls).toBe(1)
  })

  it('prices 1h writes at 2x input without double-counting aggregate cache creation', async () => {
    await session('ttl', [assistant('ttl', 500, undefined, { cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 } })])
    const project = await read()
    expect(project?.sessions[0]?.totalCacheWriteTokens).toBe(1000)
    expect(project?.totalCostUSD).toBeCloseTo(100 * 5e-6 + 500 * 25e-6 + 600 * 6.25e-6 + 400 * 10e-6 + 2000 * 0.5e-6)
  })

  it('retains midnight calls in their respective reporting windows', async () => {
    await session('midnight', [assistant('day1', 50, '2026-08-01T23:59:00Z'), assistant('day2', 150, '2026-08-02T00:01:00Z')])
    const first = await read({ start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-01T23:59:59Z') })
    const second = await read({ start: new Date('2026-08-02T00:00:00Z'), end: new Date('2026-08-02T23:59:59Z') })
    expect(first?.totalApiCalls).toBe(1)
    expect(second?.totalApiCalls).toBe(1)
    expect(first!.totalCostUSD + second!.totalCostUSD).toBeCloseTo((await read())!.totalCostUSD)
  })

  it('includes separate profile roots and deduplicates copied API responses', async () => {
    const profile = join(dir, 'other-account')
    await mkdir(join(dir, 'config', 'exe-watcher'), { recursive: true })
    await writeFile(join(dir, 'config', 'exe-watcher', 'config.json'), JSON.stringify({ claudeConfigDirs: [profile, dir] }))
    await session('account1', [assistant('one', 50)])
    await session('account2', [assistant('one', 50), assistant('two', 150)], profile)
    const sources = (await claude.discoverSessions()).filter(s => s.project === 'accounting-fixture')
    expect(sources).toHaveLength(2)
    expect((await read())?.totalApiCalls).toBe(2)
  })

  it('counts tokens with unavailable prices and raises a visible pricing warning', async () => {
    const entry = assistant('unpriced', 50)
    entry.message.model = 'unpriced-private-model'
    await session('unpriced', [entry])
    expect((await read())?.sessions[0]?.totalOutputTokens).toBe(50)
    expect(getPricingWarnings().some(w => w.includes('unpriced-private-model'))).toBe(true)
    clearParserCaches()
    await read()
    expect(getPricingWarnings().filter(w => w.includes('unpriced-private-model'))).toHaveLength(1)
  })
})
