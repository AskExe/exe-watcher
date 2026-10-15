import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const entry = process.env.WATCHER_TEST_CLI_ENTRY ?? join(process.cwd(), 'src/cli.ts')
const runtime = process.env.WATCHER_TEST_NODE ?? process.execPath
const cliArgs = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry]
let home: string
let env: NodeJS.ProcessEnv
const now = new Date()
const timestamp = now.toISOString()
const pricing = Object.fromEntries(['gpt-5.4', 'claude-sonnet-4-6', 'glm-5.3', 'kimi-k3'].map(model => [model, {
  inputCostPerToken: 2e-6, outputCostPerToken: 8e-6, cacheReadCostPerToken: 0.2e-6,
  cacheWriteCostPerToken: 2.5e-6, webSearchCostPerRequest: 0.01, fastMultiplier: 1,
}]))
async function jsonFile(path: string, records: unknown[]) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
}
async function run(provider = 'all') {
  const { stdout } = await exec(runtime, [...cliArgs, 'report', '--format', 'json', '--period', 'today', '--provider', provider], { env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout)
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'watcher-clean-install-'))
  // No Watcher config, client executables, API keys or developer HOME are used.
  env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'EXE_WATCHER_CACHE_DIR']) delete env[key]
  await mkdir(join(home, '.cache/exe-watcher'), { recursive: true })
  // Supply a fresh public rate catalog to keep the test independent of network availability.
  await writeFile(join(home, '.cache/exe-watcher/litellm-pricing.json'), JSON.stringify({ schemaVersion: 2, timestamp: Date.now(), warnings: [], data: pricing }))
})
afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }) })

describe.sequential('clean install local usage and API-equivalent pricing', { timeout: 60_000 }, () => {
  it('returns an honest empty report before any supported tool has recorded usage', async () => {
    const report = await run()
    expect(report.overview.calls).toBe(0)
    expect(report.overview.cost).toBe(0)
    expect(report.costBasis).toBe('api-equivalent')
  })

  it('finds default Codex, Claude Code, native Kimi and OpenCode locations without setup', async () => {
    await jsonFile(join(home, '.claude/projects/fixture/session.jsonl'), [{ type: 'assistant', timestamp, sessionId: 'claude-fixture', message: { id: 'claude-1', model: 'zai/glm-5.3', content: [], usage: { input_tokens: 100000, output_tokens: 50000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 10000 } } }])
    await jsonFile(join(home, '.codex/sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'), 'rollout-fixture.jsonl'), [
      { type: 'session_meta', timestamp, payload: { id: 'codex-fixture', originator: 'codex-cli', cwd: '/fixture', model: 'gpt-5.4' } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { model: 'gpt-5.4', total_token_usage: { input_tokens: 120000, cached_input_tokens: 20000, output_tokens: 50000, reasoning_output_tokens: 0, total_tokens: 170000 } } } },
    ])
    await jsonFile(join(home, '.kimi-code/sessions/workspace/session_fixture/agents/agent-0/wire.jsonl'), [{ type: 'usage.record', time: now.getTime(), agentId: 'agent-0', model: 'kimi-code/k3', usage: { inputOther: 100000, output: 50000, inputCacheRead: 20000, inputCacheCreation: 10000 } }])
    await mkdir(join(home, '.local/share/opencode'), { recursive: true })
    const db = new DatabaseSync(join(home, '.local/share/opencode/opencode.db'))
    try {
      db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_archived INTEGER, parent_id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)')
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL, NULL)').run('open-fixture', '/fixture', 'fixture', now.getTime())
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('open-1', 'open-fixture', now.getTime(), JSON.stringify({ role: 'assistant', modelID: 'moonshot/kimi-k3', cost: 999, tokens: { input: 100000, output: 50000, reasoning: 0, cache: { read: 20000, write: 10000 } } }))
    } finally { db.close() }

    const report = await run()
    expect(report.overview.calls).toBe(4)
    expect(report.models.map((m: { name: string }) => m.name).sort()).toEqual(['GPT-5.4', 'glm-5.3', 'kimi-k3'])
    expect(report.models.find((m: { name: string }) => m.name === 'kimi-k3').calls).toBe(2)
    // Codex input includes cache reads, while the other clients record them separately.
    expect(report.overview.tokens).toEqual({ input: 400000, output: 200000, cacheRead: 80000, cacheWrite: 30000 })
    // $2.491 at the fixture's public list rates, displayed to the nearest cent.
    expect(report.overview.cost).toBe(2.49)
    // OpenCode's old recorded invoice is deliberately different from current API rates.
    expect(report.overview.cost).toBeLessThan(10)
    expect(report.warnings.filter((warning: string) => warning.includes('No API pricing'))).toEqual([])
  })

  it('keeps the same totals across restarts and provider filters', async () => {
    const first = await run(), second = await run()
    expect(second.overview).toEqual(first.overview)
    let cost = 0, calls = 0
    for (const provider of ['claude', 'codex', 'kimi', 'opencode']) {
      const filtered = await run(provider)
      expect(filtered.overview.calls, provider).toBe(1)
      cost += filtered.overview.cost; calls += filtered.overview.calls
    }
    expect(cost).toBeCloseTo(first.overview.cost, 9)
    expect(calls).toBe(first.overview.calls)
  })

  it('discovers new sessions after startup and preserves unknown-model tokens with an explicit warning', async () => {
    await jsonFile(join(home, '.claude/projects/new-tool/unknown.jsonl'), [{ type: 'assistant', timestamp, sessionId: 'unknown-fixture', message: { id: 'unknown-1', model: 'private-model-with-no-price', content: [], usage: { input_tokens: 17, output_tokens: 9 } } }])
    const report = await run()
    expect(report.overview.calls).toBe(5)
    expect(report.overview.tokens.input).toBe(400017)
    expect(report.models.find((m: { name: string }) => m.name === 'private-model-with-no-price')).toMatchObject({ calls: 1, inputTokens: 17, outputTokens: 9, cost: 0 })
    expect(report.warnings.some((warning: string) => warning.includes('private-model-with-no-price') && warning.includes('cost is excluded'))).toBe(true)
    const cached = await run()
    expect(cached.overview).toEqual(report.overview)
    expect(cached.warnings.some((warning: string) => warning.includes('private-model-with-no-price'))).toBe(true)
  })
})
