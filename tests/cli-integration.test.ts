import { execSync } from 'child_process'
import { join } from 'path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

let testHome: string
beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'watcher-cli-smoke-'))
  const project = join(testHome, '.claude/projects/fixture')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'session.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'fixture', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n')
})
afterAll(() => rmSync(testHome, { recursive: true, force: true }))

const CLI = join(process.cwd(), 'dist', 'cli.js')

function run(args: string, extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: testHome, CLAUDE_CONFIG_DIR: join(testHome, '.claude'), CODEX_HOME: join(testHome, '.codex'), EXE_WATCHER_CACHE_DIR: join(testHome, '.cache/exe-watcher'), XDG_CONFIG_HOME: join(testHome, '.config'), ...extraEnv },
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    }
  }
}

describe('exe-watcher --version', () => {
  it('outputs a semver version number and exits 0', () => {
    const { stdout, status } = run('--version')
    expect(status).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('exe-watcher --help', () => {
  it('outputs usage info with command list and exits 0', () => {
    const { stdout, status } = run('--help')
    expect(status).toBe(0)
    expect(stdout).toContain('Usage:')
    expect(stdout).toContain('exe-watcher')
    expect(stdout).toContain('Commands:')
    expect(stdout).toContain('report')
    expect(stdout).toContain('status')
    expect(stdout).toContain('optimize')
    expect(stdout).toContain('currency')
  })
})

describe('exe-watcher status', () => {
  it('returns failure instead of successful zero when the current scan exceeds its budget', { timeout: 15_000 }, () => {
    const result = run('status --format menubar-json --period today --no-optimize', { EXE_WATCHER_MAX_SCAN_BYTES: '1' })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Resource limit reached')
  })
  it('badge refresh leaves historical cache untouched', { timeout: 15_000 }, () => {
    const cachePath = join(testHome, '.cache/exe-watcher/daily-cache.json')
    mkdirSync(join(testHome, '.cache/exe-watcher'), { recursive: true })
    const old = JSON.stringify({ version: 8, scopeKey: 'global', lastComputedDate: '2025-07-01', days: [], revalidatedAt: 0 })
    writeFileSync(cachePath, old)
    const result = run('status --format menubar-json --period today --no-optimize')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).current.cost).toBeGreaterThan(0)
    expect(readFileSync(cachePath, 'utf8')).toBe(old)
  })
  it('clears an old backfill cursor after a complete repricing scan', { timeout: 15_000 }, () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(12, 0, 0, 0)
    writeFileSync(join(testHome, '.claude/projects/fixture/older.jsonl'), JSON.stringify({ type: 'assistant', timestamp: yesterday.toISOString(), message: { id: 'older', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n')
    const cacheDir = join(testHome, '.cache/exe-watcher')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'daily-cache.json'), JSON.stringify({ version: 8, scopeKey: 'global',
      lastComputedDate: null, days: [], backfill: { blockedDate: yesterday.toISOString().slice(0, 10), attempts: 1 } }))
    const result = run('status --format menubar-json --period all --no-optimize')
    expect(result.status).toBe(0)
    const saved = JSON.parse(readFileSync(join(cacheDir, 'daily-cache.json'), 'utf8'))
    expect(saved.backfill).toBeNull()
    expect(saved.partialDates).toEqual([])
    expect(saved.days.length).toBeGreaterThan(0)
    expect(JSON.parse(result.stdout).pricing.basis).toBe('latest-rates')
  })
  it('outputs Today/Month line with cost and exits 0', { timeout: 15_000 }, () => {
    const { stdout, status } = run('status')
    expect(status).toBe(0)
    expect(stdout).toContain('Today')
    expect(stdout).toContain('Month')
    expect(stdout).toMatch(/\$[\d,.]+/)
  })

  it('outputs valid JSON with today/month keys when --format json', { timeout: 15_000 }, () => {
    const { stdout, status } = run('status --format json')
    expect(status).toBe(0)
    const data = JSON.parse(stdout.trim())
    expect(data).toHaveProperty('today')
    expect(data).toHaveProperty('month')
    expect(data).toHaveProperty('currency')
    expect(typeof data.today.cost).toBe('number')
    expect(typeof data.today.calls).toBe('number')
  })

  it('outputs valid menubar JSON with generated key when --format menubar-json', { timeout: 15_000 }, () => {
    const { stdout, status } = run('status --format menubar-json')
    expect(status).toBe(0)
    const data = JSON.parse(stdout.trim())
    expect(data).toHaveProperty('generated')
    expect(data).toHaveProperty('current')
    expect(data.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof data.current.cost).toBe('number')
  })
})

describe('exe-watcher report', () => {
  it('outputs valid JSON with generated key when --format json -p today', { timeout: 15_000 }, () => {
    const { stdout, status } = run('report --format json -p today')
    expect(status).toBe(0)
    const data = JSON.parse(stdout.trim())
    expect(data).toHaveProperty('generated')
    expect(data).toHaveProperty('currency')
  })
})

describe('exe-watcher optimize', () => {
  it('runs without error and exits 0', { timeout: 15_000 }, () => {
    const { status } = run('optimize')
    expect(status).toBe(0)
  })
})

describe('exe-watcher currency', () => {
  it('shows current currency and exits 0', () => {
    const { stdout, status } = run('currency')
    expect(status).toBe(0)
    expect(stdout).toContain('Currency:')
  })
})

describe('exe-watcher compare', () => {
  it('shows compare help text when --help and exits 0', () => {
    const { stdout, status } = run('compare --help')
    expect(status).toBe(0)
    expect(stdout).toContain('Compare')
    expect(stdout).toContain('--period')
  })
})

describe('exe-watcher unknown command', () => {
  it('exits non-zero for a nonexistent subcommand', () => {
    const { status } = run('nonexistent-command')
    expect(status).not.toBe(0)
  })
})
