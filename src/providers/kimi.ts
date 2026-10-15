import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readSessionLines } from '../fs-utils.js'
import { calculateCost, getModelCosts } from '../models.js'
import { chargeRead, ResourceBudgetError } from '../resource-budget.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

/** Kimi Code's wire log is authoritative for billed calls. Context messages and
 * token_counting.measured describe context size, not additional API usage.
 */
export function createKimiProvider(home?: string): Provider {
  const root = () => home ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code')
  return {
    name: 'kimi', displayName: 'Kimi',
    modelDisplayName: model => model === 'kimi-k3' ? 'Kimi K3' : model,
    toolDisplayName: tool => tool,
    async discoverSessions(): Promise<SessionSource[]> {
      const projects = new Map<string, string>()
      const catalog = join(root(), 'workspaces.json')
      try {
        const size = (await stat(catalog)).size
        if (size <= 2 * 1024 * 1024) {
          chargeRead(size)
          const data = JSON.parse(await readFile(catalog, 'utf8'))
          for (const [id, entry] of Object.entries(data.workspaces ?? {})) {
            if (entry && typeof entry === 'object' && 'root' in entry && typeof entry.root === 'string') {
              projects.set(id, basename(entry.root))
            }
          }
        }
      } catch (err) { if (err instanceof ResourceBudgetError) throw err }
      const sources: SessionSource[] = []
      async function walk(dir: string, project: string, depth: number): Promise<void> {
        if (depth > 8) return
        chargeRead(0)
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          const path = join(dir, entry.name)
          // Never follow symlinks into another profile or read credentials/logs.
          if (entry.isDirectory()) await walk(path, project, depth + 1)
          else if (entry.isFile() && entry.name === 'wire.jsonl') sources.push({ path, project, provider: 'kimi' })
        }
      }
      const sessions = join(root(), 'sessions')
      for (const entry of await readdir(sessions, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const project = projects.get(entry.name) ?? entry.name.replace(/^wd_/, '').replace(/_[a-f\d]{12}$/, '')
        await walk(join(sessions, entry.name), project, 0)
      }
      return sources.sort((a, b) => a.path.localeCompare(b.path))
    },
    createSessionParser(source: SessionSource, seenKeys: Set<string>) {
      const warnings: string[] = []
      return {
        warnings,
        async *parse(): AsyncGenerator<ParsedProviderCall> {
          const sessionDir = source.path.split('/').reverse().find(part => part.startsWith('session_')) ?? basename(dirname(source.path))
          const agent = basename(dirname(source.path))
          for await (const line of readSessionLines(source.path)) {
            // Most wire records contain prompts, tools or large context blobs.
            // Avoid parsing them; only usage.record carries token accounting.
            if (!/"type"\s*:\s*"usage\.record"/.test(line.slice(0, 256))) continue
            let data: Record<string, unknown>
            try { data = JSON.parse(line) } catch { continue }
            if (data.type !== 'usage.record' || !data.usage || typeof data.usage !== 'object') continue
            const usage = data.usage as Record<string, unknown>
            const fields = ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const
            const values = fields.map(field => usage[field] ?? 0)
            if (values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
              if (!warnings.length) warnings.push('Kimi Code has invalid token counts; those records are excluded.')
              continue
            }
            const [input, output, read, write] = values as [number, number, number, number]
            if (input + output + read + write === 0) continue
            if (typeof data.time !== 'number' || !Number.isFinite(new Date(data.time).getTime()) || typeof data.model !== 'string') {
              if (!warnings.length) warnings.push('Kimi Code has usage without a valid timestamp or model; those records are excluded.')
              continue
            }
            const rawModel = data.model.replace(/^kimi-code\//, '')
            // These are explicit K3 context-window variants. The rotating
            // kimi-for-coding alias stays unpriced unless a user maps its model.
            const model = ['k3', 'k3-256k'].includes(rawModel) ? 'kimi-k3' : rawModel
            if (!getModelCosts(model)) {
              const warning = `No API pricing for model "${model}"; its tokens are counted but its cost is excluded. Configure a model alias only when the underlying API model is known.`
              if (!warnings.includes(warning)) warnings.push(warning)
            }
            const key = 'kimi:' + createHash('sha256').update(JSON.stringify([
              data.agentId ?? agent, data.time, data.model, input, output, read, write,
            ])).digest('hex')
            if (seenKeys.has(key)) continue
            seenKeys.add(key)
            yield {
              provider: 'kimi', model, inputTokens: input, outputTokens: output,
              cacheCreationInputTokens: write, cacheReadInputTokens: read, cachedInputTokens: read,
              reasoningTokens: 0, webSearchRequests: 0,
              costUSD: calculateCost(model, input, output, write, read, 0, 'standard', input + read + write),
              tools: [], bashCommands: [], timestamp: new Date(data.time).toISOString(),
              speed: 'standard', deduplicationKey: key, userMessage: '', sessionId: `${sessionDir}/${agent}`,
            }
          }
        },
      }
    },
  }
}

export const kimi = createKimiProvider()
