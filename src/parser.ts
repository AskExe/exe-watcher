import { cachedFileParse } from './parsed-file-cache.js'
import { chargeRecord, withScanBudget } from './resource-budget.js'
import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { readSessionLines } from './fs-utils.js'
import { calculateCost, getShortModelName } from './models.js'
import { discoverAllSessions, getProvider } from './providers/index.js'
import type { ParsedProviderCall } from './providers/types.js'
import type {
  AssistantMessageContent,
  ClassifiedTurn,
  ContentBlock,
  DateRange,
  JournalEntry,
  ParsedApiCall,
  ParsedTurn,
  ProjectSummary,
  SessionSummary,
  TokenUsage,
  ToolUseBlock,
} from './types.js'
import { classifyTurn, compactUserMessage, BASH_TOOLS } from './classifier.js'
import { loadSessionIndex, saveSessionIndex, checkSessionFile, recordParseResult, pruneIndex, clearSessionIndex } from './session-index.js'
import { extractBashCommands } from './bash-utils.js'

let _parseWarnings: string[] = []

/** Return warnings from the last parseAllSessions() call (schema issues, etc.). */
export function getParseWarnings(): string[] {
  return _parseWarnings
}

function unsanitizePath(dirName: string): string {
  return dirName.replace(/-/g, '/')
}

function parseJsonlLine(line: string): JournalEntry | null {
  try {
    return JSON.parse(line) as JournalEntry
  } catch {
    return null
  }
}


function extractToolNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => b.name)
}

function extractMcpTools(tools: string[]): string[] {
  return tools.filter(t => t.startsWith('mcp__'))
}

function extractCoreTools(tools: string[]): string[] {
  return tools.filter(t => !t.startsWith('mcp__'))
}

function extractBashCommandsFromContent(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && BASH_TOOLS.has((b as ToolUseBlock).name))
    .flatMap(b => {
      const command = (b.input as Record<string, unknown>)?.command
      return typeof command === 'string' ? extractBashCommands(command) : []
    })
}

function getUserMessageText(entry: JournalEntry): string {
  if (!entry.message || entry.message.role !== 'user') return ''
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
  }
  return ''
}

function getMessageId(entry: JournalEntry): string | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  return msg?.id ?? null
}

function parseApiCall(entry: JournalEntry): ParsedApiCall | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  if (!msg?.usage || !msg?.model) return null

  const usage = msg.usage
  const tokens: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  }

  const tools = extractToolNames(msg.content ?? [])
  const costUSD = calculateCost(
    msg.model,
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheCreationInputTokens,
    tokens.cacheReadInputTokens,
    tokens.webSearchRequests,
    usage.speed ?? 'standard',
  )

  const bashCmds = extractBashCommandsFromContent(msg.content ?? [])

  return {
    provider: 'claude',
    model: msg.model,
    usage: tokens,
    costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: usage.speed ?? 'standard',
    timestamp: entry.timestamp ?? '',
    bashCommands: bashCmds,
    deduplicationKey: msg.id ?? `claude:${entry.timestamp}`,
  }
}

async function parseTurns(filePath: string): Promise<ParsedTurn[]> {
  const seenMsgIds = new Set<string>()
  const turns: ParsedTurn[] = []
  let currentUserMessage = ''
  let currentUserSignals = 0
  let currentCalls: ParsedApiCall[] = []
  let currentTimestamp = ''
  let currentSessionId = ''

  let lineNumber = 0
  for await (const line of readSessionLines(filePath)) {
    lineNumber++
    const entry = parseJsonlLine(line)
    if (!entry) continue
    if (entry.type === 'user') {
      const text = getUserMessageText(entry)
      if (text.trim()) {
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            userMessageSignals: currentUserSignals,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: currentSessionId,
          })
        }
        const compact = compactUserMessage(text)
        currentUserMessage = compact.userMessage
        currentUserSignals = compact.userMessageSignals
        currentCalls = []
        currentTimestamp = entry.timestamp ?? ''
        currentSessionId = entry.sessionId ?? ''
      }
    } else if (entry.type === 'assistant') {
      const msgId = getMessageId(entry)
      if (msgId && seenMsgIds.has(msgId)) continue
      if (msgId) seenMsgIds.add(msgId)
      const call = parseApiCall(entry)
      if (call) {
        if (!msgId) call.deduplicationKey = `${filePath}:${lineNumber}`
        chargeRecord(); currentCalls.push(call)
      }
    }
  }

  if (currentCalls.length > 0) {
    turns.push({
      userMessage: currentUserMessage,
            userMessageSignals: currentUserSignals,
      assistantCalls: currentCalls,
      timestamp: currentTimestamp,
      sessionId: currentSessionId,
    })
  }

  return turns
}

