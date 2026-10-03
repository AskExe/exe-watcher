import { readdir, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'

import { readConfig } from '../config.js'
import type { Provider, SessionSource, SessionParser } from './types.js'

const shortNames: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4': 'Opus 4',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-haiku': 'Haiku 3.5',
}

function getClaudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

function getDesktopSessionsDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions')
  return join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')
}

async function findDesktopProjectDirs(base: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    const entries = await readdir(dir).catch(() => [])
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      const s = await stat(full).catch(() => null)
      if (!s?.isDirectory()) continue
      if (entry === 'projects') {
        const projectDirs = await readdir(full).catch(() => [])
        for (const pd of projectDirs) {
          const pdFull = join(full, pd)
          const pdStat = await stat(pdFull).catch(() => null)
          if (pdStat?.isDirectory()) results.push(pdFull)
        }
      } else {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(base, 0)
  return results
}

export const claude: Provider = {
  name: 'claude',
  displayName: 'Claude',

  modelDisplayName(model: string): string {
    const canonical = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
    for (const [key, name] of Object.entries(shortNames)) {
      if (canonical.startsWith(key)) return name
    }
    return canonical
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  async discoverSessions(): Promise<SessionSource[]> {
    const sources: SessionSource[] = []

    const config = await readConfig()
    const roots = new Set([getClaudeDir(), ...(config.claudeConfigDirs ?? [])])
    for (const root of roots) {
      const projectsDir = join(root.startsWith('~/') ? join(homedir(), root.slice(2)) : resolve(root), 'projects')
      try {
        const entries = await readdir(projectsDir)
        for (const dirName of entries) {
          const dirPath = join(projectsDir, dirName)
          const dirStat = await stat(dirPath).catch(() => null)
          if (dirStat?.isDirectory()) {
            sources.push({ path: dirPath, project: dirName, provider: 'claude' })
          }
        }
      } catch {}
    }

    const desktopDirs = await findDesktopProjectDirs(getDesktopSessionsDir())
    for (const dirPath of desktopDirs) {
      sources.push({ path: dirPath, project: basename(dirPath), provider: 'claude' })
    }

    return [...new Map(sources.map(source => [source.path, source])).values()]
  },

  createSessionParser(): SessionParser {
    return {
      async *parse() {},
    }
  },
}
