import { getHeapStatistics } from 'node:v8'
import { AsyncLocalStorage } from 'node:async_hooks'

export class ResourceBudgetError extends Error {
  constructor(detail: string) { super(`Resource limit reached (${detail}). Showing the last successful refresh; retry after background ingestion progresses.`); this.name = 'ResourceBudgetError' }
}
type Budget = { bytes: number; records: number; started: number; maxRecords: number; signal?: AbortSignal; maxBytes: number }
const scans = new AsyncLocalStorage<Budget>()
export function withScanBudget<T>(fn: () => Promise<T>, maxRecords = 200_000, signal?: AbortSignal, maxBytes = 1024 * 1024 * 1024): Promise<T> {
  if (scans.getStore()) return fn()
  return scans.run({ bytes: 0, records: 0, started: Date.now(), maxRecords, signal, maxBytes }, fn)
}
export function chargeRead(bytes: number): void {
  const budget = scans.getStore()
  if (!budget) return
  if (budget.signal?.aborted) throw new ResourceBudgetError('scan cancelled')
  budget.bytes += bytes
  if (budget.bytes > budget.maxBytes) throw new ResourceBudgetError(`${budget.maxBytes / 1024 ** 3} GiB read budget per scan`)
  if (Date.now() - budget.started > 30_000) throw new ResourceBudgetError('30 second scan budget')
  const heapBudget = Math.min(384 * 1024 * 1024, getHeapStatistics().heap_size_limit * 0.65)
  if (process.memoryUsage().heapUsed > heapBudget) throw new ResourceBudgetError('parser heap budget')
}
export function chargeRecord(): void {
  const budget = scans.getStore()
  if (!budget) return
  if (++budget.records > budget.maxRecords) throw new ResourceBudgetError(`${budget.maxRecords.toLocaleString()} scanned usage records`)
  if (budget.records % 256 === 0) chargeRead(0)
}
export function checkFileSize(size: number, cap: number): boolean {
  if (size <= cap) return true
  if (scans.getStore()) throw new ResourceBudgetError(`file exceeds ${cap} bytes`)
  return false
}
