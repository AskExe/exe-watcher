import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import { getModelCosts, getShortModelName, calculateCost, loadPricing, setModelAliases } from '../src/models.js'

beforeAll(async () => {
  await loadPricing()
})

afterEach(() => setModelAliases({}))

describe('getModelCosts', () => {
  it('does not match short canonical against longer pricing key', () => {
    const costs = getModelCosts('gpt-4')
    if (costs) {
      expect(costs.inputCostPerToken).not.toBe(2.5e-6)
    }
  })

  it('returns correct pricing for gpt-4o vs gpt-4o-mini', () => {
    const mini = getModelCosts('gpt-4o-mini')
    const full = getModelCosts('gpt-4o')
    expect(mini).not.toBeNull()
    expect(full).not.toBeNull()
    expect(mini!.inputCostPerToken).toBeLessThan(full!.inputCostPerToken)
  })

  it('returns fallback pricing for known Claude models', () => {
    const costs = getModelCosts('claude-opus-4-6-20260205')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(5e-6)
  })

  it('keeps official regression values for current OpenAI fallback rows', () => {
    expect(getModelCosts('gpt-5')).toMatchObject({
      inputCostPerToken: 1.25e-6,
      outputCostPerToken: 10e-6,
      cacheReadCostPerToken: 0.125e-6,
    })
    expect(getModelCosts('gpt-5-mini')).toMatchObject({
      inputCostPerToken: 0.25e-6,
      outputCostPerToken: 2e-6,
    })
    expect(getModelCosts('gpt-5-mini')!.cacheReadCostPerToken).toBeCloseTo(0.025e-6, 14)
    expect(getModelCosts('gpt-5.1-codex')).toMatchObject({
      inputCostPerToken: 1.25e-6,
      outputCostPerToken: 10e-6,
      cacheReadCostPerToken: 0.125e-6,
    })
    expect(getModelCosts('gpt-5.1-codex-mini')).toMatchObject({
      inputCostPerToken: 0.25e-6,
      outputCostPerToken: 2e-6,
      cacheReadCostPerToken: 0.025e-6,
    })
    expect(getModelCosts('gpt-5.2-codex')).toMatchObject({
      inputCostPerToken: 1.75e-6,
      outputCostPerToken: 14e-6,
      cacheReadCostPerToken: 0.175e-6,
    })
  })

  it('covers current missing fallback catalog rows used offline', () => {
    expect(getModelCosts('gpt-5.5-pro')).not.toBeNull()
    expect(getModelCosts('gpt-5.4-pro')).not.toBeNull()
    expect(getModelCosts('gpt-5.4-nano')).not.toBeNull()
    expect(getModelCosts('gpt-5.2')).not.toBeNull()
    expect(getModelCosts('gpt-5.1')).not.toBeNull()
    expect(getModelCosts('gpt-5-codex')).not.toBeNull()
  })

  it('models Gemini 2.5 Pro long-context tiers in fallback pricing', () => {
    const costs = getModelCosts('gemini-2.5-pro')
    expect(costs).toMatchObject({
      inputCostPerToken: 1.25e-6,
      outputCostPerToken: 10e-6,
      cacheReadCostPerToken: 0.125e-6,
    })
    expect(costs?.contextTiers?.[0]).toMatchObject({
      minPromptTokens: 200_000,
      inputCostPerToken: 2.5e-6,
      outputCostPerToken: 15e-6,
      cacheReadCostPerToken: 0.25e-6,
    })
  })
})

