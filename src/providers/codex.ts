import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { cachedDiscoveryHeader, flushDiscoveryCache } from '../discovery-cache.js'
import { readSessionFile, readSessionFirstLine, readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

const toolNameMap: Record<string, string> = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
}

type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    model?: string
    name?: string
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

function getCodexDir(override?: string): string {
  return override ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function sanitizeProject(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-')
}

async function readFirstLine(filePath: string): Promise<CodexEntry | null> {
  const line = await readSessionFirstLine(filePath)
  if (!line?.trim()) return null
  try {
    return JSON.parse(line) as CodexEntry
  } catch {
    return null
  }
}

/** The only facts discovery needs from the header. Everything else is reparsed on demand. */
type CodexHeader = { project: string }

async function readCodexHeader(filePath: string): Promise<CodexHeader | null> {
  const entry = await readFirstLine(filePath)
  const valid = entry?.type === 'session_meta' &&
    typeof entry.payload?.originator === 'string' &&
    entry.payload.originator.toLowerCase().startsWith('codex')
  if (!valid) return null
  return { project: sanitizeProject(entry.payload?.cwd ?? 'unknown') }
}

async function discoverSessionsInDir(codexDir: string): Promise<SessionSource[]> {
  const sessionsDir = join(codexDir, 'sessions')
  const sources: SessionSource[] = []

  let years: string[]
  try {
    years = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const months = await readdir(yearDir).catch(() => [] as string[])

    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const days = await readdir(monthDir).catch(() => [] as string[])

      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const files = await readdir(dayDir).catch(() => [] as string[])

        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          const filePath = join(dayDir, file)
          const s = await stat(filePath).catch(() => null)
          if (!s?.isFile()) continue

          // Codex embeds the full instruction blob in session_meta, so this header
          // averages ~63 KiB. Cached against (dev, ino, size, mtime, ctime) it costs
          // nothing on an unchanged file — and session files are append-only, so an
          // unchanged fingerprint means an unchanged first line.
          const header = await cachedDiscoveryHeader('codex', filePath, s, () => readCodexHeader(filePath))
          if (!header) continue

          sources.push({ path: filePath, project: header.project, provider: 'codex' })
        }
      }
    }
  }

  return sources
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return info?.info?.model
    ?? info?.info?.model_name
    ?? sessionModel
    ?? 'gpt-5'
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  const parserWarnings: string[] = []
  return {
    warnings: parserWarnings,
    async *parse(): AsyncGenerator<ParsedProviderCall> {

      // Fix 1: Validate expected session format — detect schema changes
      let hasSessionMeta = false
      let hasTokenCounts = false
      let sessionModel: string | undefined
      let sessionId = ''
      let prevCumulativeTotal = 0
      let prevInput = 0
      let prevCached = 0
      let prevOutput = 0
      let prevReasoning = 0
      let pendingTools: string[] = []
      let pendingUserMessage = ''

      let lineCount = 0
      for await (const line of readSessionLines(source.path)) {
        if (!line.trim()) continue
        lineCount++
        let entry: CodexEntry
        try {
          entry = JSON.parse(line) as CodexEntry
        } catch {
          continue
        }

        if (entry.type === 'session_meta') {
          hasSessionMeta = true
          sessionId = entry.payload?.session_id ?? basename(source.path, '.jsonl')
          sessionModel = entry.payload?.model
          continue
        }

        // Codex stores the actual model name (e.g. "gpt-5.4") in turn_context events,
        // not in session_meta or token_count. Capture it so we don't fall back to "gpt-5".
        if (entry.type === 'turn_context' && entry.payload?.model) {
          sessionModel = entry.payload.model
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          const rawName = entry.payload.name ?? ''
          pendingTools.push(toolNameMap[rawName] ?? rawName)
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
          const texts = (entry.payload.content ?? [])
            .filter(c => c.type === 'input_text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) pendingUserMessage = texts.join(' ')
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
          hasTokenCounts = true
          const info = entry.payload.info
          if (!info) continue

          const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
          if (cumulativeTotal > 0 && cumulativeTotal === prevCumulativeTotal) continue
          prevCumulativeTotal = cumulativeTotal

          const last = info.last_token_usage
          let inputTokens = 0
          let cachedInputTokens = 0
          let outputTokens = 0
          let reasoningTokens = 0

          if (last) {
            inputTokens = last.input_tokens ?? 0
            cachedInputTokens = last.cached_input_tokens ?? 0
            outputTokens = last.output_tokens ?? 0
            reasoningTokens = last.reasoning_output_tokens ?? 0
          } else if (cumulativeTotal > 0) {
            const total = info.total_token_usage
            if (!total) continue
            inputTokens = (total.input_tokens ?? 0) - prevInput
            cachedInputTokens = (total.cached_input_tokens ?? 0) - prevCached
            outputTokens = (total.output_tokens ?? 0) - prevOutput
            reasoningTokens = (total.reasoning_output_tokens ?? 0) - prevReasoning
          }

          if (!last) {
            const total = info.total_token_usage
            if (total) {
              prevInput = total.input_tokens ?? 0
              prevCached = total.cached_input_tokens ?? 0
              prevOutput = total.output_tokens ?? 0
              prevReasoning = total.reasoning_output_tokens ?? 0
            }
          }

          const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
          if (totalTokens === 0) continue

          // OpenAI includes cached tokens inside input_tokens; Anthropic does not.
          // Normalize to Anthropic semantics: inputTokens = non-cached only.
          const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

          const model = resolveModel(entry.payload, sessionModel)
          const timestamp = entry.timestamp ?? ''
          const dedupKey = `codex:${source.path}:${timestamp}:${cumulativeTotal}`

          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          // Codex/OpenAI reports cached_input_tokens as a subset of input_tokens.
          // Store/report fresh input and cache reads separately, but choose long-context
          // pricing tiers from the full prompt footprint. Otherwise a 300K-token prompt
          // with a high cache hit rate would incorrectly stay on the sub-270K tier.
          const totalPromptInputTokens = uncachedInputTokens + cachedInputTokens

          // Codex token_count events expose reasoning_output_tokens for observability,
          // but sampled events satisfy total_tokens = input_tokens + output_tokens.
          // Billing output_tokens + reasoning_output_tokens double-counts reasoning.
          const billableOutputTokens = outputTokens

          const costUSD = calculateCost(
            model,
            uncachedInputTokens,
            billableOutputTokens,
            0,
            cachedInputTokens,
            0,
            'standard',
            totalPromptInputTokens,
          )

          yield {
            provider: 'codex',
            model,
            inputTokens: uncachedInputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedInputTokens,
            cachedInputTokens,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: pendingTools,
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
            sessionId,
          }

          pendingTools = []
          pendingUserMessage = ''
        }
      }

      // Fix 1: Format validation — warn if expected fields were absent
      if (lineCount > 5 && !hasSessionMeta) {
        parserWarnings.push(`Codex session file format may have changed — missing session_meta (${basename(source.path)})`)
      }
      if (lineCount > 5 && hasSessionMeta && !hasTokenCounts) {
        parserWarnings.push(`Codex session file format may have changed — no token_count events found (${basename(source.path)})`)
      }
    },
  }
}

export function createCodexProvider(codexDir?: string): Provider {
  const dir = getCodexDir(codexDir)

  return {
    name: 'codex',
    displayName: 'Codex',

    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      // Flush even when the scan aborts on budget: headers already read this pass are
      // banked, so a cold corpus converges across refreshes instead of restarting.
      try { return await discoverSessionsInDir(dir) }
      finally { await flushDiscoveryCache() }
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codex = createCodexProvider()
