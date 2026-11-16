import { writeFile, mkdir, readdir, lstat, rename, rm, chmod } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'path'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { getCurrency, convertCost } from './currency.js'
import { dateKey } from './day-aggregator.js'

function escCsv(s: string): string {
  const sanitized = /^[\t\r=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

type Row = Record<string, string | number>

function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return ''
  const firstRow = rows[0]
  if (!firstRow) return ''
  const headers = Object.keys(firstRow)
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escCsv(String(row[h] ?? ''))).join(','))
  }
  return lines.join('\n') + '\n'
}

async function writeExportFile(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function pct(n: number, total: number): number {
  return total > 0 ? round2((n / total) * 100) : 0
}

type DailyAgg = {
  cost: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sessions: Set<string>
}

function buildDailyRows(projects: ProjectSummary[], period: string): Row[] {
  const daily: Record<string, DailyAgg> = Object.create(null)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = dateKey(turn.timestamp)
        if (!daily[day]) {
          daily[day] = { cost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }
        }
        daily[day].sessions.add(session.sessionId)
        for (const call of turn.assistantCalls) {
          daily[day].cost += call.costUSD
          daily[day].calls++
          daily[day].input += call.usage.inputTokens
          daily[day].output += call.usage.outputTokens
          daily[day].cacheRead += call.usage.cacheReadInputTokens
          daily[day].cacheWrite += call.usage.cacheCreationInputTokens
        }
      }
    }
  }
  const { code } = getCurrency()
  return Object.entries(daily).sort().map(([date, d]) => ({
    Period: period,
    Date: date,
    [`Cost (${code})`]: round2(convertCost(d.cost)),
    'API Calls': d.calls,
    Sessions: d.sessions.size,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildActivityRows(projects: ProjectSummary[], period: string): Row[] {
  const catTotals: Record<string, { turns: number; cost: number }> = Object.create(null)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, d] of Object.entries(session.categoryBreakdown)) {
        if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0 }
        catTotals[cat].turns += d.turns
        catTotals[cat].cost += d.costUSD
      }
    }
  }
  const totalCost = Object.values(catTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(catTotals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      Period: period,
      Activity: Object.hasOwn(CATEGORY_LABELS, cat) ? CATEGORY_LABELS[cat as TaskCategory] : cat,
      [`Cost (${code})`]: round2(convertCost(d.cost)),
      'Share (%)': pct(d.cost, totalCost),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], period: string): Row[] {
  const modelTotals: Record<string, { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = Object.create(null)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        modelTotals[model].calls += d.calls
        modelTotals[model].cost += d.costUSD
        modelTotals[model].input += d.tokens.inputTokens
        modelTotals[model].output += d.tokens.outputTokens
        modelTotals[model].cacheRead += d.tokens.cacheReadInputTokens ?? 0
        modelTotals[model].cacheWrite += d.tokens.cacheCreationInputTokens ?? 0
      }
    }
  }
  const totalCost = Object.values(modelTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([model, d]) => ({
      Period: period,
      Model: model,
      [`Cost (${code})`]: round2(convertCost(d.cost)),
      'Share (%)': pct(d.cost, totalCost),
      'API Calls': d.calls,
      'Input Tokens': d.input,
      'Output Tokens': d.output,
      'Cache Read Tokens': d.cacheRead,
      'Cache Write Tokens': d.cacheWrite,
    }))
}

function buildToolRows(projects: ProjectSummary[]): Row[] {
  const toolTotals: Record<string, number> = Object.create(null)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, d] of Object.entries(session.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(toolTotals).reduce((s, n) => s + n, 0)
  return Object.entries(toolTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, calls]) => ({
      Tool: tool,
      Calls: calls,
      'Share (%)': pct(calls, total),
    }))
}

function buildBashRows(projects: ProjectSummary[]): Row[] {
  const bashTotals: Record<string, number> = Object.create(null)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cmd, d] of Object.entries(session.bashBreakdown)) {
        bashTotals[cmd] = (bashTotals[cmd] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(bashTotals).reduce((s, n) => s + n, 0)
  return Object.entries(bashTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd, calls]) => ({
      Command: cmd,
      Calls: calls,
      'Share (%)': pct(calls, total),
    }))
}

function buildProjectRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  return projects
    .slice()
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
    .map(p => ({
      Project: p.projectPath,
      [`Cost (${code})`]: round2(convertCost(p.totalCostUSD)),
      [`Avg/Session (${code})`]: p.sessions.length > 0 ? round2(convertCost(p.totalCostUSD / p.sessions.length)) : '',
      'Share (%)': pct(p.totalCostUSD, total),
      'API Calls': p.totalApiCalls,
      Sessions: p.sessions.length,
    }))
}

function buildSessionRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const rows: Row[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      rows.push({
        Project: p.projectPath,
        'Session ID': s.sessionId,
        'Started At': s.firstTimestamp ?? '',
        [`Cost (${code})`]: round2(convertCost(s.totalCostUSD)),
        'API Calls': s.apiCalls,
        Turns: s.turns.length,
      })
    }
  }
  return rows.sort((a, b) => (b[`Cost (${code})`] as number) - (a[`Cost (${code})`] as number))
}

export type PeriodExport = {
  label: string
  projects: ProjectSummary[]
}

