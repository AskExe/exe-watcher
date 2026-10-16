import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectSummary } from '../src/types.js'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('os', async () => ({ ...await vi.importActual('os'), homedir: () => fixture.home }))
vi.mock('../src/providers/index.js', () => ({ discoverAllSessions: vi.fn() }))

import { discoverAllSessions } from '../src/providers/index.js'
import * as fsUtils from '../src/fs-utils.js'
import { scanAndDetect, scanJsonlFile } from '../src/optimize.js'
import { clearDiscoveryCache } from '../src/discovery-cache.js'
import { withScanBudget } from '../src/resource-budget.js'
import * as budget from '../src/resource-budget.js'

const timestamp = '2026-10-15T12:00:00Z'
const range = { start: new Date('2026-10-15T00:00:00Z'), end: new Date('2026-10-15T23:59:59Z') }
function project(ids: string[]): ProjectSummary {
  return { project: 'selected', projectPath: '/selected', totalApiCalls: ids.length, totalCostUSD: 1,
    sessions: ids.map(sessionId => ({ sessionId, project: 'selected', firstTimestamp: timestamp, lastTimestamp: timestamp,
      totalCostUSD: 1, totalInputTokens: 100, totalOutputTokens: 1, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
      apiCalls: 1, turns: [], modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {}, categoryBreakdown: {},
    })) }
}
function entry(path: string, padding = ''): string {
  return JSON.stringify({ type: 'assistant', timestamp, version: 'test', message: { content: [
    { type: 'tool_use', name: 'Read', input: { file_path: path, content: padding } },
  ] } }) + '\n'
}
async function file(path: string, body: string): Promise<string> {
  const full = join(fixture.home, path)
  await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, body)
  return full
}
beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'watcher-optimize-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', join(fixture.home, 'cache'))
  vi.mocked(discoverAllSessions).mockResolvedValue([{ path: join(fixture.home, 'selected'), project: 'selected', provider: 'claude' }])
})
afterEach(async () => {
  clearDiscoveryCache(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(fixture.home, { recursive: true, force: true })
})

it('skips recently touched unrelated sessions and projects, while including selected subagents', async () => {
  await file('selected/active.jsonl', entry('/app/node_modules/a') + entry('/app/node_modules/b'))
  await file('selected/parent/subagents/agent-1.jsonl', entry('/app/node_modules/c'))
  await file('selected/old.jsonl', entry('/old', 'x'.repeat(100_000)))
  const other = await file('other/active.jsonl', entry('/other', 'x'.repeat(100_000)))
  vi.mocked(discoverAllSessions).mockResolvedValue([
    { path: join(fixture.home, 'selected'), project: 'selected', provider: 'claude' },
    { path: join(other, '..'), project: 'other', provider: 'claude' },
  ])
  vi.stubEnv('EXE_WATCHER_MAX_SCAN_BYTES', '64000')
  // Multiple provider summaries can share the same project name in the All view.
  const result = await scanAndDetect([project(['active']), project(['agent-1'])], range)
  expect(result.findings.find(f => f.title.includes('build/dependency'))?.explanation).toContain('3 reads')
})

it('reuses compact evidence across periods, recomputes recency, and invalidates appended files', async () => {
  const path = await file('selected/active.jsonl', entry('/app/foo.ts', 'private generated code '.repeat(8000)))
  const read = vi.spyOn(fsUtils, 'readSessionLines')
  const first = await scanJsonlFile(path, 'selected', range, 0)
  expect(first.calls[0]?.input).toEqual({ file_path: '/app/foo.ts' })
  expect(first.calls[0]?.recent).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  vi.stubEnv('EXE_WATCHER_MAX_SCAN_BYTES', '64000')
  const second = await withScanBudget(() => scanJsonlFile(path, 'selected', undefined, Date.now() + 86_400_000))
  expect(second.calls[0]?.recent).toBe(false)
  expect(read).toHaveBeenCalledTimes(1)
  vi.stubEnv('EXE_WATCHER_MAX_SCAN_BYTES', String(1024 ** 2))
  await appendFile(path, entry('/app/added.ts'))
  expect((await scanJsonlFile(path, 'selected', range)).calls).toHaveLength(2)
  expect(read).toHaveBeenCalledTimes(2)
})

it('retains completed file evidence on a bounded failure so retry can finish', async () => {
  await file('selected/a.jsonl', entry('/app/node_modules/a', 'x'.repeat(40_000)))
  await file('selected/b.jsonl', entry('/app/node_modules/b', 'x'.repeat(40_000)) + entry('/app/node_modules/c'))
  vi.stubEnv('EXE_WATCHER_MAX_SCAN_BYTES', '64000')
  const projects = [project(['a', 'b'])]
  await expect(scanAndDetect(projects, range)).rejects.toThrow('read budget')
  const result = await scanAndDetect(projects, range)
  expect(result.findings.find(f => f.title.includes('build/dependency'))?.explanation).toContain('3 reads')
})

it('honors cancellation even when no transcript needs reading', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(withScanBudget(() => scanAndDetect([project(['active'])], range), 200_000, controller.signal)).rejects.toThrow('scan cancelled')
})

it('returns observed partial recommendations without caching an incomplete file or suggesting unused cleanup', async () => {
  await file('selected/a.jsonl', entry('/app/node_modules/a').repeat(3))
  const second = await file('selected/b.jsonl', entry('/app/node_modules/b').repeat(40))
  for (let i = 0; i < 6; i++) await file(`.claude/agents/agent-${i}.md`, 'An agent definition')
  const read = vi.spyOn(fsUtils, 'readSessionLines')
  const original = budget.withScanSlice
  const slice = vi.spyOn(budget, 'withScanSlice').mockImplementation(fn => original(fn,
    { maxRecords: 20, maxBytes: 1024 ** 2, maxMs: 10_000 }))
  const selected = [project(['a', 'b'])]
  const partial = await scanAndDetect(selected, range, undefined, { allowPartial: true })
  expect(partial.coverage).toEqual({ totalFiles: 2, completedFiles: 1, partial: true })
  expect(partial.findings.some(f => f.title.includes('build/dependency'))).toBe(true)
  expect(partial.findings.some(f => f.title.includes('never use'))).toBe(false)
  slice.mockRestore()
  const full = await scanAndDetect(selected, range)
  expect(full.findings.some(f => f.title.includes('custom agent'))).toBe(true)
  expect(read.mock.calls.filter(([path]) => path === second)).toHaveLength(2)
})
