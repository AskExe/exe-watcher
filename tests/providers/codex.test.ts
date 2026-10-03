import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../../src/providers/codex.js'
import { calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { cwd?: string; originator?: string; session_id?: string; model?: string } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: {
      cwd: opts.cwd ?? '/Users/test/myproject',
      originator: opts.originator ?? 'codex-cli',
      session_id: opts.session_id ?? 'sess-001',
      model: opts.model ?? 'gpt-5.3-codex',
    },
  })
}

function tokenCount(opts: {
  timestamp?: string
  last?: { input?: number; cached?: number; output?: number; reasoning?: number }
  total?: { input?: number; cached?: number; output?: number; reasoning?: number; total?: number }
  model?: string
}) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: opts.timestamp ?? '2026-04-14T10:01:00Z',
    payload: {
      type: 'token_count',
      info: {
        model: opts.model,
        last_token_usage: opts.last ? {
          input_tokens: opts.last.input ?? 0,
          cached_input_tokens: opts.last.cached ?? 0,
          output_tokens: opts.last.output ?? 0,
          reasoning_output_tokens: opts.last.reasoning ?? 0,
          total_tokens: (opts.last.input ?? 0) + (opts.last.cached ?? 0) + (opts.last.output ?? 0) + (opts.last.reasoning ?? 0),
        } : undefined,
        total_token_usage: opts.total ? {
          input_tokens: opts.total.input ?? 0,
          cached_input_tokens: opts.total.cached ?? 0,
          output_tokens: opts.total.output ?? 0,
          reasoning_output_tokens: opts.total.reasoning ?? 0,
          total_tokens: opts.total.total ?? ((opts.total.input ?? 0) + (opts.total.cached ?? 0) + (opts.total.output ?? 0) + (opts.total.reasoning ?? 0)),
        } : undefined,
      },
    },
  })
}

function functionCall(name: string, timestamp?: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: timestamp ?? '2026-04-14T10:00:30Z',
    payload: { type: 'function_call', name },
  })
}

function userMessage(text: string, timestamp?: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: timestamp ?? '2026-04-14T10:00:00Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  })
}

async function writeSession(dir: string, date: string, filename: string, lines: string[]) {
  const [year, month, day] = date.split('-')
  const sessionDir = join(dir, 'sessions', year!, month!, day!)
  await mkdir(sessionDir, { recursive: true })
  const filePath = join(sessionDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('codex provider - session discovery', () => {
  it('separates GPT cache writes from ordinary input and prices a cached large prompt correctly', async () => {
    const usage = { input_tokens: 300000, cached_input_tokens: 200000, cache_write_input_tokens: 50000,
      output_tokens: 1000, reasoning_output_tokens: 100, total_tokens: 301000 }
    const path = await writeSession(tmpDir, '2026-04-14', 'rollout-cache-writes.jsonl', [
      sessionMeta({ model: 'gpt-6-astra' }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', service_tier: 'priority' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:00Z', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } }),
    ])
    const parser = createCodexProvider(tmpDir).createSessionParser({ path, project: 'test', provider: 'codex' }, new Set())
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ inputTokens: 50000, cacheCreationInputTokens: 50000, cacheReadInputTokens: 200000, speed: 'fast' })
    // ($1 fresh + $1.25 writes + $0.40 reads + $0.075 output) * 2.
    expect(calls[0]!.costUSD).toBeCloseTo(5.45, 9)
  })

  it('updates cumulative baselines when switching from last-usage records to total-only records', async () => {
    const path = await writeSession(tmpDir, '2026-04-14', 'rollout-mixed-counters.jsonl', [
      sessionMeta(),
      tokenCount({ last: { input: 100, output: 10 }, total: { input: 100, output: 10, total: 110 } }),
      tokenCount({ timestamp: '2026-04-14T10:02:00Z', total: { input: 150, output: 20, total: 170 } }),
    ])
    const parser = createCodexProvider(tmpDir).createSessionParser({ path, project: 'test', provider: 'codex' }, new Set())
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls.map(c => c.inputTokens)).toEqual([100, 50])
    expect(calls.map(c => c.outputTokens)).toEqual([10, 10])
  })
  it('discovers sessions in YYYY/MM/DD structure', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-abc123.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codex')
    expect(sessions[0]!.project).toBe('Users-test-myproject')
    expect(sessions[0]!.path).toContain('rollout-abc123.jsonl')
  })

  it('includes archived sessions even when the active sessions directory is absent', async () => {
    const archived = join(tmpDir, 'archived_sessions')
    await mkdir(archived, { recursive: true })
    await writeFile(join(archived, 'rollout-old.jsonl'), [sessionMeta(), tokenCount({ last: { input: 100, output: 50 } })].join('\n') + '\n')
    const sources = await createCodexProvider(tmpDir).discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.path).toContain('archived_sessions')
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createCodexProvider('/nonexistent/path/that/does/not/exist')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('accepts case-insensitive originator (Codex Desktop)', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-desktop.jsonl', [
      sessionMeta({ originator: 'Codex Desktop' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
  })

  it('skips files without codex session_meta', async () => {
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'rollout-bad.jsonl'),
      JSON.stringify({ type: 'other', payload: {} }) + '\n',
    )

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })
})

