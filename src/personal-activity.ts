import { openSync, readSync, closeSync, constants, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { getCacheDir } from './cache-dir.js'
import type { DateRange } from './types.js'

/** Daily foreground totals only. Written by the Mac app; never contains input or window content. */
export type ActivityDay = { start: number; end: number; active: Record<string, number>; contextual: Record<string, number> }
export type ActivityHistory = { version: 1; startedAt: string; updatedAt: string; enabled: boolean; days: ActivityDay[] }
export type AppActivity = { activeMs: number; contextualMs: number; startedAt: string; updatedAt: string; enabled: boolean }
export const ACTIVITY_LIMIT = 4 * 1024 ** 2

export function readActivityHistory(): ActivityHistory | undefined {
  let fd: number | undefined
  try {
    fd = openSync(join(getCacheDir(), 'personal-activity-v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > ACTIVITY_LIMIT) return undefined
    const buffer = Buffer.alloc(stat.size)
    if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return undefined
    const x = JSON.parse(buffer.toString('utf8')) as ActivityHistory
    if (x.version !== 1 || typeof x.enabled !== 'boolean' || typeof x.startedAt !== 'string' || typeof x.updatedAt !== 'string' || !Array.isArray(x.days) || x.days.length > 36_600 ||
      !Number.isFinite(Date.parse(x.startedAt)) || !Number.isFinite(Date.parse(x.updatedAt))) return undefined
    let end = 0
    for (const day of x.days) {
      if (!Number.isFinite(day.start) || !Number.isFinite(day.end) || day.start < end || day.end <= day.start || day.end - day.start > 26 * 3600_000) return undefined
      let total = 0
      for (const map of [day.active, day.contextual]) {
        if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 32) return undefined
        for (const value of Object.values(map)) {
          if (!Number.isFinite(value) || value < 0) return undefined
          total += value
        }
      }
      if (total > day.end - day.start) return undefined
      end = day.end
    }
    return x
  } catch { return undefined }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function summarizeActivity(history: ActivityHistory | undefined, range: DateRange, provider = 'all'): AppActivity | undefined {
  if (!history) return undefined
  let activeMs = 0, contextualMs = 0
  for (const day of history.days) {
    const overlap = Math.max(0, Math.min(day.end, range.end.getTime()) - Math.max(day.start, range.start.getTime()))
    if (!overlap) continue
    // Standard dashboard windows contain full local days. Custom sub-day queries
    // cannot locate past focus within daily totals, so don't fabricate a fraction.
    if (range.start.getTime() > day.start || range.end.getTime() < Math.min(day.end, Date.parse(history.updatedAt))) continue
    const sum = (map: Record<string, number>) => provider === 'all' ? Object.values(map).reduce((a, b) => a + b, 0) : Object.hasOwn(map, provider) ? map[provider]! : 0
    activeMs += sum(day.active); contextualMs += sum(day.contextual)
  }
  return { activeMs, contextualMs, startedAt: history.startedAt, updatedAt: history.updatedAt, enabled: history.enabled }
}