describe('getShortModelName', () => {
  it('maps gpt-4o-mini correctly (not gpt-4o)', () => {
    expect(getShortModelName('gpt-4o-mini-2024-07-18')).toBe('GPT-4o Mini')
  })

  it('maps gpt-4o correctly', () => {
    expect(getShortModelName('gpt-4o-2024-08-06')).toBe('GPT-4o')
  })

  it('maps gpt-4.1-mini correctly (not gpt-4.1)', () => {
    expect(getShortModelName('gpt-4.1-mini-2025-04-14')).toBe('GPT-4.1 Mini')
  })

  it('maps gpt-5.4-mini correctly (not gpt-5.4)', () => {
    expect(getShortModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
  })

  it('maps claude-opus-4-6 with date suffix', () => {
    expect(getShortModelName('claude-opus-4-6-20260205')).toBe('Opus 4.6')
  })
})

describe('builtin aliases - getModelCosts', () => {
  it('resolves anthropic--claude-4.6-opus', () => {
    expect(getModelCosts('anthropic--claude-4.6-opus')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.6-sonnet', () => {
    expect(getModelCosts('anthropic--claude-4.6-sonnet')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-opus', () => {
    expect(getModelCosts('anthropic--claude-4.5-opus')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-sonnet', () => {
    expect(getModelCosts('anthropic--claude-4.5-sonnet')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-haiku', () => {
    expect(getModelCosts('anthropic--claude-4.5-haiku')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.6-opus', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.6-opus')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.6-sonnet', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.6-sonnet')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.5-haiku', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.5-haiku')).not.toBeNull()
  })

  it('OMP opus resolves to same pricing as canonical claude-opus-4-6', () => {
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-opus-4-6'))
  })

  it('OMP sonnet resolves to same pricing as canonical claude-sonnet-4-6', () => {
    expect(getModelCosts('anthropic--claude-4.6-sonnet')).toEqual(getModelCosts('claude-sonnet-4-6'))
  })

  it('OMP haiku resolves to same pricing as canonical claude-haiku-4-5', () => {
    expect(getModelCosts('anthropic--claude-4.5-haiku')).toEqual(getModelCosts('claude-haiku-4-5'))
  })
})

describe('builtin aliases - getShortModelName', () => {
  it('anthropic--claude-4.6-opus -> Opus 4.6', () => {
    expect(getShortModelName('anthropic--claude-4.6-opus')).toBe('Opus 4.6')
  })

  it('anthropic--claude-4.6-sonnet -> Sonnet 4.6', () => {
    expect(getShortModelName('anthropic--claude-4.6-sonnet')).toBe('Sonnet 4.6')
  })

  it('anthropic--claude-4.5-opus -> Opus 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-opus')).toBe('Opus 4.5')
  })

  it('anthropic--claude-4.5-sonnet -> Sonnet 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-sonnet')).toBe('Sonnet 4.5')
  })

  it('anthropic--claude-4.5-haiku -> Haiku 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-haiku')).toBe('Haiku 4.5')
  })

  it('anthropic/anthropic--claude-4.6-opus -> Opus 4.6', () => {
    expect(getShortModelName('anthropic/anthropic--claude-4.6-opus')).toBe('Opus 4.6')
  })
})

describe('user aliases via setModelAliases', () => {
  it('user alias resolves for getModelCosts', () => {
    setModelAliases({ 'my-internal-model': 'claude-sonnet-4-6' })
    expect(getModelCosts('my-internal-model')).toEqual(getModelCosts('claude-sonnet-4-6'))
  })

  it('user alias resolves for getShortModelName', () => {
    setModelAliases({ 'my-internal-model': 'claude-opus-4-6' })
    expect(getShortModelName('my-internal-model')).toBe('Opus 4.6')
  })

  it('user alias overrides builtin', () => {
    setModelAliases({ 'anthropic--claude-4.6-opus': 'claude-sonnet-4-5' })
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-sonnet-4-5'))
  })

  it('resetting aliases restores builtins', () => {
    setModelAliases({ 'anthropic--claude-4.6-opus': 'claude-sonnet-4-5' })
    setModelAliases({})
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-opus-4-6'))
  })
})

describe('calculateCost - OMP names produce non-zero cost', () => {
  it('calculates cost for anthropic--claude-4.6-opus', () => {
    expect(calculateCost('anthropic--claude-4.6-opus', 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('calculates cost for anthropic/anthropic--claude-4.6-sonnet', () => {
    expect(calculateCost('anthropic/anthropic--claude-4.6-sonnet', 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('applies GPT-5.4 long-context pricing once prompts cross 272K tokens', () => {
    expect(calculateCost('gpt-5.4', 300_000, 100, 0, 0, 0)).toBeCloseTo(1.50225, 6)
  })

  it('uses explicit tierInputTokens for cached long-context prompts', () => {
    // 50K fresh + 250K cached should select the 300K long-context tier while still
    // pricing the fresh/cache portions at their own rates.
    expect(calculateCost('gpt-5.4', 50_000, 100, 0, 250_000, 0, 'standard', 300_000))
      .toBeCloseTo(0.375 + 0.00225, 6)
  })

  it('applies Gemini 2.5 Pro long-context pricing once prompts cross 200K tokens', () => {
    expect(calculateCost('gemini-2.5-pro', 250_000, 100, 0, 0, 0)).toBeCloseTo(0.6265, 6)
  })
})

describe('existing model names still resolve', () => {
  it('canonical claude-opus-4-6', () => {
    expect(getModelCosts('claude-opus-4-6')).not.toBeNull()
  })

  it('canonical claude-sonnet-4-5', () => {
    expect(getModelCosts('claude-sonnet-4-5')).not.toBeNull()
  })

  it('date-stamped claude-sonnet-4-20250514', () => {
    expect(getModelCosts('claude-sonnet-4-20250514')).not.toBeNull()
  })

  it('pinned claude-sonnet-4-6@20250929', () => {
    expect(getModelCosts('claude-sonnet-4-6@20250929')).not.toBeNull()
  })

  it('anthropic/-prefixed anthropic/claude-opus-4-6', () => {
    expect(getModelCosts('anthropic/claude-opus-4-6')).not.toBeNull()
  })
})