describe('codex provider - JSONL parsing', () => {
  it('extracts token usage from last_token_usage', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-parse.jsonl', [
      sessionMeta({ session_id: 'sess-parse', model: 'gpt-5.3-codex' }),
      userMessage('fix the bug'),
      functionCall('exec_command'),
      functionCall('read_file'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, cached: 100, output: 200, reasoning: 50 },
        total: { total: 850 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('codex')
    expect(call.model).toBe('gpt-5.3-codex')
    expect(call.inputTokens).toBe(400)
    expect(call.cachedInputTokens).toBe(100)
    expect(call.cacheReadInputTokens).toBe(100)
    expect(call.outputTokens).toBe(200)
    expect(call.reasoningTokens).toBe(50)
    expect(call.tools).toEqual(['Bash', 'Read'])
    expect(call.userMessage).toBe('fix the bug')
    expect(call.sessionId).toBe('sess-parse')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.costUSD).toBeCloseTo(calculateCost('gpt-5.3-codex', 400, 200, 0, 100, 0, 'standard', 500))
    expect(call.deduplicationKey).toContain('codex:')
  })

  it('skips duplicate token_count events', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-dedup.jsonl', [
      sessionMeta(),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, output: 200 },
        total: { total: 700 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:01:01Z',
        last: { input: 500, output: 200 },
        total: { total: 700 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:02:00Z',
        last: { input: 300, output: 100 },
        total: { total: 1100 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.inputTokens).toBe(300)
  })
})


it('counts token events after oversized tool-output and compaction records', async () => {
  const padding = 'x'.repeat(33 * 1024 ** 2)
  const output = JSON.stringify({ timestamp: '2026-04-14T10:01:00Z', ordinal: 5, type: 'response_item', payload: { type: 'custom_tool_call_output', output: padding } })
  const compacted = JSON.stringify({ timestamp: '2026-04-14T10:01:00Z', ordinal: 6, type: 'compacted', payload: { replacement_history: padding } })
  const path = await writeSession(tmpDir, '2026-04-14', 'rollout-large.jsonl', [sessionMeta(), output, compacted,
    tokenCount({ last: { input: 100, output: 50 }, total: { input: 100, output: 50, total: 150 } }),
  ])
  const provider = createCodexProvider(tmpDir)
  const parser = provider.createSessionParser({ path, project: 'fixture', provider: 'codex' }, new Set())
  const calls = []
  for await (const call of parser.parse()) calls.push(call)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.inputTokens).toBe(100)
  expect(calls[0]!.outputTokens).toBe(50)
})


it('deduplicates a copied archived rollout by session identity, independent of path', async () => {
  const original = await writeSession(tmpDir, '2026-04-14', 'rollout-copy.jsonl', [sessionMeta(), tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } })])
  const archived = join(tmpDir, 'archived_sessions'); await mkdir(archived, { recursive: true })
  const copy = join(archived, 'rollout-copy.jsonl')
  const { readFile } = await import('fs/promises'); await writeFile(copy, await readFile(original))
  const provider = createCodexProvider(tmpDir), seen = new Set<string>(), calls = []
  for (const path of [original, copy]) for await (const call of provider.createSessionParser({ path, project: 'fixture', provider: 'codex' }, seen).parse()) calls.push(call)
  expect(calls).toHaveLength(1)
})
