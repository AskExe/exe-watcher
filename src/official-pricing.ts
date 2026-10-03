import type { ModelCosts } from './models.js'

export const OFFICIAL_PRICING_SOURCES = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  minimax: 'https://platform.minimax.io/docs/guides/pricing-paygo',
  zai: 'https://docs.z.ai/guides/overview/pricing',
  moonshot: 'https://platform.kimi.ai/docs/pricing/chat',
  xai: 'https://docs.x.ai/developers/pricing',
} as const
export type PricingVendor = keyof typeof OFFICIAL_PRICING_SOURCES

// Parse provider-published data as text only. Never evaluate MDX or page scripts.
function rows(text: string): string[][] {
  return text.split('\n').filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().slice(1, -1).split('|').map(cell => cell.trim()))
}
function price(text = ''): number | undefined {
  const clean = text.replace(/~~.*?~~/g, '')
  const match = clean.match(/\$([\d.]+)/)
  if (match) return Number(`${match[1]}e-6`)
  if (/^(?:-|Free|Limited-time Free)$/i.test(clean.trim())) return 0
  return undefined
}
function costs(input: number, output: number, read: number, write: number, source: string): ModelCosts {
  return { inputCostPerToken: input, outputCostPerToken: output, cacheReadCostPerToken: read,
    cacheWriteCostPerToken: write, webSearchCostPerRequest: 0.01, fastMultiplier: 1, source }
}