function buildSummaryRows(periods: PeriodExport[]): Row[] {
  const { code } = getCurrency()
  return periods.map(p => {
    const cost = p.projects.reduce((s, proj) => s + proj.totalCostUSD, 0)
    const calls = p.projects.reduce((s, proj) => s + proj.totalApiCalls, 0)
    const sessions = p.projects.reduce((s, proj) => s + proj.sessions.length, 0)
    const projectCount = p.projects.filter(proj => proj.totalCostUSD > 0).length
    return {
      Period: p.label,
      [`Cost (${code})`]: round2(convertCost(cost)),
      'API Calls': calls,
      Sessions: sessions,
      Projects: projectCount,
    }
  })
}

function buildReadme(periods: PeriodExport[]): string {
  const { code } = getCurrency()
  const generated = new Date().toISOString()
  const lines = [
    'Exe Watcher Usage Export',
    '====================',
    '',
    `Generated: ${generated}`,
    `Currency:  ${code}`,
    `Periods:   ${periods.map(p => p.label).join(', ')}`,
    '',
    'Files',
    '-----',
    '  summary.csv           One row per period. Headline totals.',
    '  daily.csv             Day-by-day breakdown, Period column distinguishes the window.',
    '  activity.csv          Time spent per task category (Coding, Debugging, Exploration, etc.).',
    '  models.csv            Spend per model with token totals and cache usage.',
    '  projects.csv          Spend per project folder (30-day window).',
    '  sessions.csv          One row per session (30-day window) with session IDs and costs.',
    '  tools.csv             Tool invocations and share (30-day window).',
    '  shell-commands.csv    Shell commands executed via Bash tool (30-day window).',
    '',
    'Notes',
    '-----',
    '  Every cost column is already converted to the active currency. Tokens are raw integer',
    '  counts from provider telemetry. Share (%) is relative to the period/table total.',
    '',
  ]
  return lines.join('\n')
}

/// Sentinel file dropped into every folder we create so we can safely overwrite an older
/// exe-watcher export without ever deleting a user's unrelated files by accident.
const EXPORT_MARKER_FILE = '.exe-watcher-export'

async function isExeWatcherExportFolder(path: string): Promise<boolean> {
  const markerStat = await lstat(join(path, EXPORT_MARKER_FILE)).catch(() => null)
  return markerStat?.isFile() ?? false
}

async function clearExeWatcherExportFolder(path: string): Promise<void> {
  const entries = await readdir(path)
  for (const entry of entries) {
    await rm(join(path, entry), { recursive: true, force: true })
  }
}

/// Writes a folder of one-table-per-file CSVs. The outputPath is treated as a directory. If it
/// ends in `.csv` the extension is stripped to form the folder name. Refuses to delete a
/// pre-existing file, symlink or non-exe-watcher folder.
export async function exportCsv(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1]?.projects ?? []

  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) {
    folder = folder.slice(0, -4)
  }

  const existingStat = await lstat(folder).catch(() => null)
  if (existingStat?.isSymbolicLink() || (existingStat && !existingStat.isDirectory())) {
    throw new Error(`Refusing to overwrite non-directory or symlink at ${folder}. Pass a new directory path instead.`)
  }
  if (existingStat?.isDirectory()) {
    if (!(await isExeWatcherExportFolder(folder))) {
      throw new Error(
        `Refusing to reuse non-empty directory ${folder}: no ${EXPORT_MARKER_FILE} marker. ` +
        `Delete it manually or pick a different -o path.`
      )
    }
    await clearExeWatcherExportFolder(folder)
  }
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  await writeExportFile(join(folder, EXPORT_MARKER_FILE), '')

  const dailyRows = periods.flatMap(p => buildDailyRows(p.projects, p.label))
  const activityRows = periods.flatMap(p => buildActivityRows(p.projects, p.label))
  const modelRows = periods.flatMap(p => buildModelRows(p.projects, p.label))

  await writeExportFile(join(folder, 'README.txt'), buildReadme(periods))
  await writeExportFile(join(folder, 'summary.csv'), rowsToCsv(buildSummaryRows(periods)))
  await writeExportFile(join(folder, 'daily.csv'), rowsToCsv(dailyRows))
  await writeExportFile(join(folder, 'activity.csv'), rowsToCsv(activityRows))
  await writeExportFile(join(folder, 'models.csv'), rowsToCsv(modelRows))
  await writeExportFile(join(folder, 'projects.csv'), rowsToCsv(buildProjectRows(thirtyDayProjects)))
  await writeExportFile(join(folder, 'sessions.csv'), rowsToCsv(buildSessionRows(thirtyDayProjects)))
  await writeExportFile(join(folder, 'tools.csv'), rowsToCsv(buildToolRows(thirtyDayProjects)))
  await writeExportFile(join(folder, 'shell-commands.csv'), rowsToCsv(buildBashRows(thirtyDayProjects)))

  return folder
}

export async function exportJson(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1]?.projects ?? []
  const { code, rate, symbol } = getCurrency()

  const data = {
    schema: 'exe-watcher.export.v2',
    generated: new Date().toISOString(),
    currency: { code, rate, symbol },
    summary: buildSummaryRows(periods),
    periods: periods.map(p => ({
      label: p.label,
      daily: buildDailyRows(p.projects, p.label),
      activity: buildActivityRows(p.projects, p.label),
      models: buildModelRows(p.projects, p.label),
    })),
    projects: buildProjectRows(thirtyDayProjects),
    sessions: buildSessionRows(thirtyDayProjects),
    tools: buildToolRows(thirtyDayProjects),
    shellCommands: buildBashRows(thirtyDayProjects),
  }

  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  await mkdir(dirname(target), { recursive: true })
  await writeExportFile(target, JSON.stringify(data, null, 2))
  return target
}
