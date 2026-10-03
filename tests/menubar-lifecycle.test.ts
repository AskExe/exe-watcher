import { afterEach, expect, it, vi } from 'vitest'
import { watchMenubarParent } from '../src/menubar-lifecycle.js'

afterEach(() => { vi.useRealTimers() })

it('watches only a verified direct parent and stops polling after completion', () => {
  vi.useFakeTimers()
  const kill = vi.fn(), exit = vi.fn()
  const runtime = { parent: () => 123, checkAlive: kill, exit }
  watchMenubarParent(999, runtime)
  watchMenubarParent(NaN, runtime)
  vi.advanceTimersByTime(4000)
  expect(kill).not.toHaveBeenCalled()
  const stop = watchMenubarParent(123, runtime)
  vi.advanceTimersByTime(2000)
  expect(kill).toHaveBeenCalledWith(123)
  stop()
  vi.advanceTimersByTime(4000)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(exit).not.toHaveBeenCalled()
})

it('exits when the menubar parent disappears instead of leaving an orphan scanner', () => {
  vi.useFakeTimers()
  const exit = vi.fn()
  let parent = 123
  const stop = watchMenubarParent(123, { parent: () => parent, checkAlive: vi.fn(), exit })
  parent = 1
  vi.advanceTimersByTime(2000)
  expect(exit).toHaveBeenCalledTimes(1)
  stop()
})
