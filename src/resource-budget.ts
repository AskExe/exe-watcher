import { AsyncLocalStorage } from 'node:async_hooks'

export class ResourceBudgetError extends Error {
  constructor(detail: string) { super(`Resource limit reached (${detail}). Showing the last successful refresh; retry after background ingestion progresses.`); this.name = 'ResourceBudgetError' }
}
type Budget = { bytes: number; records: number; started: number }
const scans = new AsyncLocalStorage<Budget>()
export function withScanBudget<T>(fn: () => Promise<T>): Promise<T> {
  if (scans.getStore()) return fn()
  return scans.run({ bytes: 0, records: 0, started: Date.now() }, fn)
}
export function chargeRead(bytes: number): void {
  const budget = scans.getStore()
  if (!budget) return
  budget.bytes += bytes
  if (budget.bytes > 1024 * 1024 * 1024) throw new ResourceBudgetError('1 GiB read budget per scan')
  if (Date.now() - budget.started > 30_000) throw new ResourceBudgetError('30 second scan budget')
  if (process.memoryUsage().heapUsed > 384 * 1024 * 1024) throw new ResourceBudgetError('384 MiB parser heap budget')
}
export function chargeRecord(): void {
  const budget = scans.getStore()
  if (!budget) return
  if (++budget.records > 200_000) throw new ResourceBudgetError('200,000 retained usage records')
  if (budget.records % 256 === 0) chargeRead(0)
}
export function checkFileSize(size: number, cap: number): boolean {
  if (size <= cap) return true
  if (scans.getStore()) throw new ResourceBudgetError(`file exceeds ${cap} bytes`)
  return false
}
