import type { SessionSummary } from './types.js'
import { aggregateModelStats, type ModelStats } from './compare-stats.js'
import type { DailyEntry } from './daily-cache.js'
import { aggregateProjectsIntoDays, dateKey } from './day-aggregator.js'

export type ReportSummary = {
  daily: Record<string, { cost: number; calls: number }>
  dailyEntries: Record<string, DailyEntry>
  models: Record<string, ModelStats>
  categories: Record<string, Record<string, { turns: number; editTurns: number; oneShotTurns: number }>>
  styles: Record<string, { totalTurns: number; agentSpawns: number; planModeUses: number; totalToolCalls: number; fastModeCalls: number }>
}
const planning = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode'])

/** Preserve report and comparison metrics before releasing per-call objects. */
export function compactReportSession(session: SessionSummary): SessionSummary {
  const daily: ReportSummary['daily'] = Object.create(null)
  const models: ReportSummary['models'] = Object.create(null)
  const categories: ReportSummary['categories'] = Object.create(null)
  const styles: ReportSummary['styles'] = Object.create(null)
  const report: ReportSummary = { daily, dailyEntries: Object.fromEntries(aggregateProjectsIntoDays([{ project: session.project, projectPath: '', sessions: [session], totalCostUSD: session.totalCostUSD, totalApiCalls: session.apiCalls }]).map(day => [day.date, day])), models, categories, styles }
  for (const model of aggregateModelStats([{ project: session.project, projectPath: '', sessions: [session], totalCostUSD: session.totalCostUSD, totalApiCalls: session.apiCalls }])) models[model.model] = model
  for (const turn of session.turns) {
    for (const call of turn.assistantCalls) {
      if (!call.timestamp) continue
      const day = dateKey(call.timestamp)
      const d = daily[day] ??= { cost: 0, calls: 0 }
      d.cost += call.costUSD
      d.calls++
    }
    const model = turn.assistantCalls[0]?.model
    if (!model) continue
    if (!Object.hasOwn(categories, model)) categories[model] = Object.create(null)
    const cats = categories[model]!
    if (!Object.hasOwn(cats, turn.category)) cats[turn.category] = { turns: 0, editTurns: 0, oneShotTurns: 0 }
    const cat = cats[turn.category]!
    cat.turns++; if (turn.hasEdits) { cat.editTurns++; if (!turn.retries) cat.oneShotTurns++ }
    const style = styles[model] ??= { totalTurns: 0, agentSpawns: 0, planModeUses: 0, totalToolCalls: 0, fastModeCalls: 0 }
    style.totalTurns++
    if (turn.assistantCalls.some(c => c.hasPlanMode || c.tools.some(t => planning.has(t)))) style.planModeUses++
    for (const call of turn.assistantCalls) {
      style.totalToolCalls += call.tools.length
      if (call.hasAgentSpawn) style.agentSpawns++
      if (call.speed === 'fast') style.fastModeCalls++
    }
  }
  session.reportSummary = report
  session.turns = []
  return session
}

/** Combine fragments of the same session without retaining their transcript objects. */
export function mergeReportSession(target: SessionSummary, source: SessionSummary): void {
  mergeCounters(target, source)
}
export function mergeCounters(target: object, source: object): void {
  const dst = target as Record<string, unknown>
  for (const [key, value] of Object.entries(source)) {
    const old = Object.hasOwn(dst, key) ? dst[key] : undefined
    let next: unknown = old
    if (typeof value === 'number') next = (typeof old === 'number' ? old : 0) + value
    else if (typeof value === 'string') {
      if (key === 'firstSeen' || key === 'firstTimestamp') next = !old || (value && value < String(old)) ? value : old
      else if (key === 'lastSeen' || key === 'lastTimestamp') next = !old || value > String(old) ? value : old
      else next = old ?? value
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      next = old && typeof old === 'object' ? old : Object.create(null)
      mergeCounters(next as object, value)
    }
    Object.defineProperty(dst, key, { value: next, writable: true, enumerable: true, configurable: true })
  }
}