export function parseOfficialPricing(vendor: PricingVendor, text: string): Map<string, ModelCosts> {
  const result = new Map<string, ModelCosts>()
  const source = OFFICIAL_PRICING_SOURCES[vendor]
  if (vendor === 'openai') {
    // The first table is Standard. Batch/Flex/Fast tables must never overwrite it.
    const standard = text.split('### Standard pricing data')[1]?.split('### Batch pricing data')[0] ?? ''
    for (const row of rows(standard)) {
      const name = row[0]?.match(/^[a-z][a-z\d.-]*/)?.[0]
      const p = row.slice(1).map(price)
      if (!name || p.length !== 8 || p[0] === undefined || p[3] === undefined) continue
      const model = costs(p[0], p[3], p[1] ?? 0, p[2] ?? 0, source)
      if (p[4] && p[7]) model.contextTiers = [{ minPromptTokens: 272_000,
        inputCostPerToken: p[4], cacheReadCostPerToken: p[5] ?? 0,
        cacheWriteCostPerToken: p[6] ?? 0, outputCostPerToken: p[7] }]
      result.set(name, model)
    }
    const fast = text.split('### Fast pricing data')[1]?.split('### Ultrafast pricing data')[0] ?? ''
    for (const row of rows(fast)) {
      const name = row[0]?.match(/^[a-z][a-z\d.-]*/)?.[0]
      const model = name ? result.get(name) : null
      const input = price(row[1])
      if (model && input && model.inputCostPerToken) model.fastMultiplier = input / model.inputCostPerToken
    }
  } else if (vendor === 'anthropic') {
    const catalog = text.split('## Model pricing')[1]?.split('## Cloud platform pricing')[0] ?? ''
    const modelNames = (cell: string) => [...cell.matchAll(/Claude (Fable|Mythos|Opus|Sonnet|Haiku) (\d+(?:\.\d+)?)/g)]
      .map(m => m[1] === 'Haiku' && m[2] === '3.5' ? 'claude-3-5-haiku' : `claude-${m[1]!.toLowerCase()}-${m[2]!.replace('.', '-')}`)
    for (const row of rows(catalog)) {
      const name = modelNames(row[0] ?? '')[0], p = row.slice(1).map(price)
      if (!name || p.length !== 5 || p.some(v => v === undefined)) continue
      result.set(name, { ...costs(p[0]!, p[4]!, p[3]!, p[1]!, source), cacheWrite1hCostPerToken: p[2]! })
    }
    const fast = text.split('### Fast mode pricing')[1]?.split('### Batch processing')[0] ?? ''
    for (const row of rows(fast)) for (const name of modelNames(row[0] ?? '')) {
      const model = result.get(name), input = price(row[1])
      if (model && input) model.fastMultiplier = input / model.inputCostPerToken
    }
  } else if (vendor === 'minimax') {
    // M2 has explicit write rates; M3's automatic cache has no separate write fee.
    const standard = text.split('<Tab title="Priority')[0] + (text.split('</Tabs>')[1]?.split('## Audio')[0] ?? '')
    for (const row of rows(standard)) {
      const name = row[0]?.match(/MiniMax-M[\d.]+(?:-highspeed)?/)?.[0], p = row.slice(1).map(price)
      if (!name || p[0] === undefined || p[1] === undefined || p[2] === undefined) continue
      const model = costs(p[0], p[1], p[2], p[3] ?? 0, source)
      const existing = result.get(name)
      if (existing && /512k.*tokens/i.test(row[0] ?? '')) {
        existing.contextTiers = [{ minPromptTokens: 512_000, inputCostPerToken: p[0], outputCostPerToken: p[1], cacheReadCostPerToken: p[2] }]
      } else result.set(name, model)
    }
  } else if (vendor === 'zai') {
    for (const row of rows(text.split('### Built-in Tools')[0] ?? '')) {
      const name = row[0]?.toLowerCase(), p = row.slice(1).map(price)
      if (!name?.startsWith('glm-') || p[0] === undefined || p[3] === undefined) continue
      result.set(name, costs(p[0], p[3], p[1] ?? 0, p[2] ?? 0, source))
    }
  } else if (vendor === 'moonshot') {
    // Published MDX rows contain JSX money literals, not Markdown table cells.
    for (const line of text.split('\n')) {
      const name = line.match(/^\["(kimi-[^"]+)"/)?.[1]
      const p = [...line.matchAll(/\{"\$"\}([\d.]+)/g)].map(m => Number(`${m[1]}e-6`))
      if (!name) continue
      if (p.length === 5) result.set(name, { ...costs(p[3]!, p[4]!, p[2]!, p[0]!, source), cacheWrite1hCostPerToken: p[1]! })
      if (p.length === 3) result.set(name, costs(p[1]!, p[2]!, p[0]!, p[1]!, source))
    }
  } else if (vendor === 'xai') {
    for (const row of rows(text.split('### Imagine Pricing')[0] ?? '')) {
      const name = row[0]?.match(/^(grok-[\w.-]+)/)?.[1], p = row.slice(2).map(price)
      if (!name || p.length !== 3 || p.some(v => v === undefined)) continue
      const existing = result.get(name)
      if (existing && /≥/.test(row[0] ?? '')) {
        existing.contextTiers = [{ minPromptTokens: 199_999, inputCostPerToken: p[0], cacheReadCostPerToken: p[1], cacheWriteCostPerToken: p[0], outputCostPerToken: p[2] }]
      } else result.set(name, { ...costs(p[0]!, p[2]!, p[1]!, p[0]!, source), webSearchCostPerRequest: 0.005 })
    }
  }
  return result
}

export async function fetchOfficialPricing(): Promise<{ models: Map<string, ModelCosts>; warnings: string[] }> {
  const models = new Map<string, ModelCosts>(), warnings: string[] = []
  const vendors = Object.keys(OFFICIAL_PRICING_SOURCES) as PricingVendor[]
  const results = await Promise.allSettled(vendors.map(async vendor => {
    const response = await fetch(OFFICIAL_PRICING_SOURCES[vendor] + '.md', { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 2_000_000) throw new Error('pricing page exceeds size limit')
    const parsed = parseOfficialPricing(vendor, text)
    if (!parsed.size) throw new Error('pricing table was not recognized')
    return parsed
  }))
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    if (result.status === 'fulfilled') for (const [name, row] of result.value) models.set(name, row)
    else warnings.push(`Could not refresh official ${vendors[i]} pricing; using the pricing feed or last verified rates.`)
  }
  return { models, warnings }
}
