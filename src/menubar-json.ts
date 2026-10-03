/// Rollup of one time window (today / 7 days / 30 days / month / all) used as the canonical
/// input to the menubar payload. Built inside the CLI and also consumed by the day-aggregator
/// when hydrating per-day cache entries.
export type PeriodData = {
  label: string
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  categories: Array<{ name: string; cost: number; turns: number; editTurns: number; oneShotTurns: number }>
  models: Array<{ name: string; cost: number; calls: number }>
}

export type ProviderCost = {
  name: string
  cost: number
}
import type { OptimizeResult } from './optimize.js'
import type { ProjectSummary } from './types.js'
import type { DailyEntry } from './daily-cache.js'
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { getShortModelName } from './models.js'

/** Read CLI version from package.json at build/runtime. */
function getCliVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Minimum menubar app version required for this CLI's JSON schema.
 * Bump when MenubarPayload shape changes in a breaking way.
 */
const MIN_APP_VERSION = '0.2.40'

const TOP_ACTIVITIES_LIMIT = 20
const TOP_MODELS_LIMIT = 20
const TOP_FINDINGS_LIMIT = 10
const SYNTHETIC_MODEL_NAME = '<synthetic>'

export type DailyModelBreakdown = {
  name: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyHistoryEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels: DailyModelBreakdown[]
}

export type DiagnosticsBlock = {
  daysCount: number
  parseTimeMs: number
  warnings: string[]
}

export type MenubarPayload = {
  schemaVersion: number
  generated: string
  cliVersion: string
  minAppVersion: string
  current: {
    label: string
    cost: number
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
    topActivities: Array<{
      name: string
      cost: number
      turns: number
      oneShotRate: number | null
    }>
    topModels: Array<{
      name: string
      cost: number
      calls: number
    }>
    providers: Record<string, number>
  }
  optimize: {
    findingCount: number
    savingsUSD: number
    topFindings: Array<{
      title: string
      impact: 'high' | 'medium' | 'low'
      savingsUSD: number
    }>
  }
  history: {
    daily: DailyHistoryEntry[]
  }
  diagnostics: DiagnosticsBlock
  agentStats: AgentStatsPayload | null
  exeOsDetected: boolean
  statsFileAge: number | null
  projectSpend: Array<{ name: string; cost24h: number; cost7d: number; cost30d: number; selectedPeriodCost: number; sessions: number }> | null
}

type SpendBucket = { inputTokens?: number; outputTokens?: number; costUSD?: number; sessions?: number }

export type AgentStatsPayload = {
  generated: string
  agents: Array<{
    id: string; total: number
    growth24h?: number; growth7d: number; growth30d?: number
    spend24h?: SpendBucket; spend7d?: SpendBucket; spend30d?: SpendBucket
    costUSD?: number; cost24h?: number; cost7d?: number; cost30d?: number
  }>
  daemon: { uptime: number; pid: number }
}

/**
 * Extracts per-agent costUSD for 24h/7d/30d from the daemon's pre-computed
 * model-aware pricing in each spend bucket.
 */
export function estimateAgentCosts(stats: AgentStatsPayload): AgentStatsPayload {
  return {
    ...stats,
    agents: stats.agents.map(a => ({
      ...a,
      cost24h: a.spend24h?.costUSD ?? 0,
      cost7d: a.spend7d?.costUSD ?? 0,
      cost30d: a.spend30d?.costUSD ?? 0,
      costUSD: a.spend30d?.costUSD ?? 0,
    })),
  }
}

/**
 * Loads the exe-os session cache which maps Claude Code session UUIDs to agent IDs.
 * Each file in ~/.exe-os/session-cache/ is named {sessionUUID}.json and contains
 * { agentId, agentRole, startedAt }.
 */
function loadSessionAgentMap(): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const cacheDir = join(homedir(), '.exe-os', 'session-cache')
    const files = readdirSync(cacheDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const sessionId = file.replace('.json', '')
      try {
        const raw = readFileSync(join(cacheDir, file), 'utf-8')
        const data = JSON.parse(raw) as { agentId?: string }
        if (data.agentId) {
          // Normalize: strip session suffixes like "worker1-exe1" → "worker1"
          const baseId = data.agentId.replace(/-exe\d+$/, '')
          map.set(sessionId, baseId)
        }
      } catch { /* skip malformed files */ }
    }
  } catch { /* session cache not available */ }
  return map
}

/**
 * Derives per-agent spend from project summaries using the exe-os session cache.
 * Each session's UUID is looked up in ~/.exe-os/session-cache/ to find which
 * agent created it. Falls back to worktree path heuristic for unmapped sessions.
 */
export function computeAgentSpend(projects: ProjectSummary[]): Record<string, number> {
  const agentMap = loadSessionAgentMap()
  const spend: Record<string, number> = {}

  for (const p of projects) {
    for (const sess of p.sessions) {
      const agent = agentMap.get(sess.sessionId)
        ?? extractAgentFromProject(p.project)
      spend[agent] = (spend[agent] ?? 0) + sess.totalCostUSD
    }
  }
  return spend
}