function buildSessionSummary(
  sessionId: string,
  project: string,
  turns: ClassifiedTurn[],
): SessionSummary {
  const modelBreakdown: SessionSummary['modelBreakdown'] = Object.create(null)
  const toolBreakdown: SessionSummary['toolBreakdown'] = Object.create(null)
  const mcpBreakdown: SessionSummary['mcpBreakdown'] = Object.create(null)
  const bashBreakdown: SessionSummary['bashBreakdown'] = Object.create(null)
  const categoryBreakdown: SessionSummary['categoryBreakdown'] = Object.create(null)

  let totalCost = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let apiCalls = 0
  let firstTs = ''
  let lastTs = ''

  for (const turn of turns) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    }
    categoryBreakdown[turn.category].turns++
    categoryBreakdown[turn.category].costUSD += turnCost
    if (turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++
      categoryBreakdown[turn.category].retries += turn.retries
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
    }

    for (const call of turn.assistantCalls) {
      totalCost += call.costUSD
      totalInput += call.usage.inputTokens
      totalOutput += call.usage.outputTokens
      totalCacheRead += call.usage.cacheReadInputTokens
      totalCacheWrite += call.usage.cacheCreationInputTokens
      apiCalls++

      const modelKey = getShortModelName(call.model)
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
        }
      }
      modelBreakdown[modelKey].calls++
      modelBreakdown[modelKey].costUSD += call.costUSD
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens
      modelBreakdown[modelKey].tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens

      for (const tool of extractCoreTools(call.tools)) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 }
        toolBreakdown[tool].calls++
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split('__')[1] ?? mcp
        mcpBreakdown[server] = mcpBreakdown[server] ?? { calls: 0 }
        mcpBreakdown[server].calls++
      }
      for (const cmd of call.bashCommands) {
        bashBreakdown[cmd] = bashBreakdown[cmd] ?? { calls: 0 }
        bashBreakdown[cmd].calls++
      }

      if (!firstTs || call.timestamp < firstTs) firstTs = call.timestamp
      if (!lastTs || call.timestamp > lastTs) lastTs = call.timestamp
    }
  }

  return {
    sessionId,
    project,
    firstTimestamp: firstTs || turns[0]?.timestamp || '',
    lastTimestamp: lastTs || turns[turns.length - 1]?.timestamp || '',
    totalCostUSD: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    apiCalls,
    turns,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
  }
}

async function parseSessionFile(
  filePath: string,
  project: string,
  seenMsgIds: Set<string>,
  dateRange?: DateRange,
): Promise<SessionSummary | null> {
  // Skip files whose mtime is older than the range start. A session file
  // can only contain entries up to its last-modified time; if that predates
  // the requested range, nothing in this file can match.
  if (dateRange) {
    try {
      const s = await stat(filePath)
      if (s.mtimeMs < dateRange.start.getTime()) return null
    } catch { /* fall through to normal read; missing stat shouldn't break parsing */ }
  }
  const rawTurns = await cachedFileParse(filePath, 'claude-turns', () => parseTurns(filePath))
  const sessionId = basename(filePath, '.jsonl')
  let turns: ParsedTurn[] = []
  for (const turn of rawTurns) {
    const calls = turn.assistantCalls.filter(call => {
      chargeRecord()
      if (seenMsgIds.has(call.deduplicationKey)) return false
      seenMsgIds.add(call.deduplicationKey)
      return true
    })
    if (calls.length) turns.push({ ...turn, ...compactUserMessage(turn.userMessage, turn.userMessageSignals), assistantCalls: calls })
  }
  if (dateRange) {
    // Bucket a turn by the timestamp of its first assistant call (when the cost was
    // actually incurred). Filtering entries directly produced orphan assistant calls
    // when a user message sat in one day and the response landed in another -- those
    // got pushed as turns with empty timestamps, which some code paths counted and
    // others dropped, producing inconsistent Today totals.
    turns = turns.filter(turn => {
      if (turn.assistantCalls.length === 0) return false
      const firstCallTs = turn.assistantCalls[0]!.timestamp
      if (!firstCallTs) return false
      const ts = new Date(firstCallTs)
      return ts >= dateRange.start && ts <= dateRange.end
    })
    if (turns.length === 0) return null
  }
  const classified = turns.map(classifyTurn)

  return buildSessionSummary(sessionId, project, classified)
}

