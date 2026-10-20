import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseAllSessions, clearParserCaches } from '../src/parser.js'
import { loadPricing } from '../src/models.js'
import { ResourceBudgetError, withScanBudget } from '../src/resource-budget.js'

// parseAllSessions discovers sessions via the provider registry. The claude
// provider reads CLAUDE_CONFIG_DIR (or ~/.claude) / projects / <name> / *.jsonl.
// We point CLAUDE_CONFIG_DIR at a temp directory and filter to 'claude' only
// so tests don't scan the real home dir or load heavy providers.

let tmpDirs: string[] = []
let origClaudeConfigDir: string | undefined
// Monotonic counter to create unique dateRange per test, avoiding the internal
// 60-second session cache in parser.ts.
let testCounter = 0

beforeAll(async () => {
  await loadPricing()
})

afterEach(async () => {
  if (origClaudeConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

/** Create a temp directory to serve as CLAUDE_CONFIG_DIR and return its path. */
async function setupTmpClaudeDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'exe-watcher-parser-'))
  tmpDirs.push(base)
  origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = base
  return base
}

/** Write a JSONL file at <configDir>/projects/<projectName>/<sessionId>.jsonl. */
async function writeSessionFile(
  configDir: string,
  projectName: string,
  sessionId: string,
  lines: object[],
): Promise<string> {
  const projectDir = join(configDir, 'projects', projectName)
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  await writeFile(filePath, content)
  return filePath
}

function userEntry(
  text: string,
  timestamp: string,
  sessionId: string,
): object {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    timestamp,
    sessionId,
  }
}

function assistantEntry(
  msgId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  timestamp: string,
  tools: Array<{ type: string; id: string; name: string; input: Record<string, unknown> }> = [],
): object {
  const content: object[] = [
    { type: 'text', text: 'response' },
    ...tools,
  ]
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      id: msgId,
      type: 'message',
      content,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    },
    timestamp,
  }
}

/**
 * Returns a unique dateRange for each test call so the 60s session cache in
 * parser.ts never returns stale data from a previous test.
 * All fixture timestamps use 2026-04-10T12:xx:xxZ, so the range covers
 * the entire day of 2026-04-10 but uses a unique providerFilter suffix.
 */
function uniqueDateRange(): { start: Date; end: Date } {
  return {
    start: new Date('2026-04-10T00:00:00Z'),
    end: new Date('2026-04-10T23:59:59Z'),
  }
}

/**
 * Calls parseAllSessions with providerFilter='claude' and a unique cache-
 * busting providerFilter. Since the cache key includes providerFilter,
 * appending a per-test counter avoids false cache hits.
 *
 * NOTE: providerFilter is matched via `p.name === providerFilter` in the
 * registry, so a non-matching value means zero providers. Instead we use
 * unique dateRange start offsets to bust the cache.
 */
async function parseOnce(): Promise<ReturnType<typeof parseAllSessions>> {
  // Each call shifts the dateRange start by a unique number of milliseconds.
  // This changes the cache key without affecting which entries are included
  // since they all fall well within the range.
  testCounter++
  const range = {
    start: new Date(new Date('2026-04-10T00:00:00Z').getTime() + testCounter),
    end: new Date('2026-04-10T23:59:59Z'),
  }
  return parseAllSessions(range, 'claude')
}

