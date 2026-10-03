import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

let testHome: string
beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'watcher-process-'))
  const project = join(testHome, '.claude/projects/fixture')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'fixture', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n')
})
afterAll(() => rmSync(testHome, { recursive: true, force: true }))
function testEnvironment() {
  return { ...process.env, HOME: testHome, CLAUDE_CONFIG_DIR: join(testHome, '.claude'), CODEX_HOME: join(testHome, '.codex'), EXE_WATCHER_CACHE_DIR: join(testHome, '.cache/exe-watcher'), XDG_CONFIG_HOME: join(testHome, '.config') }
}

const CLI_PATH = join(process.cwd(), 'dist', 'cli.js')
const NODE = process.execPath

/**
 * Spawn the compiled CLI and collect exit code + output.
 * Uses the built dist/cli.js to test real process behavior.
 */
function runCli(
  args: string[],
  options: {
    stdin?: 'pipe' | 'ignore'
    timeout?: number
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeout = options.timeout ?? 15_000
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE, [CLI_PATH, ...args], {
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
      env: testEnvironment(),
    })

    let stdout = ''
    let stderr = ''

    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`CLI timed out after ${timeout}ms. stdout: ${stdout}\nstderr: ${stderr}`))
    }, timeout)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe('process lifecycle', () => {
  // -----------------------------------------------------------------------
  // SIGPIPE handling
  // -----------------------------------------------------------------------

  it('does not crash with EPIPE when stdout consumer exits early', async () => {
    // Pipe CLI output to a reader that closes after one line.
    const proc = spawn(NODE, [CLI_PATH, 'status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: testEnvironment(),
    })

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      let stderr = ''
      let gotFirstChunk = false

      proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.stdout!.on('data', () => {
        if (!gotFirstChunk) {
          gotFirstChunk = true
          // Simulate SIGPIPE: destroy stdout so the CLI writes to a broken pipe
          proc.stdout!.destroy()
        }
      })

      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve({ code: null, stderr })
      }, 15_000)

      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stderr })
      })
      proc.on('error', reject)
    })

    // The CLI should exit (possibly with non-zero) but NOT crash with an
    // uncaught EPIPE exception. If it did, stderr would contain "EPIPE".
    expect(result.stderr).not.toContain('EPIPE')
  }, 20_000)

  // -----------------------------------------------------------------------
  // Exit codes
  // -----------------------------------------------------------------------

  describe('exit codes', () => {
    it('--version exits with code 0', async () => {
      const result = await runCli(['--version'])
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('--help exits with code 0', async () => {
      const result = await runCli(['--help'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('exe-watcher')
    })

    it('invalid command exits with non-zero code', async () => {
      const result = await runCli(['this-command-does-not-exist-xyz'])
      expect(result.code).not.toBe(0)
    })

    it('status --format json exits with code 0', async () => {
      const result = await runCli(['status', '--format', 'json'])
      expect(result.code).toBe(0)
      // Should produce valid JSON
      const parsed = JSON.parse(result.stdout)
      expect(parsed).toHaveProperty('today')
    }, 15_000)
  })

  // -----------------------------------------------------------------------
  // Large output handling
  // -----------------------------------------------------------------------

  it('report --format json -p all exits cleanly regardless of data volume', async () => {
    const result = await runCli(['report', '--format', 'json', '-p', 'all'], { timeout: 30_000 })
    expect(result.code).toBe(0)
    // The output should be valid JSON
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  }, 35_000)

  // -----------------------------------------------------------------------
  // Concurrent runs
  // -----------------------------------------------------------------------

  it('two concurrent status processes complete without corrupting output', async () => {
    const [a, b] = await Promise.all([
      runCli(['status', '--format', 'json']),
      runCli(['status', '--format', 'json']),
    ])

    expect(a.code).toBe(0)
    expect(b.code).toBe(0)

    // Both should produce independent valid JSON
    const parsedA = JSON.parse(a.stdout)
    const parsedB = JSON.parse(b.stdout)
    expect(parsedA).toHaveProperty('today')
    expect(parsedB).toHaveProperty('today')
  }, 30_000)

  // -----------------------------------------------------------------------
  // stdin not required
  // -----------------------------------------------------------------------

  it('works with stdin set to /dev/null (no TTY)', async () => {
    const result = await runCli(['status', '--format', 'json'], { stdin: 'ignore' })
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toHaveProperty('today')
  }, 15_000)
})
