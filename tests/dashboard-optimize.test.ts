import { afterEach, expect, it, vi } from 'vitest'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { render } from 'ink'
import type { ProjectSummary } from '../src/types.js'
vi.mock('../src/parser.js', () => ({ parseAllSessions: vi.fn(), filterProjectsByName: (p: unknown) => p, getDiscoveredProviderNames: () => ['claude'] }))
vi.mock('../src/models.js', async () => ({ ...await vi.importActual('../src/models.js'), loadPricing: vi.fn() }))
vi.mock('../src/optimize.js', async () => ({ ...await vi.importActual('../src/optimize.js'), scanAndDetect: vi.fn() }))
vi.mock('../src/context-budget.js', () => ({ discoverProjectCwd: vi.fn().mockResolvedValue(null), estimateContextBudget: vi.fn() }))
vi.mock('../src/plan-usage.js', () => ({ getPlanUsageOrNull: vi.fn().mockResolvedValue(null) }))
vi.mock('../src/time-index.js', () => ({ getTimeReport: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/optimize-share.js', async () => ({ ...await vi.importActual('../src/optimize-share.js'), copyOptimizeMarkdown: vi.fn(), saveOptimizeMarkdown: vi.fn() }))
import { InteractiveDashboard } from '../src/dashboard.js'
import { parseAllSessions } from '../src/parser.js'
import { scanAndDetect } from '../src/optimize.js'
import { ResourceBudgetError } from '../src/resource-budget.js'
import { copyOptimizeMarkdown, saveOptimizeMarkdown } from '../src/optimize-share.js'

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

it('keeps report totals after an Optimize failure and retries only the analysis', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const timestamp = new Date().toISOString()
  const projects: ProjectSummary[] = [{ project: 'fixture', projectPath: '/fixture', totalCostUSD: 42, totalApiCalls: 1,
    sessions: [{ sessionId: 's', project: 'fixture', firstTimestamp: timestamp, lastTimestamp: timestamp, totalCostUSD: 42,
      totalInputTokens: 100, totalOutputTokens: 25, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, apiCalls: 1,
      turns: [], modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {}, categoryBreakdown: {},
    }] }]
  vi.mocked(parseAllSessions).mockResolvedValue(projects)
  vi.mocked(scanAndDetect).mockRejectedValueOnce(new ResourceBudgetError('1 GiB read budget per scan'))
    .mockResolvedValue({ findings: [], costRate: 0, healthScore: 100, healthGrade: 'A' })
  let frame = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { frame += chunk.toString(); callback() } }), { columns: 120, rows: 80, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() })
  const app = render(React.createElement(InteractiveDashboard, { initialPeriod: 'today', initialProvider: 'claude', refreshSeconds: 30 }), {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, interactive: true, patchConsole: false, exitOnCtrlC: false,
  })
  try {
    await vi.waitFor(() => expect(frame).toContain('$42.00'))
    frame = ''; stdin.write('o')
    await vi.waitFor(() => expect(frame).toContain('Optimize could not finish'))
    expect(frame).toContain('Press b to go back')
    expect(frame).not.toContain('Report could not refresh')
    frame = ''; stdin.write('r')
    await vi.waitFor(() => expect(frame).toContain('Changes are yours to apply'))
    expect(scanAndDetect).toHaveBeenCalledTimes(2)
    expect(parseAllSessions).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(scanAndDetect).toHaveBeenCalledTimes(2)
    expect(parseAllSessions).toHaveBeenCalledTimes(1)
    // Changing period can fail while Optimize remains selected. Retry must reload
    // the report first, rather than re-running analysis against a failed load.
    vi.mocked(parseAllSessions).mockRejectedValueOnce(new Error('fixture report load failed'))
    frame = ''; stdin.write('2')
    await vi.waitFor(() => expect(frame).toContain('Report could not refresh'))
    expect(parseAllSessions).toHaveBeenCalledTimes(2)
    frame = ''; stdin.write('r')
    await vi.waitFor(() => expect(frame).toContain('Changes are yours to apply'))
    expect(parseAllSessions).toHaveBeenCalledTimes(3)
    frame = ''; stdin.write('b')
    await vi.waitFor(() => expect(frame).toContain('$42.00'))
    expect(frame).not.toContain('Optimize could not finish')
    expect(parseAllSessions).toHaveBeenCalledTimes(3)
  } finally { app.unmount(); stdin.destroy(); stdout.destroy() }
})

it('copies and saves the displayed recommendations without rescanning and recovers from clipboard errors', async () => {
  vi.mocked(parseAllSessions).mockResolvedValue([])
  vi.mocked(scanAndDetect).mockResolvedValue({ findings: [{ title: 'Cap output', impact: 'medium', tokensSaved: 100,
    explanation: 'Large shell output.', fix: { type: 'command', label: 'Add to your shell:', text: 'export LIMIT=1000' } }],
    costRate: 0.00001, healthGrade: 'B', healthScore: 80, coverage: { partial: true, completedFiles: 1, totalFiles: 10 } })
  vi.mocked(copyOptimizeMarkdown).mockRejectedValueOnce(new Error('clipboard unavailable')).mockResolvedValue(undefined)
  vi.mocked(saveOptimizeMarkdown).mockResolvedValue('/Users/fixture/Downloads/recommendations.md')
  let frame = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { frame += chunk.toString(); callback() } }), { columns: 120, rows: 80, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() })
  const app = render(React.createElement(InteractiveDashboard, { initialPeriod: 'week', initialProvider: 'all', refreshSeconds: 30 }), {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, interactive: true, patchConsole: false, exitOnCtrlC: false,
  })
  try {
    await vi.waitFor(() => expect(frame).toContain('No usage data found'))
    frame = ''; stdin.write('o')
    await vi.waitFor(() => expect(frame).toContain('save .md'))
    expect(frame).toContain('copy all')
    frame = ''; stdin.write('c')
    await vi.waitFor(() => expect(frame).toContain('Could not copy. Press e'))
    frame = ''; stdin.write('e')
    await vi.waitFor(() => expect(frame).toContain('Saved: /Users/fixture/Downloads/recommendations.md'))
    const saved = vi.mocked(saveOptimizeMarkdown).mock.calls[0]![0]
    expect(saved).toContain('Period: 7 Days')
    expect(saved).toContain('Partial analysis: 1/10 logs fully checked')
    expect(saved).toContain('export LIMIT=1000')
    frame = ''; stdin.write('c')
    await vi.waitFor(() => expect(frame).toContain('Copied all recommendations. Paste into Claude Code.'))
    expect(copyOptimizeMarkdown).toHaveBeenLastCalledWith(expect.stringContaining('export LIMIT=1000'))
    expect(scanAndDetect).toHaveBeenCalledTimes(1)
    expect(parseAllSessions).toHaveBeenCalledTimes(1)
    frame = ''; stdin.write('b')
    await vi.waitFor(() => expect(frame).toContain('No usage data found'))
  } finally { app.unmount(); stdin.destroy(); stdout.destroy() }
})