async function collectJsonlFiles(dirPath: string): Promise<string[]> {
  const files = await readdir(dirPath).catch(() => [])
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).map(f => join(dirPath, f))

  for (const entry of files) {
    if (entry.endsWith('.jsonl')) continue
    const subagentsPath = join(dirPath, entry, 'subagents')
    const subFiles = await readdir(subagentsPath).catch(() => [])
    for (const sf of subFiles) {
      if (sf.endsWith('.jsonl')) jsonlFiles.push(join(subagentsPath, sf))
    }
  }

  return jsonlFiles
}

async function scanProjectDirs(dirs: Array<{ path: string; name: string }>, seenMsgIds: Set<string>, dateRange?: DateRange): Promise<{ projects: ProjectSummary[]; indexDirty: boolean }> {
  const sessionIndex = await loadSessionIndex()
  const projectMap = new Map<string, SessionSummary[]>()
  let indexDirty = false
  const allJsonlPaths = new Set<string>()

  for (const { path: dirPath, name: dirName } of dirs) {
    const jsonlFiles = await collectJsonlFiles(dirPath)
    for (const f of jsonlFiles) allJsonlPaths.add(f)

    for (const filePath of jsonlFiles) {
      // Check index: skip files known to have no API calls
      const action = await checkSessionFile(filePath, sessionIndex, dateRange)
      if (action === 'skip') continue

      // Snapshot file fingerprint BEFORE parsing so we can detect mid-scan writes.
      let preStat: { size: number; mtimeMs: number } | null = null
      try {
        const s = await stat(filePath)
        preStat = { size: s.size, mtimeMs: s.mtimeMs }
      } catch { /* stat failed, will skip indexing */ }

      const session = await parseSessionFile(filePath, dirName, seenMsgIds, dateRange)

      // Record result in index for future invocations.
      // Only update the fingerprint when the file did NOT change during parsing.
      // If the file was written to mid-scan (mtime shifted), the parsed data is
      // stale relative to the new fingerprint — recording that would cause the
      // next run to skip re-parsing (fingerprint matches) with outdated data,
      // or worse, mark the file h=0 when it actually has new API calls.
      //
      // CRITICAL: When a dateRange is active, a null parse result does NOT mean
      // the file has no API calls — it means the file has no calls in THIS range.
      // Recording h=0 here would cause subsequent scans with DIFFERENT date ranges
      // to skip the file entirely. This was the root cause of Claude Code showing
      // $0 on startup: the gap-fill (yesterday range) marked files h=0, then the
      // today parse skipped them even though they had today's data.
      // Only record h=0 (no API calls) when scanning WITHOUT a date filter, which
      // proves the file is genuinely empty across all time.
      const hasApiCalls = session !== null && session.apiCalls > 0
      if (preStat && (hasApiCalls || !dateRange)) {
        try {
          const postStat = await stat(filePath)
          if (postStat.size === preStat.size && postStat.mtimeMs === preStat.mtimeMs) {
            // File was stable during the parse — safe to record
            indexDirty = recordParseResult(filePath, sessionIndex, preStat.size, preStat.mtimeMs, hasApiCalls) || indexDirty
          }
          // else: file changed mid-scan; leave the old index entry (if any) intact.
          // The next run will see a fingerprint mismatch and re-parse.
        } catch { /* stat failed, skip indexing */ }
      }

      if (session && session.apiCalls > 0) {
        const existing = projectMap.get(dirName) ?? []
        existing.push(session)
        projectMap.set(dirName, existing)
      }
    }
  }

  // Prune entries for deleted files
  const pruned = pruneIndex(sessionIndex, allJsonlPaths)
  if (pruned > 0) indexDirty = true

  // Save if any entries changed
  if (indexDirty) {
    await saveSessionIndex(sessionIndex)
  }

  const projects = Array.from(projectMap.entries())
    .map(([dirName, sessions]) => ({
      project: dirName,
      projectPath: unsanitizePath(dirName),
      sessions,
      totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
      totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    }))

  return { projects, indexDirty }
}

function providerCallToTurn(call: ParsedProviderCall): ParsedTurn {
  const tools = call.tools
  const usage: TokenUsage = {
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationInputTokens: call.cacheCreationInputTokens,
    cacheReadInputTokens: call.cacheReadInputTokens,
    cachedInputTokens: call.cachedInputTokens,
    reasoningTokens: call.reasoningTokens,
    webSearchRequests: call.webSearchRequests,
  }

  const apiCall: ParsedApiCall = {
    provider: call.provider,
    model: call.model,
    usage,
    costUSD: call.costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
  }

  return {
    ...compactUserMessage(call.userMessage, call.userMessageSignals),
    assistantCalls: [apiCall],
    timestamp: call.timestamp,
    sessionId: call.sessionId,
  }
}

