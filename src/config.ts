import { readFile, mkdir, rename } from 'fs/promises'
import { open } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

export type PlanId = 'claude-pro' | 'claude-max' | 'cursor-pro' | 'custom' | 'none'
export type PlanProvider = 'claude' | 'codex' | 'cursor' | 'all'

export type Plan = {
  id: PlanId
  monthlyUsd: number
  provider: PlanProvider
  resetDay?: number
  setAt: string
}

export type ExeWatcherConfig = {
  /** Optional beginning of the user's coding history, including gaps without logs. */
  historyStartDate?: string
  /** Additional Claude config roots (each contains projects/), e.g. old profiles. */
  claudeConfigDirs?: string[]
  currency?: {
    code: string
    symbol?: string
  }
  plan?: Plan
  modelAliases?: Record<string, string>
}

function getConfigDir(): string {
  const xdgConfig = process.env['XDG_CONFIG_HOME']
  return join(xdgConfig || join(homedir(), '.config'), 'exe-watcher')
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export async function readConfig(): Promise<ExeWatcherConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as ExeWatcherConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: ExeWatcherConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  const configPath = getConfigPath()
  const tmpPath = `${configPath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tmpPath, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmpPath, configPath)
}

export async function readPlan(): Promise<Plan | undefined> {
  const config = await readConfig()
  return config.plan
}

export async function savePlan(plan: Plan): Promise<void> {
  const config = await readConfig()
  config.plan = plan
  await saveConfig(config)
}

export async function clearPlan(): Promise<void> {
  const config = await readConfig()
  delete config.plan
  await saveConfig(config)
}

export function getConfigFilePath(): string {
  return getConfigPath()
}
