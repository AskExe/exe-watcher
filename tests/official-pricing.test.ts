import { describe, expect, it } from 'vitest'
import { parseOfficialPricing } from '../src/official-pricing.js'
import { calculateCost, getModelCosts, getShortModelName, parseLiteLLMEntry } from '../src/models.js'

describe('official API pricing', () => {
  it('uses Standard rates and preserves full-request long-context rates, without reading Batch as Standard', () => {
    const parsed = parseOfficialPricing('openai', `### Standard pricing data
| gpt-6-astra | $10 | $1 | $12.50 | $50 | $20 | $2 | $25 | $75 |
### Batch pricing data
| gpt-6-astra | $5 | $0.50 | $6.25 | $25 | $10 | $1 | $12.50 | $37.50 |
### Fast pricing data
| gpt-6-astra | $20 | $2 | $25 | $100 | $40 | $4 | $50 | $150 |
### Ultrafast pricing data`)
    expect(parsed.get('gpt-6-astra')).toMatchObject({ inputCostPerToken: 10e-6, fastMultiplier: 2,
      contextTiers: [{ minPromptTokens: 272000, inputCostPerToken: 20e-6, outputCostPerToken: 75e-6, cacheReadCostPerToken: 2e-6, cacheWriteCostPerToken: 25e-6 }] })
  })

  it('retains tier fields when loading the supplemental feed', () => {
    expect(parseLiteLLMEntry({ input_cost_per_token: 10e-6, output_cost_per_token: 50e-6,
      input_cost_per_token_above_272k_tokens: 20e-6, output_cost_per_token_above_272k_tokens: 75e-6,
      cache_read_input_token_cost_above_272k_tokens: 2e-6 })).toMatchObject({
      contextTiers: [{ minPromptTokens: 272000, inputCostPerToken: 20e-6, outputCostPerToken: 75e-6, cacheReadCostPerToken: 2e-6 }] })
  })

  it('prices a mostly cached 300K GPT prompt at the large-prompt tier, exactly once', () => {
    // 50K fresh * $20/M + 250K cached * $2/M + 1K output * $75/M.
    expect(calculateCost('gpt-6-astra', 50000, 1000, 0, 250000, 0, 'standard', 300000)).toBeCloseTo(1.575, 9)
    expect(calculateCost('gpt-6-astra', 272000, 1000, 0, 0, 0)).toBeCloseTo(2.77, 9)
    expect(calculateCost('gpt-5.5', 300000, 1000, 0, 0, 0)).toBeCloseTo(3.045, 9)
  })

  it('keeps Anthropic cache TTLs, fast rates and fixed search fees separate', () => {
    // $4 input + $20 output + $2.50 5m writes + $4 1h writes + $0.20 reads.
    expect(calculateCost('claude-opus-5-5', 1e6, 1e6, 1e6, 1e6, 1, 'fast', 0, 500000)).toBeCloseTo(61.41, 9)
    expect(calculateCost('claude-opus-4-8', 1e6, 0, 0, 0, 0, 'fast')).toBe(10)
    expect(calculateCost('claude-opus-4-6', 1e6, 0, 0, 0, 0, 'fast')).toBe(5)
  })

  it('handles MiniMax cached reads without applying its highspeed input multiplier', () => {
    expect(calculateCost('MiniMax-M2.7-highspeed', 1e6, 1e6, 1e6, 1e6, 0)).toBeCloseTo(3.435, 9)
    expect(calculateCost('MiniMax-M2.5-highspeed', 0, 0, 0, 1e6, 0)).toBeCloseTo(0.03, 9)
  })

  it('uses Kimi cache-write prices instead of assuming Anthropic multipliers', () => {
    expect(calculateCost('kimi-k3', 1e6, 0, 1e6, 1e6, 0, 'standard', 0, 0)).toBeCloseTo(6.3, 9)
    expect(calculateCost('kimi-k3', 1e6, 0, 1e6, 1e6, 0, 'standard', 0, 1e6)).toBeCloseTo(9.3, 9)
  })

  it('uses Z.AI rates and does not invent a storage charge', () => {
    expect(calculateCost('glm-5.3', 1e6, 1e6, 1e6, 1e6, 0)).toBeCloseTo(6.06, 9)
    expect(calculateCost('glm-4.7-flash', 1e6, 1e6, 1e6, 1e6, 0)).toBe(0)
  })

  it('does not assign base-model prices to distinct unpriced variants', () => {
    expect(getModelCosts('gpt-5.3-codex-spark')).toBeNull()
    expect(getModelCosts('gpt-5-imaginary')).toBeNull()
    expect(getShortModelName('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(getShortModelName('gpt-5-imaginary')).toBe('gpt-5-imaginary')
  })

  it('uses the higher Grok tier at exactly 200K prompt tokens', () => {
    expect(calculateCost('grok-4.5', 200000, 1000, 0, 0, 0)).toBeCloseTo(0.812, 9)
    expect(calculateCost('grok-4.5', 199999, 1000, 0, 0, 0)).toBeCloseTo(0.405998, 9)
  })
})
