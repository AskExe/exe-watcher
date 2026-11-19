import { getAllProviders } from './providers/index.js'
import type { Provider } from './providers/types.js'
import { chargeRead, ResourceBudgetError, withScanBudget } from './resource-budget.js'

export type UsageSourceCheck = {
  id: string
  name: string
  sources: number
  state: 'found' | 'not-found' | 'unavailable'
}

/** Use the dashboard's readers. Source discovery never proves complete token coverage. */
export async function checkUsageSources(providers?: Provider[]) {
  const readers = providers ?? await getAllProviders()
  const results: UsageSourceCheck[] = []
  await withScanBudget(async () => {
    for (const reader of readers) {
      try {
        chargeRead(0)
        const sources = await reader.discoverSessions()
        const count = new Set(sources.map(source => source.path)).size
        results.push({ id: reader.name, name: reader.displayName, sources: count, state: count ? 'found' : 'not-found' })
      } catch (error) {
        // Paths, session contents and exception bodies stay out of the shareable result.
        results.push({ id: reader.name, name: reader.displayName, sources: 0, state: 'unavailable' })
        if (error instanceof ResourceBudgetError) {
          for (const remaining of readers.slice(results.length)) {
            results.push({ id: remaining.name, name: remaining.displayName, sources: 0, state: 'unavailable' })
          }
          break
        }
      }
    }
  }, 200_000, undefined, 128 * 1024 * 1024)
  return { version: 1, providers: results }
}
