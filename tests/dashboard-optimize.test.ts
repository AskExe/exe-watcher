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
import { InteractiveDashboard } from '../src/dashboard.js'
import { parseAllSessions } from '../src/parser.js'
import { scanAndDetect } from '../src/optimize.js'
import { ResourceBudgetError } from '../src/resource-budget.js'

afterEach(() => vi.clearAllMocks())

it('keeps report totals after an Optimize failure and retries only the analysis', async () => {
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
  const app = render(React.createElement(InteractiveDashboard, { initialPeriod: 'today', initialProvider: 'claude' }), {
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
    frame = ''; stdin.write('b')
    await vi.waitFor(() => expect(frame).toContain('$42.00'))
    expect(frame).not.toContain('Optimize could not finish')
    expect(parseAllSessions).toHaveBeenCalledTimes(1)
  } finally { app.unmount(); stdin.destroy(); stdout.destroy() }
})
