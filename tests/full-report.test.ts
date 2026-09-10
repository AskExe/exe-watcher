import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LatestLoad } from '../src/latest-load.js'
import { parseAllSessions, clearParserCaches } from '../src/parser.js'
import { aggregateModelStats, computeCategoryComparison, computeWorkingStyle } from '../src/compare-stats.js'
import { mergeReportSession } from '../src/report-summary.js'
import { withScanBudget, chargeRead } from '../src/resource-budget.js'
let dir = ''
afterEach(async () => { clearParserCaches(); vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }) })
it('keeps exact totals, daily activity and comparisons without retaining all-time calls', async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-report-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir); vi.stubEnv('EXE_WATCHER_CACHE_DIR', join(dir, 'cache'))
  const project = join(dir, 'projects', 'fixture'); await mkdir(project, { recursive: true })
  const entries = []
  for (let i=0; i<60; i++) {
    const timestamp = `2026-01-${String(i%28+1).padStart(2,'0')}T12:00:00Z`
    entries.push({ type:'user', timestamp, sessionId:'s', message:{role:'user',content:'fix bug '+ 'padding '.repeat(1000)} })
    entries.push({ type:'assistant',timestamp,sessionId:'s',message:{role:'assistant',id:`m${i}`,model:i%2?'claude-opus-4-6':'claude-sonnet-4-6',usage:{input_tokens:100,output_tokens:25},content:[{type:'tool_use',id:`t${i}`,name:i%2?'Edit':'EnterPlanMode',input:{}}]} })
  }
  await writeFile(join(project,'s.jsonl'),entries.map(x=>JSON.stringify(x)).join('\n'))
  const full = (await parseAllSessions(undefined,'claude')).filter(p => p.project === 'fixture')
  const compact = (await parseAllSessions(undefined,'claude',true)).filter(p => p.project === 'fixture')
  expect(compact[0]!.totalApiCalls).toBe(60)
  expect(compact[0]!.totalCostUSD).toBe(full[0]!.totalCostUSD)
  expect(compact[0]!.sessions[0]!.turns).toEqual([])
  const daily = Object.values(compact[0]!.sessions[0]!.reportSummary!.daily)
  expect(daily.reduce((n,r)=>n+r.calls,0)).toBe(60)
  expect(daily.reduce((n,r)=>n+r.cost,0)).toBeCloseTo(full[0]!.totalCostUSD)
  expect(aggregateModelStats(compact)).toEqual(aggregateModelStats(full))
  const models=aggregateModelStats(full).map(x=>x.model)
  expect(computeCategoryComparison(compact,models[0]!,models[1]!)).toEqual(computeCategoryComparison(full,models[0]!,models[1]!))
  expect(computeWorkingStyle(compact,models[0]!,models[1]!)).toEqual(computeWorkingStyle(full,models[0]!,models[1]!))
  const merged=structuredClone(compact[0]!.sessions[0]!)
  mergeReportSession(merged,compact[0]!.sessions[0]!)
  expect(merged.apiCalls).toBe(120)
  expect(Object.values(merged.reportSummary!.daily).reduce((n,r)=>n+r.calls,0)).toBe(120)
  expect(merged.turns).toEqual([])
})
it('serializes period loads, cancels running work and drops intermediate selections', async () => {
  const loader = new LatestLoad()
  let release!:()=>void
  const gate = new Promise<void>(r=>release=r)
  let active=0,maxActive=0
  const started:string[]=[]
  const first=loader.run(async signal=>{ started.push('week'); active++;maxActive=Math.max(maxActive,active);await gate; expect(signal.aborted).toBe(true);active--;return 'week' })
  await new Promise(r=>setTimeout(r,0))
  const middle=loader.run(async()=>{started.push('month');return 'month'})
  const last=loader.run(async()=>{started.push('all');active++;maxActive=Math.max(maxActive,active);active--;return 'all'})
  release()
  expect(await first).toBeUndefined();expect(await middle).toBeUndefined();expect(await last).toBe('all')
  expect(started).toEqual(['week','all']);expect(maxActive).toBe(1);expect(loader.busy).toBe(false)
})
it('settles a failed load and permits a later retry', async () => {
  const loader=new LatestLoad()
  await expect(loader.run(async()=>{throw new Error('budget exhausted')})).rejects.toThrow('budget exhausted')
  expect(await loader.run(async()=>42)).toBe(42)
})
it('cancels filesystem work through the shared scan budget', async () => {
  const controller=new AbortController();controller.abort()
  await expect(withScanBudget(async()=>chargeRead(1),200_000,controller.signal)).rejects.toThrow('scan cancelled')
})
