import { readFile, mkdir, rename, unlink } from 'fs/promises'
import { open } from 'fs/promises'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'

import { getCacheDir } from './cache-dir.js'
import { fetchOfficialPricing, OFFICIAL_PRICING_SOURCES } from './official-pricing.js'
import verifiedPricing from './verified-pricing.json'

export type ModelCosts = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheWriteCostPerToken: number
  cacheWrite1hCostPerToken?: number
  cacheReadCostPerToken: number
  webSearchCostPerRequest: number
  fastMultiplier: number
  source?: string
  contextTiers?: Array<{
    minPromptTokens: number
    inputCostPerToken?: number
    outputCostPerToken?: number
    cacheWriteCostPerToken?: number
    cacheReadCostPerToken?: number
  }>
}

type LiteLLMEntry = {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  input_cost_per_token_above_272k_tokens?: number
  output_cost_per_token_above_272k_tokens?: number
  cache_creation_input_token_cost_above_272k_tokens?: number
  cache_read_input_token_cost_above_272k_tokens?: number
  cache_creation_input_token_cost_above_1hr?: number
  litellm_provider?: string
  source?: string
  provider_specific_entry?: { fast?: number }
}

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WEB_SEARCH_COST = 0.01
const LONG_CONTEXT_1M_THRESHOLD_TOKENS = 272_000
const GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
const DIRECT_PROVIDER_PREFIXES = ['openai/', 'anthropic/', 'gemini/', 'google/', 'minimax/', 'zai/', 'moonshot/', 'deepseek/', 'xai/']
const PRICING_CACHE_SCHEMA = 2