async function parseProviderSources(
  providerName: string,
  sources: Array<{ path: string; project: string }>,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): Promise<ProjectSummary[]> {
  const provider = await getProvider(providerName)
  if (!provider) return []

  const sessionMap = new Map<string, { project: string; turns: ClassifiedTurn[] }>()

  for (const source of sources) {
    if (dateRange) {
      try {
        const s = await stat(source.path)
        const wal = await stat(`${source.path}-wal`).catch(() => null)
        if (Math.max(s.mtimeMs, wal?.mtimeMs ?? 0) < dateRange.start.getTime()) continue
      } catch { /* fall through; treat unknown stat as "may contain data" */ }
    }
    // Each file is cached independently of date range and global deduplication.
    const warnings: string[] = []
    const calls = await cachedFileParse(source.path, providerName, async () => {
      const parser = provider.createSessionParser(
        { path: source.path, project: source.project, provider: providerName }, new Set(),
      )
      const result: ParsedProviderCall[] = []
      for await (const call of parser.parse()) { chargeRecord(); result.push({ ...call, ...compactUserMessage(call.userMessage, call.userMessageSignals) }) }
      if (parser.warnings?.length) warnings.push(...parser.warnings)
      return result
    }, warnings)
    _parseWarnings.push(...warnings)
    for (const call of calls) {
      chargeRecord()
      if (seenKeys.has(call.deduplicationKey)) continue
      seenKeys.add(call.deduplicationKey)
      if (dateRange) {
        if (!call.timestamp) continue
        const ts = new Date(call.timestamp)
        if (ts < dateRange.start || ts > dateRange.end) continue
      }

      const turn = providerCallToTurn(call)
      const classified = classifyTurn(turn)
      const key = `${providerName}:${call.sessionId}:${source.project}`

      const existing = sessionMap.get(key)
      if (existing) {
        existing.turns.push(classified)
      } else {
        sessionMap.set(key, { project: source.project, turns: [classified] })
      }
    }


  }

  const projectMap = new Map<string, SessionSummary[]>()
  for (const [key, { project, turns }] of sessionMap) {
    const sessionId = key.split(':')[1] ?? key
    const session = buildSessionSummary(sessionId, project, turns)
    if (session.apiCalls > 0) {
      const existing = projectMap.get(project) ?? []
      existing.push(session)
      projectMap.set(project, existing)
    }
  }

  const projects: ProjectSummary[] = []
  for (const [dirName, sessions] of projectMap) {
    projects.push({
      project: dirName,
      projectPath: unsanitizePath(dirName),
      sessions,
      totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
      totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    })
  }

  return projects
}

const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 10
const sessionCache = new Map<string, { data: ProjectSummary[]; ts: number }>()
const inFlightSourceContexts = new Map<string, Promise<{ sources: Array<{ provider: string; project: string; path: string }>; fingerprint: string }>>()
/** Resolved source contexts cached for the lifetime of the process. The CLI
 *  calls parseAllSessions() 2-3 times sequentially with different date ranges
 *  but the same provider filter — without this, each call re-discovers 2000+
 *  session files from disk (~200-500ms each).
 *  Uses a short TTL (5s) to stay fresh enough for tests that add files mid-run
 *  while still avoiding redundant discovery within a single CLI invocation. */
const SOURCE_CONTEXT_TTL_MS = 5_000
const resolvedSourceContexts = new Map<string, { result: { sources: Array<{ provider: string; project: string; path: string }>; fingerprint: string }; ts: number }>()

function sourceContextCacheKey(providerFilter?: string): string {
  return JSON.stringify({
    provider: providerFilter ?? 'all',
    claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] ?? '',
    codexHome: process.env['CODEX_HOME'] ?? '',
    xdgDataHome: process.env['XDG_DATA_HOME'] ?? '',
    home: process.env['HOME'] ?? '',
  })
}

function cacheKey(dateRange?: DateRange, providerFilter?: string, sourceFingerprint = 'static'): string {
  const s = dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none'
  return `${s}:${providerFilter ?? 'all'}:${sourceFingerprint}`
}

/**
 * Cheap fingerprint: source count + newest source path hash.
 * The old approach stat()'d every source file (2000+ calls) which added 15-18s overhead.
 * Since we already have a 60s TTL on the session cache, a lightweight fingerprint that
 * detects new/removed sessions is sufficient — file content changes within the TTL
 * are caught on the next cache miss.
 */