/** Merge CLI-computed spend into daemon-supplied agent stats. */
export function mergeAgentSpend(stats: AgentStatsPayload | null, spend: Record<string, number>): AgentStatsPayload | null {
  if (!stats) return null
  const knownIds = new Set(stats.agents.map(a => a.id))
  const merged = stats.agents.map(a => ({ ...a, costUSD: spend[a.id] ?? 0 }))
  // Add agents that appear in spend but not in memory stats (rare edge case)
  for (const [id, costUSD] of Object.entries(spend)) {
    if (!knownIds.has(id) && id !== 'user') {
      merged.push({ id, total: 0, growth7d: 0, costUSD })
    }
  }
  return { ...stats, agents: merged }
}

/**
 * Fallback: extracts the exe-os agent name from a Claude project directory name.
 * Pattern: `-Users-alice-exe-os--worktrees-worker1` → "worker1"
 * Nested: `-Users-alice-exe-os--worktrees-worker2--worktrees-worker1` → "worker1" (innermost)
 * No worktree: `-Users-alice-exe-watcher` → "user"
 */
/**
 * Builds per-project spend from parsed project summaries. The row set and sort order come from
 * the currently selected period, while 24h/7d/30d remain visible as comparison columns. Cleans
 * up directory-style names into human-readable project names (e.g. "-Users-alice-exe-os" → "exe-os").
 */
export function buildProjectSpend(
  projectsSelectedPeriod: ProjectSummary[],
  projects24h: ProjectSummary[],
  projects7d: ProjectSummary[],
  projects30d: ProjectSummary[],
): Array<{ name: string; cost24h: number; cost7d: number; cost30d: number; selectedPeriodCost: number; sessions: number }> {
  const aggregate = (projects: ProjectSummary[]) => {
    const byName: Record<string, { cost: number; sessions: number }> = {}
    for (const p of projects) {
      const name = cleanProjectName(p.project)
      if (!byName[name]) byName[name] = { cost: 0, sessions: 0 }
      byName[name].cost += p.totalCostUSD
      byName[name].sessions += p.sessions.length
    }
    return byName
  }
  const selected = aggregate(projectsSelectedPeriod)
  const d24 = aggregate(projects24h)
  const d7 = aggregate(projects7d)
  const d30 = aggregate(projects30d)
  const allNames = new Set([...Object.keys(selected), ...Object.keys(d24), ...Object.keys(d7), ...Object.keys(d30)])
  return Array.from(allNames)
    .map(name => ({
      name,
      cost24h: d24[name]?.cost ?? 0,
      cost7d: d7[name]?.cost ?? 0,
      cost30d: d30[name]?.cost ?? 0,
      selectedPeriodCost: selected[name]?.cost ?? 0,
      sessions: selected[name]?.sessions ?? d30[name]?.sessions ?? d7[name]?.sessions ?? d24[name]?.sessions ?? 0,
    }))
    .filter(d => d.selectedPeriodCost > 0)
    .sort((a, b) => b.selectedPeriodCost - a.selectedPeriodCost)
}

export function buildProjectSpendFromDays(
  selectedDays: DailyEntry[],
  days24h: DailyEntry[],
  days7d: DailyEntry[],
  days30d: DailyEntry[],
): Array<{ name: string; cost24h: number; cost7d: number; cost30d: number; selectedPeriodCost: number; sessions: number }> {
  const aggregate = (days: DailyEntry[]) => {
    const byName: Record<string, { cost: number; sessions: number }> = {}
    for (const day of days) {
      for (const [projectName, totals] of Object.entries(day.projects)) {
        const name = cleanProjectName(projectName)
        if (!byName[name]) byName[name] = { cost: 0, sessions: 0 }
        byName[name].cost += totals.cost
        byName[name].sessions += totals.sessions
      }
    }
    return byName
  }

  const selected = aggregate(selectedDays)
  const d24 = aggregate(days24h)
  const d7 = aggregate(days7d)
  const d30 = aggregate(days30d)
  const allNames = new Set([...Object.keys(selected), ...Object.keys(d24), ...Object.keys(d7), ...Object.keys(d30)])

  return Array.from(allNames)
    .map(name => ({
      name,
      cost24h: d24[name]?.cost ?? 0,
      cost7d: d7[name]?.cost ?? 0,
      cost30d: d30[name]?.cost ?? 0,
      selectedPeriodCost: selected[name]?.cost ?? 0,
      sessions: selected[name]?.sessions ?? d30[name]?.sessions ?? d7[name]?.sessions ?? d24[name]?.sessions ?? 0,
    }))
    .filter(d => d.selectedPeriodCost > 0)
    .sort((a, b) => b.selectedPeriodCost - a.selectedPeriodCost)
}