const FALLBACK_PRICING: Record<string, ModelCosts> = {
  // Anthropic first-party list prices: https://platform.claude.com/docs/en/about-claude/pricing
  'claude-fable-5-1': { inputCostPerToken: 10e-6, outputCostPerToken: 50e-6, cacheWriteCostPerToken: 12.5e-6, cacheReadCostPerToken: 0.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-5-5': { inputCostPerToken: 4e-6, outputCostPerToken: 20e-6, cacheWriteCostPerToken: 5e-6, cacheReadCostPerToken: 0.2e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 2 },
  'claude-opus-5': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 2 },
  'claude-sonnet-5': { inputCostPerToken: 2e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 2.5e-6, cacheReadCostPerToken: 0.2e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-fable-5': { inputCostPerToken: 10e-6, outputCostPerToken: 50e-6, cacheWriteCostPerToken: 12.5e-6, cacheReadCostPerToken: 1e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4-8': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 2 },
  'claude-opus-4-7': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4-6': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4-5': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4-1': { inputCostPerToken: 15e-6, outputCostPerToken: 75e-6, cacheWriteCostPerToken: 18.75e-6, cacheReadCostPerToken: 1.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4': { inputCostPerToken: 15e-6, outputCostPerToken: 75e-6, cacheWriteCostPerToken: 18.75e-6, cacheReadCostPerToken: 1.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4-6': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4-5': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-7-sonnet': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-5-sonnet': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-haiku-4-5': { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.1e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-5-haiku': { inputCostPerToken: 0.8e-6, outputCostPerToken: 4e-6, cacheWriteCostPerToken: 1e-6, cacheReadCostPerToken: 0.08e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4o': { inputCostPerToken: 2.5e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 2.5e-6, cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4o-mini': { inputCostPerToken: 0.15e-6, outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.15e-6, cacheReadCostPerToken: 0.075e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-2.5-pro': {
    inputCostPerToken: 1.25e-6,
    outputCostPerToken: 10e-6,
    cacheWriteCostPerToken: 1.25e-6,
    cacheReadCostPerToken: 0.125e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
    contextTiers: [{
      minPromptTokens: GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS,
      inputCostPerToken: 2.5e-6,
      outputCostPerToken: 15e-6,
      cacheReadCostPerToken: 0.25e-6,
    }],
  },
  'gpt-5.5': { inputCostPerToken: 5e-6, outputCostPerToken: 30e-6, cacheWriteCostPerToken: 5e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.5-pro': { inputCostPerToken: 30e-6, outputCostPerToken: 180e-6, cacheWriteCostPerToken: 0, cacheReadCostPerToken: 0, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.4': {
    inputCostPerToken: 2.5e-6,
    outputCostPerToken: 15e-6,
    cacheWriteCostPerToken: 2.5e-6,
    cacheReadCostPerToken: 0.25e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
    contextTiers: [{
      minPromptTokens: LONG_CONTEXT_1M_THRESHOLD_TOKENS,
      inputCostPerToken: 5e-6,
      outputCostPerToken: 22.5e-6,
      cacheWriteCostPerToken: 5e-6,
      cacheReadCostPerToken: 0.5e-6,
    }],
  },
  'gpt-5.4-pro': {
    inputCostPerToken: 30e-6,
    outputCostPerToken: 180e-6,
    cacheWriteCostPerToken: 0,
    cacheReadCostPerToken: 0,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
    contextTiers: [{
      minPromptTokens: LONG_CONTEXT_1M_THRESHOLD_TOKENS,
      inputCostPerToken: 60e-6,
      outputCostPerToken: 270e-6,
    }],
  },
  'gpt-5.4-mini': { inputCostPerToken: 0.75e-6, outputCostPerToken: 4.5e-6, cacheWriteCostPerToken: 0.75e-6, cacheReadCostPerToken: 0.075e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.4-nano': { inputCostPerToken: 0.2e-6, outputCostPerToken: 1.25e-6, cacheWriteCostPerToken: 0.2e-6, cacheReadCostPerToken: 0.02e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.3-codex': { inputCostPerToken: 1.75e-6, outputCostPerToken: 14e-6, cacheWriteCostPerToken: 1.75e-6, cacheReadCostPerToken: 0.175e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.2': { inputCostPerToken: 1.75e-6, outputCostPerToken: 14e-6, cacheWriteCostPerToken: 1.75e-6, cacheReadCostPerToken: 0.175e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.1': { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.125e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5': { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.125e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5-codex': { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.125e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5-mini': { inputCostPerToken: 0.25e-6, outputCostPerToken: 2e-6, cacheWriteCostPerToken: 0.25e-6, cacheReadCostPerToken: 0.025e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5-nano': { inputCostPerToken: 0.05e-6, outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.05e-6, cacheReadCostPerToken: 0.005e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1': { inputCostPerToken: 2e-6, outputCostPerToken: 8e-6, cacheWriteCostPerToken: 2e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1-mini': { inputCostPerToken: 0.4e-6, outputCostPerToken: 1.6e-6, cacheWriteCostPerToken: 0.4e-6, cacheReadCostPerToken: 0.1e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1-nano': { inputCostPerToken: 0.1e-6, outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.1e-6, cacheReadCostPerToken: 0.025e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o3': { inputCostPerToken: 2e-6, outputCostPerToken: 8e-6, cacheWriteCostPerToken: 2e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o4-mini': { inputCostPerToken: 1.1e-6, outputCostPerToken: 4.4e-6, cacheWriteCostPerToken: 1.1e-6, cacheReadCostPerToken: 0.275e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'codex-mini-latest': { inputCostPerToken: 1.5e-6, outputCostPerToken: 6e-6, cacheWriteCostPerToken: 1.5e-6, cacheReadCostPerToken: 0.375e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'codex-mini': { inputCostPerToken: 1.5e-6, outputCostPerToken: 6e-6, cacheWriteCostPerToken: 1.5e-6, cacheReadCostPerToken: 0.375e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.1-codex': { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.125e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.1-codex-mini': { inputCostPerToken: 0.25e-6, outputCostPerToken: 2e-6, cacheWriteCostPerToken: 0.25e-6, cacheReadCostPerToken: 0.025e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.2-codex': { inputCostPerToken: 1.75e-6, outputCostPerToken: 14e-6, cacheWriteCostPerToken: 1.75e-6, cacheReadCostPerToken: 0.175e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'MiniMax-M2.7-highspeed': { inputCostPerToken: 0.6e-6, outputCostPerToken: 2.4e-6, cacheWriteCostPerToken: 0.375e-6, cacheReadCostPerToken: 0.06e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'MiniMax-M2.7': { inputCostPerToken: 0.3e-6, outputCostPerToken: 1.2e-6, cacheWriteCostPerToken: 0.375e-6, cacheReadCostPerToken: 0.06e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
}
Object.assign(FALLBACK_PRICING, verifiedPricing.models)

let pricingCache: Map<string, ModelCosts> | null = null
let _pricingWarnings: string[] = []
let _pricingLastUpdated: number | null = null

const STALENESS_WARN_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

/** Return warnings about pricing data quality (staleness, fallback usage). */
export function getPricingWarnings(): string[] {
  return _pricingWarnings
}

/** Timestamp when pricing was last successfully fetched/loaded from cache. */
export function getPricingLastUpdated(): number | null {
  return _pricingLastUpdated
}

export function getPricingMetadata() {
  return { basis: 'latest-rates' as const, currency: 'USD', refreshedAt: _pricingLastUpdated ? new Date(_pricingLastUpdated).toISOString() : null,
    fallbackVerifiedOn: verifiedPricing.verifiedOn, sources: OFFICIAL_PRICING_SOURCES,
    note: 'Historical and current usage are valued at the latest available API list rates. This is an API-equivalent estimate, not a reconstruction of past invoices.' }
}

function getCachePath(): string {
  return join(getCacheDir(), 'litellm-pricing.json')
}

function getLastKnownGoodPath(): string {
  return join(getCacheDir(), 'pricing-cache.json')
}

export function parseLiteLLMEntry(entry: LiteLLMEntry): ModelCosts | null {
  if (entry.input_cost_per_token === undefined || entry.output_cost_per_token === undefined) return null
  if ([entry.input_cost_per_token, entry.output_cost_per_token].some(v => !Number.isFinite(v) || v < 0)) return null
  const costs: ModelCosts = {
    inputCostPerToken: entry.input_cost_per_token,
    outputCostPerToken: entry.output_cost_per_token,
    cacheWriteCostPerToken: entry.cache_creation_input_token_cost ?? (entry.litellm_provider === 'anthropic' ? entry.input_cost_per_token * 1.25 : entry.input_cost_per_token),
    cacheWrite1hCostPerToken: entry.cache_creation_input_token_cost_above_1hr,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? entry.input_cost_per_token,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
    source: entry.source,
  }
  if (entry.input_cost_per_token_above_272k_tokens !== undefined) costs.contextTiers = [{
    minPromptTokens: LONG_CONTEXT_1M_THRESHOLD_TOKENS,
    inputCostPerToken: entry.input_cost_per_token_above_272k_tokens,
    outputCostPerToken: entry.output_cost_per_token_above_272k_tokens,
    cacheWriteCostPerToken: entry.cache_creation_input_token_cost_above_272k_tokens,
    cacheReadCostPerToken: entry.cache_read_input_token_cost_above_272k_tokens,
  }]
  return costs
}

async function fetchAndCachePricing(): Promise<Map<string, ModelCosts>> {
  const [feed, official] = await Promise.allSettled([
    fetch(LITELLM_URL, { signal: AbortSignal.timeout(8_000) }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as Record<string, LiteLLMEntry>
    }),
    fetchOfficialPricing(),
  ])
  const data = feed.status === 'fulfilled' ? feed.value : {}
  if (feed.status === 'rejected') _pricingWarnings.push('Could not refresh the supplemental model pricing feed.')
  const pricing = new Map<string, ModelCosts>()
  const preferredStripped = new Map<string, ModelCosts>()

  for (const [name, entry] of Object.entries(data)) {
    const costs = parseLiteLLMEntry(entry)
    if (!costs) continue
    pricing.set(name, costs)
    const stripped = name.replace(/^[^/]+\//, '')
    if (stripped === name) continue
    const isDirectProvider = DIRECT_PROVIDER_PREFIXES.some(prefix => name.toLowerCase().startsWith(prefix))
    if (isDirectProvider && !preferredStripped.has(stripped)) preferredStripped.set(stripped, costs)
  }

  for (const [name, costs] of preferredStripped) {
    if (!pricing.has(name)) pricing.set(name, costs)
  }
  // Unqualified model names use their vendor's rates. An arbitrary reseller
  // must never win just because its row happens to appear first in the feed.
  if (official.status === 'fulfilled') {
    _pricingWarnings.push(...official.value.warnings)
    for (const [name, costs] of official.value.models) pricing.set(name, costs)
  }
  if (!pricing.size) throw new Error('No pricing sources available')

  await mkdir(getCacheDir(), { recursive: true })
  const finalPath = getCachePath()
  const tmpPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tmpPath, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify({
      schemaVersion: PRICING_CACHE_SCHEMA,
      timestamp: Date.now(),
      data: Object.fromEntries(pricing),
      warnings: _pricingWarnings,
    }), { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmpPath, finalPath)
  } catch (err) {
    try { await unlink(tmpPath) } catch { /* ignore */ }
    throw err
  }

  // Also write last-known-good cache (survives TTL expiry for offline users)
  try {
    const lkgPath = getLastKnownGoodPath()
    const lkgTmp = `${lkgPath}.${randomBytes(8).toString('hex')}.tmp`
    const lkgHandle = await open(lkgTmp, 'w', 0o600)
    try {
      await lkgHandle.writeFile(JSON.stringify({
        schemaVersion: PRICING_CACHE_SCHEMA,
        timestamp: Date.now(),
        data: Object.fromEntries(pricing),
        warnings: _pricingWarnings,
      }), { encoding: 'utf-8' })
      await lkgHandle.sync()
    } finally {
      await lkgHandle.close()
    }
    await rename(lkgTmp, lkgPath).catch(() => { try { unlink(lkgTmp) } catch { /* ignore */ } })
  } catch { /* last-known-good write is best-effort */ }

  return pricing
}

async function loadCachedPricing(): Promise<{ map: Map<string, ModelCosts>; timestamp: number } | null> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cached = JSON.parse(raw) as { schemaVersion?: number; timestamp: number; data: Record<string, ModelCosts>; warnings?: string[] }
    if (cached.schemaVersion !== PRICING_CACHE_SCHEMA) return null
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
    _pricingWarnings.push(...(cached.warnings ?? []))
    return { map: new Map(Object.entries(cached.data)), timestamp: cached.timestamp }
  } catch {
    return null
  }
}

/** Load last-known-good pricing (no TTL — used when fetch fails and normal cache expired). */
async function loadLastKnownGoodPricing(): Promise<{ map: Map<string, ModelCosts>; timestamp: number } | null> {
  try {
    const raw = await readFile(getLastKnownGoodPath(), 'utf-8')
    const cached = JSON.parse(raw) as { schemaVersion?: number; timestamp: number; data: Record<string, ModelCosts>; warnings?: string[] }
    if (cached.schemaVersion !== PRICING_CACHE_SCHEMA) return null
    _pricingWarnings.push(...(cached.warnings ?? []))
    return { map: new Map(Object.entries(cached.data)), timestamp: cached.timestamp }
  } catch {
    return null
  }
}

export async function loadPricing(): Promise<void> {
  _pricingWarnings = []

  const cached = await loadCachedPricing()
  if (cached) {
    pricingCache = cached.map
    _pricingLastUpdated = cached.timestamp
    return
  }

  try {
    pricingCache = await fetchAndCachePricing()
    _pricingLastUpdated = Date.now()
  } catch {
    // Try last-known-good cache before falling back to hardcoded pricing
    const lkg = await loadLastKnownGoodPricing()
    if (lkg) {
      pricingCache = lkg.map
      _pricingLastUpdated = lkg.timestamp
      const ageDays = Math.floor((Date.now() - lkg.timestamp) / (24 * 60 * 60 * 1000))
      if (Date.now() - lkg.timestamp > STALENESS_WARN_MS) {
        _pricingWarnings.push(`Model pricing data may be outdated (last updated ${ageDays} days ago)`)
      }
    } else {
      pricingCache = new Map(Object.entries(FALLBACK_PRICING))
      _pricingLastUpdated = null
      _pricingWarnings.push('Using hardcoded fallback pricing — could not fetch or load cached pricing')
    }
  }
}

// Known model name variants that providers emit but LiteLLM/fallback don't index under.
// OMP emits 'anthropic--claude-4.6-opus' (double-dash, dot version, tier-last).
// getCanonicalName strips any 'provider/' prefix first, so only the post-strip
// forms need to be listed here.
const BUILTIN_ALIASES: Record<string, string> = {
  'anthropic--claude-4.8-opus':    'claude-opus-4-8',
  'anthropic--claude-4.7-opus':    'claude-opus-4-7',
  'anthropic--claude-4.6-opus':    'claude-opus-4-6',
  'anthropic--claude-4.6-sonnet':  'claude-sonnet-4-6',
  'anthropic--claude-4.5-opus':    'claude-opus-4-5',
  'anthropic--claude-4.5-sonnet':  'claude-sonnet-4-5',
  'anthropic--claude-4.5-haiku':   'claude-haiku-4-5',
}

let userAliases: Record<string, string> = {}

// Called once during CLI startup after config is loaded.
// User aliases take precedence over built-ins.
export function setModelAliases(aliases: Record<string, string>): void {
  userAliases = aliases
}

function resolveAlias(model: string): string {
  if (Object.hasOwn(userAliases, model)) return userAliases[model]!
  if (Object.hasOwn(BUILTIN_ALIASES, model)) return BUILTIN_ALIASES[model]!
  return model
}
function getCanonicalName(model: string): string {
  return model
    .replace(/@.*$/, '')       // strip pin: claude-sonnet-4-6@20250929 -> claude-sonnet-4-6
    .replace(/-\d{8}$/, '')   // strip date: claude-sonnet-4-20250514 -> claude-sonnet-4
    .replace(/^[^/]+\//, '') // strip provider prefix: anthropic/foo -> foo
}

export function getModelCosts(model: string): ModelCosts | null {
  const canonical = resolveAlias(getCanonicalName(model))
  // Spark has no published first-party token rate. Do not inherit Codex's rate.
  if (canonical === 'gpt-5.3-codex-spark' && !userAliases[canonical]) return null
  const qualified = pricingCache?.get(model)
  if (model.includes('/') && qualified) return qualified
  const exactFetched = pricingCache?.get(canonical) ?? null
  const exactFallback = Object.hasOwn(FALLBACK_PRICING, canonical) ? FALLBACK_PRICING[canonical]! : null
  const exactMatch = mergeModelCosts(exactFetched, exactFallback)
  if (exactMatch) return exactMatch

  const prefixFetched = findPrefixMatch(pricingCache ?? new Map(), canonical)
  const prefixFallback = findPrefixMatch(new Map(Object.entries(FALLBACK_PRICING)), canonical)
  return mergeModelCosts(prefixFetched, prefixFallback)
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  tierInputTokens?: number,
  cacheCreation1hTokens = 0,
): number {
  const baseCosts = getModelCosts(model)
  const costs = applyContextTier(baseCosts, tierInputTokens ?? inputTokens)
  if (!costs) {
    if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens > 0) {
      const warning = `No API pricing for model "${model}"; its tokens are counted but its cost is excluded. Configure a model alias only when the underlying API model is known.`
      if (!_pricingWarnings.includes(warning)) _pricingWarnings.push(warning)
    }
    return 0
  }

  // The aggregate cache-creation count already includes both TTLs. Charge the
  // 1h portion at 2x input, and the remainder at the model's 5m write rate.
  const oneHourTokens = Math.min(cacheCreationTokens, Math.max(0, cacheCreation1hTokens))
  const multiplier = speed === 'fast' ? costs.fastMultiplier : 1

  return multiplier * (
    inputTokens * costs.inputCostPerToken +
    outputTokens * costs.outputCostPerToken +
    (cacheCreationTokens - oneHourTokens) * costs.cacheWriteCostPerToken +
    oneHourTokens * (costs.cacheWrite1hCostPerToken ?? costs.inputCostPerToken * 2) +
    cacheReadTokens * costs.cacheReadCostPerToken
  ) + webSearchRequests * costs.webSearchCostPerRequest
}

export function getShortModelName(model: string): string {
  const canonical = resolveAlias(getCanonicalName(model))
  const shortNames: Record<string, string> = {
    'gpt-6-astra': 'GPT-6 Astra',
    'gpt-6.1-sol': 'GPT-6.1 Sol',
    'gpt-6-sol': 'GPT-6 Sol',
    'gpt-6-luna': 'GPT-6 Luna',
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.6-terra': 'GPT-5.6 Terra',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'claude-sonnet-5-5': 'Sonnet 5.5',
    'claude-fable-5-1': 'Fable 5.1',
    'claude-opus-5-5': 'Opus 5.5',
    'claude-opus-5': 'Opus 5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-fable-5': 'Fable 5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-5': 'Opus 4.5',
    'claude-opus-4-1': 'Opus 4.1',
    'claude-opus-4': 'Opus 4',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-sonnet-4-5': 'Sonnet 4.5',
    'claude-sonnet-4': 'Sonnet 4',
    'claude-3-7-sonnet': 'Sonnet 3.7',
    'claude-3-5-sonnet': 'Sonnet 3.5',
    'claude-haiku-4-5': 'Haiku 4.5',
    'claude-3-5-haiku': 'Haiku 3.5',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4o': 'GPT-4o',
    'gpt-4.1-nano': 'GPT-4.1 Nano',
    'gpt-4.1-mini': 'GPT-4.1 Mini',
    'gpt-4.1': 'GPT-4.1',
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.5-pro': 'GPT-5.5 Pro',
    'gpt-5.4-pro': 'GPT-5.4 Pro',
    'gpt-5.4-nano': 'GPT-5.4 Nano',
    'gpt-5.4-mini': 'GPT-5.4 Mini',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
    'gpt-5.3-codex': 'GPT-5.3 Codex',
    'gpt-5.2': 'GPT-5.2',
    'gpt-5.1': 'GPT-5.1',
    'gpt-5-codex': 'GPT-5-Codex',
    'gpt-5-nano': 'GPT-5 Nano',
    'gpt-5-mini': 'GPT-5 Mini',
    'gpt-5': 'GPT-5',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'o4-mini': 'o4-mini',
    'o3': 'o3',
    'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
    'MiniMax-M2.7': 'MiniMax M2.7',
  }
  if (Object.hasOwn(shortNames, canonical)) return shortNames[canonical]!
  for (const [key, name] of Object.entries(shortNames).sort((a, b) => b[0].length - a[0].length)) {
    if (canonical.startsWith(key + '-') && /^\d{4}-?\d{2}-?\d{2}$/.test(canonical.slice(key.length + 1))) return name
  }
  return canonical
}

function mergeModelCosts(primary: ModelCosts | null | undefined, fallback: ModelCosts | null | undefined): ModelCosts | null {
  if (!primary && !fallback) return null
  if (!primary) return fallback ?? null
  if (!fallback) return primary
  if (Object.values(OFFICIAL_PRICING_SOURCES).includes(primary.source as never)) return primary
  return {
    ...fallback,
    ...primary,
    contextTiers: primary.contextTiers ?? fallback.contextTiers,
  }
}

function findPrefixMatch(entries: Map<string, ModelCosts>, canonical: string): ModelCosts | null {
  // Only version/date pins may inherit a base model price. Variant models need
  // their own entry (e.g. Spark, Mini, Pro, free, highspeed).
  const matches = [...entries].filter(([key]) => canonical.startsWith(key + '-') && /^\d{4}-?\d{2}-?\d{2}$/.test(canonical.slice(key.length + 1)))
    .sort(([a], [b]) => b.length - a.length)
  if (matches.length) return matches[0]![1]
  return null
}

function applyContextTier(costs: ModelCosts | null, inputTokens: number): ModelCosts | null {
  if (!costs || !costs.contextTiers || costs.contextTiers.length === 0) return costs
  const tier = costs.contextTiers
    .filter(candidate => inputTokens > candidate.minPromptTokens)
    .sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0]
  if (!tier) return costs
  return {
    ...costs,
    inputCostPerToken: tier.inputCostPerToken ?? costs.inputCostPerToken,
    outputCostPerToken: tier.outputCostPerToken ?? costs.outputCostPerToken,
    cacheWriteCostPerToken: tier.cacheWriteCostPerToken ?? costs.cacheWriteCostPerToken,
    cacheReadCostPerToken: tier.cacheReadCostPerToken ?? costs.cacheReadCostPerToken,
  }
}

let fingerprintPricing: Map<string, ModelCosts> | null | undefined
let fingerprintAliases: typeof userAliases
let fingerprintValue = ''
/** Parsed result caches must not survive pricing or alias changes. */
export function getPricingFingerprint(): string {
  if (!fingerprintValue || fingerprintPricing !== pricingCache || fingerprintAliases !== userAliases) {
    fingerprintPricing = pricingCache
    fingerprintAliases = userAliases
    fingerprintValue = createHash('sha256').update(JSON.stringify([Array.from(pricingCache ?? []), FALLBACK_PRICING, userAliases])).digest('hex').slice(0, 16)
  }
  return fingerprintValue
}