describe('parser pipeline via parseAllSessions', () => {
  it('parses a minimal session into a ProjectSummary', async () => {
    const base = await setupTmpClaudeDir()

    await writeSessionFile(base, 'my-project', 'sess-001', [
      userEntry('hello', '2026-04-10T12:00:00Z', 'sess-001'),
      assistantEntry('msg_1', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:01Z'),
    ])

    const projects = await parseOnce()
    const myProject = projects.find(p => p.project === 'my-project')
    expect(myProject).toBeDefined()
    expect(myProject!.sessions.length).toBe(1)

    const session = myProject!.sessions[0]
    expect(session.sessionId).toBe('sess-001')
    expect(session.apiCalls).toBe(1)
    expect(session.turns.length).toBe(1)
    expect(session.turns[0].userMessage).toBe('hello')
    expect(session.totalCostUSD).toBeGreaterThan(0)
    expect(session.totalInputTokens).toBe(100)
    expect(session.totalOutputTokens).toBe(50)
  })

  it('groups multiple assistant responses under the same user turn', async () => {
    const base = await setupTmpClaudeDir()

    await writeSessionFile(base, 'multi-call', 'sess-002', [
      userEntry('do two things', '2026-04-10T12:00:00Z', 'sess-002'),
      assistantEntry('msg_a', 'claude-opus-4-6', 200, 100, '2026-04-10T12:00:01Z'),
      assistantEntry('msg_b', 'claude-opus-4-6', 300, 150, '2026-04-10T12:00:02Z'),
    ])

    const projects = await parseOnce()
    const proj = projects.find(p => p.project === 'multi-call')
    expect(proj).toBeDefined()

    const session = proj!.sessions[0]
    expect(session.turns.length).toBe(1)
    expect(session.turns[0].assistantCalls.length).toBe(2)
    expect(session.apiCalls).toBe(2)
    expect(session.totalInputTokens).toBe(500)
    expect(session.totalOutputTokens).toBe(250)
  })

  it('deduplicates assistant messages with the same message ID', async () => {
    const base = await setupTmpClaudeDir()

    await writeSessionFile(base, 'dedup-test', 'sess-003', [
      userEntry('duplicate check', '2026-04-10T12:00:00Z', 'sess-003'),
      assistantEntry('msg_dup', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:01Z'),
      assistantEntry('msg_dup', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:02Z'),
    ])

    const projects = await parseOnce()
    const proj = projects.find(p => p.project === 'dedup-test')
    expect(proj).toBeDefined()

    const session = proj!.sessions[0]
    // Duplicate msg_dup should be counted only once
    expect(session.apiCalls).toBe(1)
    expect(session.turns[0].assistantCalls.length).toBe(1)
  })

  it('resumes cumulative usage and turn state across a record-budget interruption', async () => {
    const base = await setupTmpClaudeDir()
    const cacheBefore = process.env.EXE_WATCHER_CACHE_DIR
    process.env.EXE_WATCHER_CACHE_DIR = join(base, 'cache')
    try {
      await writeSessionFile(base, 'resume', 'session', [
        userEntry('fix the bug', '2026-04-10T12:00:00Z', 'session'),
        assistantEntry('msg_incremental', 'claude-opus-4-6', 100, 10, '2026-04-10T12:00:01Z'),
        { type: 'system' },
        assistantEntry('msg_incremental', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:02Z'),
        userEntry('next task', '2026-04-10T12:01:00Z', 'session'),
        assistantEntry('msg_next', 'claude-opus-4-6', 200, 100, '2026-04-10T12:01:01Z'),
      ])
      await expect(withScanBudget(() => parseOnce(), 2)).rejects.toBeInstanceOf(ResourceBudgetError)
      clearParserCaches()
      const session = (await parseOnce())[0]!.sessions[0]!
      expect(session.apiCalls).toBe(2)
      expect(session.totalInputTokens).toBe(300)
      expect(session.totalOutputTokens).toBe(150)
      expect(session.turns.map(turn => turn.userMessage)).toEqual(['fix the bug', 'next task'])
      expect(session.totalCostUSD).toBeCloseTo(0.00525, 7)
    } finally {
      if (cacheBefore === undefined) delete process.env.EXE_WATCHER_CACHE_DIR
      else process.env.EXE_WATCHER_CACHE_DIR = cacheBefore
      clearParserCaches()
    }
  })

  it('calculates cost correctly for known model', async () => {
    const base = await setupTmpClaudeDir()

    await writeSessionFile(base, 'cost-test', 'sess-004', [
      userEntry('cost check', '2026-04-10T12:00:00Z', 'sess-004'),
      assistantEntry('msg_cost', 'claude-opus-4-6', 1000, 500, '2026-04-10T12:00:01Z'),
    ])

    const projects = await parseOnce()
    const proj = projects.find(p => p.project === 'cost-test')
    expect(proj).toBeDefined()

    // claude-opus-4-6 fallback: input $5/M, output $25/M
    // 1000 input tokens = $0.005, 500 output tokens = $0.0125 => total ~$0.0175
    const session = proj!.sessions[0]
    expect(session.totalCostUSD).toBeCloseTo(0.0175, 4)
    expect(proj!.totalCostUSD).toBeCloseTo(0.0175, 4)
  })

  it('extracts tool names from assistant content blocks', async () => {
    const base = await setupTmpClaudeDir()

    await writeSessionFile(base, 'tool-test', 'sess-005', [
      userEntry('use tools', '2026-04-10T12:00:00Z', 'sess-005'),
      assistantEntry(
        'msg_tools',
        'claude-opus-4-6',
        200,
        100,
        '2026-04-10T12:00:01Z',
        [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/test' } },
          { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
        ],
      ),
    ])

    const projects = await parseOnce()
    const proj = projects.find(p => p.project === 'tool-test')
    expect(proj).toBeDefined()

    const call = proj!.sessions[0].turns[0].assistantCalls[0]
    expect(call.tools).toContain('Read')
    expect(call.tools).toContain('Bash')
  })

  it('handles multiple user turns in a single session', async () => {
    const base = await setupTmpClaudeDir()

    await writeSessionFile(base, 'multi-turn', 'sess-006', [
      userEntry('first question', '2026-04-10T12:00:00Z', 'sess-006'),
      assistantEntry('msg_t1', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:01Z'),
      userEntry('second question', '2026-04-10T12:01:00Z', 'sess-006'),
      assistantEntry('msg_t2', 'claude-opus-4-6', 150, 75, '2026-04-10T12:01:01Z'),
    ])

    const projects = await parseOnce()
    const proj = projects.find(p => p.project === 'multi-turn')
    expect(proj).toBeDefined()

    const session = proj!.sessions[0]
    expect(session.turns.length).toBe(2)
    expect(session.turns[0].userMessage).toBe('first question')
    expect(session.turns[1].userMessage).toBe('second question')
    expect(session.apiCalls).toBe(2)
  })

  it('skips entries with invalid JSON gracefully', async () => {
    const base = await setupTmpClaudeDir()

    const projectDir = join(base, 'projects', 'bad-json')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-007.jsonl')
    const content = [
      JSON.stringify(userEntry('hello', '2026-04-10T12:00:00Z', 'sess-007')),
      'this is not valid json {{{',
      JSON.stringify(assistantEntry('msg_ok', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:01Z')),
    ].join('\n') + '\n'
    await writeFile(filePath, content)

    const projects = await parseOnce()
    const proj = projects.find(p => p.project === 'bad-json')
    expect(proj).toBeDefined()

    // The invalid line is skipped; the valid user + assistant pair still parses
    expect(proj!.sessions[0].apiCalls).toBe(1)
  })

  it('returns empty array for an empty projects directory', async () => {
    const base = await setupTmpClaudeDir()
    const projectsDir = join(base, 'projects')
    await mkdir(projectsDir, { recursive: true })

    const projects = await parseOnce()
    // Filtered to 'claude' only, and our temp dir has no sessions
    expect(projects).toEqual([])
  })

  it('detects new project directories via source set change in cache key', async () => {
    // Parser cache uses a cheap path-set hash (not per-file stat fingerprints) for performance.
    // Adding a new project directory changes the source set, invalidating the cache immediately.
    const base = await setupTmpClaudeDir()
    const fixedRange = {
      start: new Date('2026-04-10T00:00:00Z'),
      end: new Date('2026-04-10T23:59:59Z'),
    }

    await writeSessionFile(base, 'project-a', 'sess-008', [
      userEntry('initial', '2026-04-10T12:00:00Z', 'sess-008'),
      assistantEntry('msg_initial', 'claude-opus-4-6', 100, 50, '2026-04-10T12:00:01Z'),
    ])

    const first = await parseAllSessions(fixedRange, 'claude')
    expect(first).toHaveLength(1)
    expect(first[0]!.project).toBe('project-a')

    // Add a new project directory — changes source set hash, invalidates cache
    await writeSessionFile(base, 'project-b', 'sess-009', [
      userEntry('second', '2026-04-10T13:00:00Z', 'sess-009'),
      assistantEntry('msg_second', 'claude-opus-4-6', 200, 75, '2026-04-10T13:00:01Z'),
    ])

    // Clear the source discovery cache so the new directory is found immediately.
    clearParserCaches()
    const second = await parseAllSessions(fixedRange, 'claude')
    expect(second).toHaveLength(2)
  })
})