/**
 * Extracts a human-readable project name from the Claude projects directory name.
 * "-Users-alice-exe-os" → "exe-os"
 * "-Users-alice-exe-os--worktrees-worker1" → "exe-os"
 * "Users-alice-exe-os-.worktrees-worker1" → "exe-os"
 * "-Users-alice-CMO" → "CMO"
 */
function cleanProjectName(dirName: string): string {
  // Strip worktree suffix — attribute to the base project
  const base = dirName
    .replace(/--worktrees-.*$/, '')
    .replace(/-\.worktrees-.*/, '')
    .replace(/\/\.worktrees\/.*/, '')
  // Take last path segment (after the last single hyphen that follows a known pattern)
  const parts = base.split('-')
  // Find the user directory prefix and take everything after it
  // Pattern: -Users-{username}-{project...}
  const usersIdx = parts.indexOf('Users')
  if (usersIdx >= 0 && usersIdx + 2 < parts.length) {
    return parts.slice(usersIdx + 2).join('-')
  }
  return dirName
}

function extractAgentFromProject(dirName: string): string {
  const matches = [...dirName.matchAll(/--worktrees-([a-zA-Z][a-zA-Z0-9]*)/g)]
  if (matches.length === 0) return 'user'
  const lastMatch = matches[matches.length - 1]
  if (!lastMatch?.[1]) return 'user'
  return lastMatch[1].toLowerCase()
}

function oneShotRateFor(editTurns: number, oneShotTurns: number): number | null {
  if (editTurns === 0) return null
  return oneShotTurns / editTurns
}

function aggregateOneShotRate(categories: PeriodData['categories']): number | null {
  let edits = 0
  let oneShots = 0
  for (const cat of categories) {
    edits += cat.editTurns
    oneShots += cat.oneShotTurns
  }
  if (edits === 0) return null
  return oneShots / edits
}

function cacheHitPercent(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens
  if (denom === 0) return 0
  return (cacheReadTokens / denom) * 100
}

function buildTopActivities(categories: PeriodData['categories']): MenubarPayload['current']['topActivities'] {
  return categories.slice(0, TOP_ACTIVITIES_LIMIT).map(cat => ({
    name: cat.name,
    cost: cat.cost,
    turns: cat.turns,
    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
  }))
}

function buildTopModels(models: PeriodData['models']): MenubarPayload['current']['topModels'] {
  return models
    .filter(m => m.name !== SYNTHETIC_MODEL_NAME)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, TOP_MODELS_LIMIT)
    .map(m => ({ name: getShortModelName(m.name), cost: m.cost, calls: m.calls }))
}

function buildOptimize(optimize: OptimizeResult | null): MenubarPayload['optimize'] {
  if (!optimize || optimize.findings.length === 0) {
    return { findingCount: 0, savingsUSD: 0, topFindings: [] }
  }
  const { findings, costRate } = optimize
  const totalSavingsUSD = findings.reduce((s, f) => s + f.tokensSaved * costRate, 0)
  const topFindings = findings.slice(0, TOP_FINDINGS_LIMIT).map(f => ({
    title: f.title,
    impact: f.impact,
    savingsUSD: f.tokensSaved * costRate,
  }))
  return {
    findingCount: findings.length,
    savingsUSD: totalSavingsUSD,
    topFindings,
  }
}

function buildProviders(providers: ProviderCost[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const p of providers) {
    if (p.cost < 0) continue
    map[p.name.toLowerCase()] = p.cost
  }
  return map
}

function buildHistory(daily: DailyHistoryEntry[] | undefined): MenubarPayload['history'] {
  if (!daily || daily.length === 0) return { daily: [] }
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  return { daily: sorted }
}

export function buildMenubarPayload(
  current: PeriodData,
  providers: ProviderCost[],
  optimize: OptimizeResult | null,
  dailyHistory?: DailyHistoryEntry[],
  agentStats?: AgentStatsPayload | null,
  projectSpend?: Array<{ name: string; cost24h: number; cost7d: number; cost30d: number; selectedPeriodCost: number; sessions: number }> | null,
  exeOsDetected?: boolean,
  statsFileAge?: number | null,
  diagnostics?: DiagnosticsBlock,
): MenubarPayload {
  return {
    schemaVersion: 2,
    generated: new Date().toISOString(),
    cliVersion: getCliVersion(),
    minAppVersion: MIN_APP_VERSION,
    current: {
      label: current.label,
      cost: current.cost,
      calls: current.calls,
      sessions: current.sessions,
      oneShotRate: aggregateOneShotRate(current.categories),
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens),
      topActivities: buildTopActivities(current.categories),
      topModels: buildTopModels(current.models),
      providers: buildProviders(providers),
    },
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory),
    diagnostics: diagnostics ?? { daysCount: 0, parseTimeMs: 0, warnings: [] },
    agentStats: agentStats ?? null,
    exeOsDetected: exeOsDetected ?? false,
    statsFileAge: statsFileAge ?? null,
    projectSpend: projectSpend ?? null,
  }
}
