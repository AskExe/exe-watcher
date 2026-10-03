import { mergeCounters } from './report-summary.js'
import type { DailyEntry, ProviderDailyBreakdown } from './daily-cache.js'
import type { PeriodData } from './menubar-json.js'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function emptyEntry(date: string): DailyEntry {
  return {
    date,
    cost: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
    projects: {},
  }
}

function emptyProviderBreakdown(): ProviderDailyBreakdown {
  return {
    calls: 0,
    cost: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
  }
}

export function dateKey(iso: string): string {
  return formatDate(new Date(iso))
}

export function aggregateProjectsIntoDays(projects: ProjectSummary[]): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>()
  const ensure = (date: string): DailyEntry => {
    let d = byDate.get(date)
    if (!d) { d = emptyEntry(date); byDate.set(date, d) }
    return d
  }
  const ensureProvider = (date: string, provider: string): ProviderDailyBreakdown => {
    const day = ensure(date)
    let breakdown = day.providers[provider]
    if (!breakdown) {
      breakdown = emptyProviderBreakdown()
      day.providers[provider] = breakdown
    }
    return breakdown
  }
  const ensureProject = (date: string, projectName: string) => {
    const day = ensure(date)
    let project = day.projects[projectName]
    if (!project) {
      project = { cost: 0, sessions: 0 }
      day.projects[projectName] = project
    }
    return project
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.reportSummary?.dailyEntries) {
        for (const day of Object.values(session.reportSummary.dailyEntries)) mergeCounters(ensure(day.date), day)
        continue
      }
      const sessionDate = dateKey(session.firstTimestamp)
      ensure(sessionDate).sessions += 1
      ensureProject(sessionDate, project.project).sessions += 1
      const providersSeenInSession = new Set<string>()

      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        const turnDate = dateKey(turn.assistantCalls[0]!.timestamp)
        const turnDay = ensure(turnDate)

        const editTurns = turn.hasEdits ? 1 : 0
        const oneShotTurns = turn.hasEdits && turn.retries === 0 ? 1 : 0
        const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)

        turnDay.editTurns += editTurns
        turnDay.oneShotTurns += oneShotTurns

        const cat = turnDay.categories[turn.category] ?? { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
        cat.turns += 1
        cat.cost += turnCost
        cat.editTurns += editTurns
        cat.oneShotTurns += oneShotTurns
        turnDay.categories[turn.category] = cat

        const callsByProvider = new Map<string, typeof turn.assistantCalls>()
        for (const call of turn.assistantCalls) {
          const existingProviderCalls = callsByProvider.get(call.provider) ?? []
          existingProviderCalls.push(call)
          callsByProvider.set(call.provider, existingProviderCalls)

          const callDate = dateKey(call.timestamp)
          const callDay = ensure(callDate)

          callDay.cost += call.costUSD
          callDay.calls += 1
          callDay.inputTokens += call.usage.inputTokens
          callDay.outputTokens += call.usage.outputTokens
          callDay.cacheReadTokens += call.usage.cacheReadInputTokens
          callDay.cacheWriteTokens += call.usage.cacheCreationInputTokens

          const model = callDay.models[call.model] ?? {
            calls: 0, cost: 0,
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
          }
          model.calls += 1
          model.cost += call.costUSD
          model.inputTokens += call.usage.inputTokens
          model.outputTokens += call.usage.outputTokens
          model.cacheReadTokens += call.usage.cacheReadInputTokens
          model.cacheWriteTokens += call.usage.cacheCreationInputTokens
          callDay.models[call.model] = model
          ensureProject(callDate, project.project).cost += call.costUSD

        }

        for (const [provider, calls] of callsByProvider) {
          providersSeenInSession.add(provider)
          const providerTurnDay = ensureProvider(turnDate, provider)
          const providerTurnCost = calls.reduce((sum, call) => sum + call.costUSD, 0)
          providerTurnDay.editTurns += editTurns
          providerTurnDay.oneShotTurns += oneShotTurns

          const providerCategory = providerTurnDay.categories[turn.category] ?? { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
          providerCategory.turns += 1
          providerCategory.cost += providerTurnCost
          providerCategory.editTurns += editTurns
          providerCategory.oneShotTurns += oneShotTurns
          providerTurnDay.categories[turn.category] = providerCategory

          for (const call of calls) {
            const callDate = dateKey(call.timestamp)
            const providerCallDay = ensureProvider(callDate, provider)
            providerCallDay.cost += call.costUSD
            providerCallDay.calls += 1
            providerCallDay.inputTokens += call.usage.inputTokens
            providerCallDay.outputTokens += call.usage.outputTokens
            providerCallDay.cacheReadTokens += call.usage.cacheReadInputTokens
            providerCallDay.cacheWriteTokens += call.usage.cacheCreationInputTokens

            const model = providerCallDay.models[call.model] ?? {
              calls: 0, cost: 0,
              inputTokens: 0, outputTokens: 0,
              cacheReadTokens: 0, cacheWriteTokens: 0,
            }
            model.calls += 1
            model.cost += call.costUSD
            model.inputTokens += call.usage.inputTokens
            model.outputTokens += call.usage.outputTokens
            model.cacheReadTokens += call.usage.cacheReadInputTokens
            model.cacheWriteTokens += call.usage.cacheCreationInputTokens
            providerCallDay.models[call.model] = model
          }
        }
      }

      for (const provider of providersSeenInSession) {
        ensureProvider(sessionDate, provider).sessions += 1
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Narrow DailyEntry[] to a single provider's cost/calls.
 * Preserve the full date range so period charts remain aligned even on days where the selected
 * provider had no activity. When a provider has no data for a given day, we keep a zeroed row.
 */
export function filterDaysToProvider(days: DailyEntry[], provider: string): DailyEntry[] {
  return days.map(d => {
    const p = d.providers[provider] ?? emptyProviderBreakdown()
    return {
      ...d,
      cost: p.cost,
      calls: p.calls,
      sessions: p.sessions,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      editTurns: p.editTurns,
      oneShotTurns: p.oneShotTurns,
      models: { ...p.models },
      categories: { ...p.categories },
      providers: d.providers[provider] ? { [provider]: p } : {},
    }
  })
}

export function fillMissingDays(start: Date, end: Date, days: DailyEntry[]): DailyEntry[] {
  const byDate = new Map(days.map(day => [day.date, day]))
  const filled: DailyEntry[] = []
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate())

  while (cursor.getTime() <= endDate.getTime()) {
    const key = formatDate(cursor)
    filled.push(byDate.get(key) ?? emptyEntry(key))
    cursor.setDate(cursor.getDate() + 1)
  }

  return filled
}

export function buildPeriodDataFromDays(days: DailyEntry[], label: string): PeriodData {
  if (days.length === 0) {
    process.stderr.write(`[exe-watcher] WARNING: buildPeriodDataFromDays called with 0 days for label '${label}'\n`)
  }
  let cost = 0, calls = 0, sessions = 0
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  const catTotals: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number }> = {}

  for (const d of days) {
    cost += d.cost
    calls += d.calls
    sessions += d.sessions
    inputTokens += d.inputTokens
    outputTokens += d.outputTokens
    cacheReadTokens += d.cacheReadTokens
    cacheWriteTokens += d.cacheWriteTokens

    for (const [name, m] of Object.entries(d.models)) {
      const acc = modelTotals[name] ?? { calls: 0, cost: 0 }
      acc.calls += m.calls
      acc.cost += m.cost
      modelTotals[name] = acc
    }
    for (const [cat, c] of Object.entries(d.categories)) {
      const acc = catTotals[cat] ?? { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
      acc.turns += c.turns
      acc.cost += c.cost
      acc.editTurns += c.editTurns
      acc.oneShotTurns += c.oneShotTurns
      catTotals[cat] = acc
    }
  }

  return {
    label,
    cost,
    calls,
    sessions,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}
