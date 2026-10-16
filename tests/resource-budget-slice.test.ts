import { expect, it } from 'vitest'
import { withScanBudget, withScanSlice, chargeRecord, chargeRead, ScanSliceLimitError, ResourceBudgetError } from '../src/resource-budget.js'

const limits = { maxRecords: 1, maxBytes: 6, maxMs: 10_000 }

it('leaves hard record accounting intact when a smaller analysis slice ends', async () => {
  await withScanBudget(async () => {
    await expect(withScanSlice(async () => { chargeRecord(); chargeRecord() }, limits)).rejects.toBeInstanceOf(ScanSliceLimitError)
    chargeRecord(); chargeRecord()
    expect(() => chargeRecord()).toThrow('4 scanned usage records')
  }, 4)
})

it('shares the original byte cap across the slice and subsequent detectors', async () => {
  await withScanBudget(async () => {
    await expect(withScanSlice(async () => chargeRead(7), limits)).rejects.toBeInstanceOf(ScanSliceLimitError)
    expect(() => chargeRead(4)).toThrow('read budget')
  }, 100, undefined, 10)
})

it('does not downgrade cancellation or a hard budget failure to partial success', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(withScanBudget(() => withScanSlice(async () => chargeRead(0), limits), 100, controller.signal))
    .rejects.toSatisfy((e: Error) => e instanceof ResourceBudgetError && !(e instanceof ScanSliceLimitError))
  await expect(withScanBudget(() => withScanSlice(async () => chargeRead(11), limits), 100, undefined, 10))
    .rejects.toSatisfy((e: Error) => e instanceof ResourceBudgetError && !(e instanceof ScanSliceLimitError))
})
