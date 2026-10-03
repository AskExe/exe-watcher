import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getModelCosts, getPricingFingerprint, loadPricing } from '../src/models.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'watcher-pricing-'))
  vi.stubEnv('EXE_WATCHER_CACHE_DIR', dir)
})
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }) })

describe('pricing source selection and refresh', () => {
  it('prefers the model vendor over unrelated hosts and does not guess a host for unqualified names', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('litellm')) return new Response(JSON.stringify({
        'reseller/glm-5.3': { input_cost_per_token: 0.01, output_cost_per_token: 0.02 },
        'zai/glm-5.3': { input_cost_per_token: 1.4e-6, output_cost_per_token: 4.4e-6, cache_read_input_token_cost: 0.26e-6 },
        'reseller/obscure-only': { input_cost_per_token: 0.01, output_cost_per_token: 0.02 },
      }))
      if (url.includes('docs.z.ai')) return new Response('| GLM-5.3 | $1.4 | $0.26 | Limited-time Free | $4.4 |')
      return new Response('', { status: 503 })
    }))
    await loadPricing()
    expect(getModelCosts('glm-5.3')).toMatchObject({ inputCostPerToken: 1.4e-6, cacheWriteCostPerToken: 0 })
    expect(getModelCosts('reseller/glm-5.3')?.inputCostPerToken).toBe(0.01)
    expect(getModelCosts('obscure-only')).toBeNull()
    expect(getModelCosts('reseller/obscure-only')?.inputCostPerToken).toBe(0.01)
  })

  it('changes the cache fingerprint when refreshed rates change and preserves it on a warm cache load', async () => {
    let price = '$1.4'
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('litellm')) return new Response('{}')
      if (url.includes('docs.z.ai')) return new Response(`| GLM-5.3 | ${price} | $0.26 | Limited-time Free | $4.4 |`)
      return new Response('', { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    await loadPricing()
    const original = getPricingFingerprint(), calls = fetch.mock.calls.length
    await loadPricing()
    expect(fetch.mock.calls).toHaveLength(calls)
    expect(getPricingFingerprint()).toBe(original)
    await unlink(join(dir, 'litellm-pricing.json'))
    price = '$2.8'
    await loadPricing()
    expect(getModelCosts('glm-5.3')?.inputCostPerToken).toBe(2.8e-6)
    expect(getPricingFingerprint()).not.toBe(original)
  })
})
