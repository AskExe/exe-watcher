import { expect, it } from 'vitest'
import { applyClaudeRecovery, recoverClaudeUsage, type ClaudeUsageSnapshot, type RecoveryTokens } from '../src/claude-recovery.js'
import { buildMenubarPayload, type PeriodData } from '../src/menubar-json.js'
import { calculateCost } from '../src/models.js'
const snapshot: ClaudeUsageSnapshot = {
  firstSessionDate: '2026-01-20T12:00:00Z', lastComputedDate: '2026-09-22',
  modelUsage: { 'claude-opus-4-6': { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 5000, cacheCreationInputTokens: 1000 } },
}
const start = new Date('2025-07-01T00:00:00Z')
it('recovers only residual token counters, rather than adding overlapping cumulative totals', () => {
  const recorded = new Map<string, RecoveryTokens>([['Opus 4.6', { inputTokens: 600, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 800 }]])
  const recovered = recoverClaudeUsage(snapshot, recorded, start)!
  expect(recovered.inputTokens).toBe(400)
  expect(recovered.outputTokens).toBe(100)
  expect(recovered.costUSD).toBeCloseTo(calculateCost('claude-opus-4-6', 400, 100, 200, 2000, 0))
})
it('does not subtract counters or add costs when retained logs already cover the snapshot', () => {
  const recorded = new Map<string, RecoveryTokens>([['Opus 4.6', { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 6000, cacheWriteTokens: 2000 }]])
  expect(recoverClaudeUsage(snapshot, recorded, start)).toBeNull()
})
it('excludes lifetime snapshots from a period that starts after the snapshot history begins', () => {
  expect(recoverClaudeUsage(snapshot, new Map(), new Date('2026-02-01'))).toBeNull()
})
it('does not invent usage from corrupt negative or non-finite counters', () => {
  const corrupt = { ...snapshot, modelUsage: { bad: { inputTokens: -1 }, nan: { outputTokens: NaN } } }
  expect(recoverClaudeUsage(corrupt, new Map(), start)).toBeNull()
})

it('marks recovered call counts as incomplete, preserving known calls and unaffected models', () => {
  const data: PeriodData = {
    label: 'All Time', cost: 12, calls: 21, sessions: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, categories: [],
    models: [{ name: 'Opus 4.6', cost: 10, calls: 18 }, { name: 'gpt-5.4', cost: 2, calls: 3 }],
  }
  const recovery = recoverClaudeUsage({ ...snapshot, modelUsage: {
    ...snapshot.modelUsage, 'claude-opus-4-8': { outputTokens: 100 },
  } }, new Map(), start)!
  applyClaudeRecovery(data, recovery)
  const payload = buildMenubarPayload(data, [], null)
  expect(payload.current.calls).toBe(21)
  expect(payload.current.callsIncomplete).toBe(true)
  expect(payload.current.cost).toBeCloseTo(12 + recovery.costUSD)
  expect(payload.current.topModels.find(m => m.name === 'Opus 4.6')).toMatchObject({ calls: 18, callsIncomplete: true })
  expect(payload.current.topModels.find(m => m.name === 'Opus 4.8')).toMatchObject({ calls: 0, callsIncomplete: true })
  expect(payload.current.topModels.find(m => m.name === 'GPT-5.4')).toMatchObject({ calls: 3, callsIncomplete: false })
  expect(payload.current.topModels.filter(m => m.name === 'Opus 4.6')).toHaveLength(1)
})

it('preserves historical counters when Claude rebuilds or removes its own statistics', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { vi } = await import('vitest')
  const { readClaudeUsageSnapshot } = await import('../src/claude-recovery.js')
  const dir = await mkdtemp(join(tmpdir(), 'watcher-snapshot-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir); vi.stubEnv('EXE_WATCHER_CACHE_DIR', join(dir, 'cache'))
  try {
    const path = join(dir, 'stats-cache.json')
    await writeFile(path, JSON.stringify(snapshot))
    expect((await readClaudeUsageSnapshot())?.modelUsage['claude-opus-4-6']?.outputTokens).toBe(500)
    await writeFile(path, JSON.stringify({ ...snapshot, lastComputedDate: '2026-09-23', modelUsage: { 'claude-opus-4-6': { outputTokens: 50 } } }))
    const saved = await readClaudeUsageSnapshot()
    expect(saved?.modelUsage['claude-opus-4-6']?.outputTokens).toBe(500)
    expect(saved?.lastComputedDate).toBe('2026-09-23')
    await rm(path)
    expect((await readClaudeUsageSnapshot())?.modelUsage['claude-opus-4-6']?.outputTokens).toBe(500)
  } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) }
})
