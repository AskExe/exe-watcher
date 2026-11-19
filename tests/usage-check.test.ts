import { describe, expect, it } from 'vitest'
import { checkUsageSources } from '../src/usage-check.js'
import { ResourceBudgetError } from '../src/resource-budget.js'
import type { Provider } from '../src/providers/types.js'

function reader(name: string, discover: Provider['discoverSessions']): Provider {
  return { name, displayName: name, discoverSessions: discover,
    modelDisplayName: model => model, toolDisplayName: tool => tool,
    createSessionParser: () => { throw Error('Discovery must not parse conversation contents') } }
}

describe('onboarding source checks', () => {
  it('uses the actual readers and counts unique sources without claiming token coverage', async () => {
    const result = await checkUsageSources([
      reader('claude', async () => [{ path: '/private/project', project: 'private', provider: 'claude' }, { path: '/private/project', project: 'private', provider: 'claude' }]),
      reader('codex', async () => []),
    ])
    expect(result.providers).toEqual([
      { id: 'claude', name: 'claude', sources: 1, state: 'found' },
      { id: 'codex', name: 'codex', sources: 0, state: 'not-found' },
    ])
    expect(JSON.stringify(result)).not.toContain('/private')
  })
  it('keeps failed checks distinct from absent sources and sanitizes exception text', async () => {
    const result = await checkUsageSources([
      reader('broken', async () => { throw Error('/private/credentials.json: secret') }),
      reader('empty', async () => []),
    ])
    expect(result.providers.map(p => p.state)).toEqual(['unavailable', 'not-found'])
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('stops at the resource limit and marks remaining sources unverified', async () => {
    let laterRan = false
    const result = await checkUsageSources([
      reader('large', async () => { throw new ResourceBudgetError('scan budget') }),
      reader('later', async () => { laterRan = true; return [] }),
    ])
    expect(laterRan).toBe(false)
    expect(result.providers.map(p => p.state)).toEqual(['unavailable', 'unavailable'])
  })
})
