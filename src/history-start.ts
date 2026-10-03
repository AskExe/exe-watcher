import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cachedDiscoveryHeader } from './discovery-cache.js'
import { readSessionFirstLine } from './fs-utils.js'
import { getDiscoveredSources } from './parser.js'

export function parseHistoryStartDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

/** Use a configured start, cached history, and bounded session header reads. No
 * fixed age cutoff: old sessions remain visible as the user's history grows. */
export async function resolveHistoryStart(configured: string | undefined, cachedDates: string[], now = new Date()): Promise<Date> {
  const requestedStart = parseHistoryStartDate(configured)
  if (requestedStart && requestedStart <= now) return requestedStart
  let earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const include = (date: Date | null) => {
    if (date && Number.isFinite(date.getTime()) && date < earliest) earliest = date
  }
  include(parseHistoryStartDate(configured))
  for (const date of cachedDates) include(parseHistoryStartDate(date))
  const sources = await getDiscoveredSources()
  for (const source of sources) {
    const sourceStat = await stat(source.path).catch(() => null)
    if (!sourceStat) continue
    const paths = sourceStat.isDirectory()
      ? (await readdir(source.path)).filter(name => name.endsWith('.jsonl')).map(name => join(source.path, name))
      : source.path.endsWith('.jsonl') ? [source.path] : []
    for (const path of paths) {
      const fileStat = await stat(path).catch(() => null)
      if (!fileStat) continue
      const timestamp = await cachedDiscoveryHeader<string>('history-start', path, fileStat, async () => {
        try {
          const entry = JSON.parse(await readSessionFirstLine(path) ?? '{}')
          return typeof entry.timestamp === 'string' ? entry.timestamp : null
        } catch { return null }
      })
      if (timestamp) include(new Date(timestamp))
    }
  }
  return new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate())
}
