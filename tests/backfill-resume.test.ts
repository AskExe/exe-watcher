import { DAILY_CACHE_VERSION } from '../src/daily-cache.js'
import { fillMissingDays } from '../src/day-aggregator.js'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

/**
 * Regression: a resource-budget abort during the daily-cache backfill used to discard
 * every day the scan had already resolved, so the cache never advanced, the gap grew by
 * one day per day, and `status --format menubar-json` exited 1 with empty stdout forever.
 *
 * These tests drive the real CLI against an isolated corpus with the scan budget tightened
 * (EXE_WATCHER_MAX_SCAN_BYTES) so one transcript takes several bounded scans.
 * Incomplete refreshes preserve checkpoints and label partial totals explicitly.
 */

const CLI = join(process.cwd(), 'src', 'cli.ts')

const SCAN_BYTE_CAP = 400 * 1024
const OVERSIZED_BYTES = 600 * 1024

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function midday(daysAgo: number): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0)
}

/** A claude transcript with one billable turn, padded to `minBytes`. */
function transcript(when: Date, id: string, minBytes: number): string {
  const ts = when.toISOString()
  const lines = [
    JSON.stringify({ type: 'user', timestamp: ts, sessionId: id, message: { role: 'user', content: 'hello' } }),
    JSON.stringify({
      type: 'assistant', timestamp: ts, sessionId: id,
      message: {
        id: `msg_${id}`, role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
  ]
  let out = `${lines.join('\n')}\n`
  let n = 0
  while (Buffer.byteLength(out) < minBytes) {
    out += `${JSON.stringify({ type: 'system', timestamp: ts, pad: 'x'.repeat(512), n: n++ })}\n`
  }
  return out
}

type Env = { home: string; cache: string }

function makeCorpus(): Env {
  const home = mkdtempSync(join(tmpdir(), 'exe-watcher-backfill-'))
  const cache = join(home, 'cache')
  const projectDir = join(home, '.claude', 'projects', '-tmp-fixture')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })

  // Day -3 is larger than one scan. It must resume inside the transcript;
  // retrying the entire file would never finish. Days -2 and -1 are small.
  for (const { ago, bytes } of [
    { ago: 3, bytes: OVERSIZED_BYTES },
    { ago: 2, bytes: 8 * 1024 },
    { ago: 1, bytes: 8 * 1024 },
  ]) {
    const when = midday(ago)
    const id = `0000000${ago}-0000-4000-8000-00000000000${ago}`
    const file = join(projectDir, `${id}.jsonl`)
    writeFileSync(file, transcript(when, id, bytes))
    // mtime decides which days a ranged scan even opens the file for.
    utimesSync(file, when, when)
  }

  // Seed the cache the way a healthy install looks four days ago, so the run has a gap.
  writeFileSync(join(cache, 'daily-cache.json'), JSON.stringify({
    version: DAILY_CACHE_VERSION, scopeKey: 'global', lastComputedDate: dateKey(midday(4)), days: [],
  }))
  return { home, cache }
}

function runStatus(env: Env): { status: number; stdout: string; stderr: string } {
  const args = ['tsx', CLI, 'status', '--format', 'menubar-json', '--period', 'week', '--provider', 'all', '--no-optimize']
  try {
    const stdout = execFileSync('npx', args, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: env.home,
        CLAUDE_CONFIG_DIR: join(env.home, '.claude'),
        CODEX_HOME: join(env.home, '.codex'),
        XDG_DATA_HOME: join(env.home, 'share'),
        XDG_CACHE_HOME: join(env.home, 'xdgcache'),
        EXE_WATCHER_CACHE_DIR: env.cache,
        EXE_WATCHER_MAX_SCAN_BYTES: String(SCAN_BYTE_CAP),
      },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

type CacheShape = {
  lastComputedDate: string | null
  dates: string[]
  backfill?: { blockedDate: string; attempts: number } | null
  partialDates?: string[]
}

function readCache(env: Env): CacheShape {
  const path = join(env.cache, 'daily-cache.json')
  expect(existsSync(path)).toBe(true)
  const c = JSON.parse(readFileSync(path, 'utf-8'))
  return {
    lastComputedDate: c.lastComputedDate,
    dates: (c.days ?? []).map((d: { date: string }) => d.date),
    backfill: c.backfill,
    partialDates: c.partialDates,
  }
}

describe('backfill survives a resource-budget abort', { timeout: 300_000 }, () => {
  it('finishes a fresh install across small scans instead of abandoning oversized transcripts', () => {
    const env = makeCorpus()
    try {
      rmSync(join(env.cache, 'daily-cache.json'))
      let payload: any
      for (let pass = 0; pass < 6; pass++) {
        const result = runStatus(env)
        expect(result.status).toBe(0)
        payload = JSON.parse(result.stdout)
        if (!payload.savedHistory) break
      }
      expect(payload.savedHistory).toBeUndefined()
      expect(payload.current.calls).toBe(3)
      expect(readCache(env).partialDates ?? []).toEqual([])
    } finally { rmSync(env.home, { recursive: true, force: true }) }
  })
  it('returns a pending week and parks a cursor without claiming a real zero', () => {
    const env = makeCorpus()
    const run = runStatus(env)

    expect(run.status).toBe(0)
    const payload = JSON.parse(run.stdout)
    expect(payload.savedHistory.hasData).toBe(false)
    expect(payload.savedHistory.message).toContain('Missing days are unknown')
    expect(payload.diagnostics.warnings.some((w: string) => w.includes('history backfill paused'))).toBe(true)

    const after = readCache(env)
    expect(after.backfill?.blockedDate).toBe(dateKey(midday(3)))
    expect(after.backfill?.attempts).toBe(0) // A checkpoint advanced inside the file.
    rmSync(env.home, { recursive: true, force: true })
  })

  it('makes strictly more progress on every run and never restarts from zero', () => {
    const env = makeCorpus()
    const yesterday = dateKey(midday(1))

    let previousDays = 0
    for (let i = 0; i < 4; i++) {
      const result = runStatus(env)
      expect(result.status).toBe(0)
      const payload = JSON.parse(result.stdout)
      if (payload.savedHistory) expect(payload.savedHistory.message).toContain('Missing days are unknown')
      const c = readCache(env)
      // Days already resolved are never dropped by a later abort.
      expect(c.dates.length).toBeGreaterThanOrEqual(previousDays)
      previousDays = c.dates.length
    }

    const final = readCache(env)
    expect(final.partialDates ?? []).toEqual([])
    expect(final.dates).toContain(dateKey(midday(3)))
    expect(final.dates).toContain(dateKey(midday(2)))
    expect(final.dates).toContain(yesterday)
    expect(final.lastComputedDate).toBe(yesterday)
    expect(final.backfill ?? null).toBeNull()
    const loaded = JSON.parse(runStatus(env).stdout)
    expect(loaded.current.cost).toBeGreaterThan(0)
    expect(loaded.savedHistory).toBeUndefined()
    expect(loaded.current.calls).toBe(3)
    rmSync(env.home, { recursive: true, force: true })
  })

  it('repairs previously skipped dates without recalculating a completed priced day', () => {
    const env = makeCorpus()
    try {
      const days = fillMissingDays(midday(7), midday(1), [])
      const verified = days.find(day => day.date === dateKey(midday(2)))!
      verified.cost = 123; verified.calls = 17
      const partialDate = dateKey(midday(3))
      writeFileSync(join(env.cache, 'daily-cache.json'), JSON.stringify({
        version: DAILY_CACHE_VERSION, scopeKey: 'global', lastComputedDate: dateKey(midday(1)),
        days, partialDates: [partialDate],
      }))
      let payload: any
      for (let pass = 0; pass < 6; pass++) {
        const result = runStatus(env)
        expect(result.status).toBe(0)
        payload = JSON.parse(result.stdout)
        if (!payload.savedHistory) break
      }
      expect(payload.savedHistory).toBeUndefined()
      const final = JSON.parse(readFileSync(join(env.cache, 'daily-cache.json'), 'utf8'))
      expect(final.partialDates).toEqual([])
      expect(final.days.find((day: { date: string }) => day.date === verified.date)).toEqual(verified)
      expect(final.days.find((day: { date: string }) => day.date === partialDate).calls).toBe(1)
      expect(payload.current.cost).toBeGreaterThan(123)
    } finally { rmSync(env.home, { recursive: true, force: true }) }
  })

  it('pauses a truly blocked record after bounded retries while preserving later days', () => {
    const env = makeCorpus()
    try {
      const blocked = dateKey(midday(3))
      const file = join(env.home, '.claude/projects/-tmp-fixture/00000003-0000-4000-8000-000000000003.jsonl')
      // One record cannot be checkpointed partway through its JSON. Its safe
      // prefix advances once, then repeated attempts must stop changing the token.
      writeFileSync(file, transcript(midday(3), 'blocked', 1) + JSON.stringify({ pad: 'x'.repeat(OVERSIZED_BYTES) }) + '\n')
      utimesSync(file, midday(3), midday(3))
      // Older, verified empty days already exist; only the forward gap remains.
      writeFileSync(join(env.cache, 'daily-cache.json'), JSON.stringify({
        version: DAILY_CACHE_VERSION, scopeKey: 'global', lastComputedDate: dateKey(midday(4)),
        days: fillMissingDays(midday(6), midday(4), []),
      }))
      let payload: any
      for (let pass = 0; pass < 7; pass++) {
        const result = runStatus(env)
        expect(result.status).toBe(0)
        payload = JSON.parse(result.stdout)
      }
      const before = payload.savedHistory.progressToken
      const next = JSON.parse(runStatus(env).stdout)
      expect(next.savedHistory.progressToken).toBe(before)
      expect(next.savedHistory.message).toContain('Missing days are unknown')
      expect(next.current.calls).toBe(2)
      expect(readCache(env).partialDates).toContain(blocked)
      expect(readCache(env).lastComputedDate).toBe(dateKey(midday(1)))
    } finally { rmSync(env.home, { recursive: true, force: true }) }
  })
})