function buildCacheFingerprint(sources: Array<{ provider: string; project: string; path: string }>): string {
  // Use count + sorted paths hash. New sessions change the count or the path list.
  let hash = sources.length
  for (const s of sources) {
    // djb2-style fast string hash — enough to detect path set changes
    for (let i = 0; i < s.path.length; i++) {
      hash = ((hash << 5) + hash + s.path.charCodeAt(i)) | 0
    }
  }
  return `${sources.length}:${hash >>> 0}`
}

async function getSourceContext(providerFilter?: string): Promise<{ sources: Array<{ provider: string; project: string; path: string }>; fingerprint: string }> {
  const key = sourceContextCacheKey(providerFilter)

  // Return recent cache hit (avoids re-discovering 2000+ files on sequential calls).
  const resolved = resolvedSourceContexts.get(key)
  if (resolved && Date.now() - resolved.ts < SOURCE_CONTEXT_TTL_MS) {
    return resolved.result
  }

  // Deduplicate concurrent calls via the inflight promise map.
  const inflight = inFlightSourceContexts.get(key)
  if (inflight) {
    return inflight
  }

  const promise = (async () => {
    const sources = await discoverAllSessions(providerFilter)
    const fingerprint = buildCacheFingerprint(sources)
    return { sources, fingerprint }
  })()

  inFlightSourceContexts.set(key, promise)

  try {
    const result = await promise
    resolvedSourceContexts.set(key, { result, ts: Date.now() })
    return result
  } finally {
    inFlightSourceContexts.delete(key)
  }
}

function cachePut(key: string, data: ProjectSummary[]) {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.ts > CACHE_TTL_MS) sessionCache.delete(k)
  }
  if (sessionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) sessionCache.delete(oldest[0])
  }
  sessionCache.set(key, { data, ts: now })
}

/** Clear all in-process parser caches. Used by tests that modify the filesystem
 *  between parseAllSessions() calls and need discovery to re-scan. */
export function clearParserCaches(): void {
  sessionCache.clear()
  resolvedSourceContexts.clear()
  inFlightSourceContexts.clear()
  clearSessionIndex()
}

export function filterProjectsByName(
  projects: ProjectSummary[],
  include?: string[],
  exclude?: string[],
): ProjectSummary[] {
  let result = projects
  if (include && include.length > 0) {
    const patterns = include.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  if (exclude && exclude.length > 0) {
    const patterns = exclude.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return !patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  return result
}

export async function parseAllSessions(dateRange?: DateRange, providerFilter?: string): Promise<ProjectSummary[]> {
  return withScanBudget(() => parseAllSessionsWithinBudget(dateRange, providerFilter))
}

async function parseAllSessionsWithinBudget(dateRange?: DateRange, providerFilter?: string): Promise<ProjectSummary[]> {
  _parseWarnings = []
  const sourceContext = await getSourceContext(providerFilter)
  const allSources = sourceContext.sources
  const key = cacheKey(dateRange, providerFilter, sourceContext.fingerprint)
  const cached = sessionCache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  const seenMsgIds = new Set<string>()
  const seenKeys = new Set<string>()

  const claudeSources = allSources.filter(s => s.provider === 'claude')
  const nonClaudeSources = allSources.filter(s => s.provider !== 'claude')

  const claudeDirs = claudeSources.map(s => ({ path: s.path, name: s.project }))
  const { projects: claudeProjects } = await scanProjectDirs(claudeDirs, seenMsgIds, dateRange)

  const providerGroups = new Map<string, Array<{ path: string; project: string }>>()
  for (const source of nonClaudeSources) {
    const existing = providerGroups.get(source.provider) ?? []
    existing.push({ path: source.path, project: source.project })
    providerGroups.set(source.provider, existing)
  }

  const otherProjects: ProjectSummary[] = []
  for (const [providerName, sources] of providerGroups) {
    const projects = await parseProviderSources(providerName, sources, seenKeys, dateRange)
    otherProjects.push(...projects)
  }

  const mergedMap = new Map<string, ProjectSummary>()
  for (const p of [...claudeProjects, ...otherProjects]) {
    const existing = mergedMap.get(p.project)
    if (existing) {
      existing.sessions.push(...p.sessions)
      existing.totalCostUSD += p.totalCostUSD
      existing.totalApiCalls += p.totalApiCalls
    } else {
      mergedMap.set(p.project, { ...p })
    }
  }

  const result = Array.from(mergedMap.values()).sort((a, b) => b.totalCostUSD - a.totalCostUSD)
  cachePut(key, result)
  return result
}
