import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

function runCli(args: string[], home: string) {
  // The CLI resolves its config dir as XDG_CONFIG_HOME || <homedir>/.config
  // (src/config.ts getConfigDir). Overriding only HOME leaves XDG_CONFIG_HOME
  // inherited from the ambient environment, so on any machine that sets it the
  // CLI writes outside the temp home, exits 0, and the assertions below read a
  // file that was never going to be there. Pin both so the config location is
  // decided by this test rather than by the environment it happens to run in.
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
    },
    encoding: 'utf-8',
  })
}

describe('exe-watcher plan command', { timeout: 30_000 }, () => {
  it('persists plan set and clears on reset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'exe-watcher-cli-plan-'))

    try {
      const setResult = runCli(['plan', 'set', 'claude-max'], home)
      expect(setResult.status).toBe(0)

      const configPath = join(home, '.config', 'exe-watcher', 'config.json')
      const configRaw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(configRaw) as { plan?: { id?: string; monthlyUsd?: number } }
      expect(config.plan?.id).toBe('claude-max')
      expect(config.plan?.monthlyUsd).toBe(200)

      const resetResult = runCli(['plan', 'reset'], home)
      expect(resetResult.status).toBe(0)

      const afterResetRaw = await readFile(configPath, 'utf-8')
      const afterReset = JSON.parse(afterResetRaw) as { plan?: unknown }
      expect(afterReset.plan).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('shows invalid reset-day value in error output', async () => {
    const home = await mkdtemp(join(tmpdir(), 'exe-watcher-cli-plan-'))

    try {
      const result = runCli(['plan', 'set', 'claude-max', '--reset-day', '99'], home)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('--reset-day must be an integer from 1 to 28; got 99.')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
