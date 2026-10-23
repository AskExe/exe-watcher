import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTelemetry, resolveTelemetry, safeError, COLLECTOR } from '../src/telemetry.js'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'watcher-telemetry-'))
  vi.stubEnv('XDG_CONFIG_HOME', root); vi.stubEnv('EXE_WATCHER_PARENT_PID', '')
  vi.stubEnv('EXE_WATCHER_TELEMETRY', ''); vi.stubEnv('DO_NOT_TRACK', '')
  const { mkdir } = await import('node:fs/promises'); const path = join(root, 'exe-watcher')
  await mkdir(path)
  const consent = { usageEnabled: true, diagnosticsEnabled: true }
  await writeFile(join(path, 'config.json'), JSON.stringify({ telemetry: consent }))
  return { root, path, consent }
}
describe('self-hosted telemetry', () => {
  it('defaults basic usage on, preserves opt-outs, and keeps diagnostics off', () => {
    expect(resolveTelemetry({}, {})).toEqual({ usageEnabled: true, diagnosticsEnabled: false })
    expect(resolveTelemetry({ usageEnabled: false }, {})).toEqual({ usageEnabled: false, diagnosticsEnabled: false })
    expect(resolveTelemetry({ enabled: false, diagnosticsEnabled: true }, {})).toEqual({ usageEnabled: false, diagnosticsEnabled: false })
    expect(resolveTelemetry({ usageEnabled: 'invalid' } as any, {}).usageEnabled).toBe(false)
    expect(resolveTelemetry({ usageEnabled: true }, {})).toEqual({ usageEnabled: true, diagnosticsEnabled: false })
    for (const env of [{ DO_NOT_TRACK: '1' }, { EXE_WATCHER_TELEMETRY: '0' }, { EXE_WATCHER_PARENT_PID: '123' }])
      expect(resolveTelemetry({ usageEnabled: true, diagnosticsEnabled: true }, env)).toEqual({ usageEnabled: false, diagnosticsEnabled: false })
  })
  it('sends nothing before first-run disclosure, and defaults only usage on afterward', async () => {
    const f = await fixture(); const send = vi.fn(async () => new Response('')); vi.stubGlobal('fetch', send)
    try {
      await writeFile(join(f.path, 'config.json'), '{}')
      const undisclosed = await createTelemetry(undefined, '0.2.67', true)
      await undisclosed.capture('command_started', 'status'); await undisclosed.shutdown()
      expect(send).not.toHaveBeenCalled()
      const disclosed = { basicNoticeVersion: 1 }
      await writeFile(join(f.path, 'config.json'), JSON.stringify({ telemetry: disclosed }))
      const current = await createTelemetry(disclosed, '0.2.67', true)
      await current.capture('command_started', 'status'); await current.error(new Error('secret')); await current.shutdown()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]![0]).toBe(COLLECTOR + '/batch/')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('adds only numeric version/coarse platform and fixed command outcomes', async () => {
    const f = await fixture(); const requests: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response('') }))
    try {
      const client = await createTelemetry(f.consent, '0.2.67', true)
      await client.capture('command_started', 'status'); await client.capture('command_finished', 'status', true)
      await client.capture('command_started', 'export'); await client.capture('command_finished', 'export', false)
      await client.shutdown()
      const rows = requests[0].batch
      expect(rows.filter((r: any) => r.event === 'app_result').map((r: any) => r.properties.outcome)).toEqual(['success', 'failure'])
      for (const row of rows) {
        expect(row.properties.app_version).toBe('0.2.67')
        expect(['macos', 'windows', 'linux']).toContain(row.properties.app_platform)
      }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('never sends raw error text, paths, stack or unknown classes', () => {
    const error = new Error('secret /Users/private/project'); error.name = 'PrivateProjectError'
    expect(safeError(error, '0.2.67')).toEqual({ event: 'error', category: 'unhandled_exception', error_class: 'Error', version: '0.2.67', frames: [] })
  })
  it('retries persisted UUIDs, reconstructs payloads, and clears queues after acknowledgement', async () => {
    const f = await fixture(); const requests: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => { requests.push({ url, ...JSON.parse(options.body) }); return new Response('', { status: requests.length <= 2 ? 503 : 200 }) }))
    try {
      const telemetry = await createTelemetry(f.consent, '0.2.67', true)
      await telemetry.capture('command_started', 'status'); await telemetry.error(new Error('secret'))
      await telemetry.shutdown()
      const mode = (await stat(join(f.path, 'telemetry-cli'))).mode & 0o777
      expect(mode).toBe(0o700)
      const next = await createTelemetry(f.consent, '0.2.67', true); await next.shutdown()
      expect(requests[0].batch[0].uuid).toBe(requests[2].batch[0].uuid)
      expect(requests[1].batch[0].uuid).toBe(requests[3].batch[0].uuid)
      expect(requests[0].url).toBe(COLLECTOR + '/batch/')
      expect(JSON.stringify(requests)).not.toMatch(/secret|Users|stack/)
      expect(JSON.parse(await readFile(join(f.path, 'telemetry-cli/state.json'), 'utf8')).usage).toEqual([])
      expect(JSON.parse(await readFile(join(f.path, 'telemetry-cli/state.json'), 'utf8')).diagnostics).toEqual([])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('revokes independently before sending and clears unsent data', async () => {
    const f = await fixture(); const send = vi.fn(async () => new Response('')); vi.stubGlobal('fetch', send)
    try {
      const telemetry = await createTelemetry(f.consent, '0.2.67', true)
      await telemetry.capture('command_started', 'status'); await telemetry.error(new Error('secret'))
      await writeFile(join(f.path, 'config.json'), JSON.stringify({ telemetry: { usageEnabled: false, diagnosticsEnabled: true } }))
      await telemetry.shutdown()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]![0]).toBe(COLLECTOR + '/errors/')
      expect(JSON.parse(await readFile(join(f.path, 'telemetry-cli/state.json'), 'utf8')).usage).toEqual([])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('discards a closed process queue after consent was revoked and re-enabled elsewhere', async () => {
    const f = await fixture(); const requests: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response('', { status: 503 }) }))
    try {
      const first = await createTelemetry(f.consent, '0.2.67', true)
      await first.capture('command_started', 'status'); await first.error(new Error('secret')); await first.shutdown()
      const newer = { ...f.consent, usageEpoch: 'new-usage-consent', diagnosticsEpoch: 'new-error-consent' }
      await writeFile(join(f.path, 'config.json'), JSON.stringify({ telemetry: newer }))
      requests.length = 0
      const next = await createTelemetry(newer, '0.2.67', true); await next.shutdown()
      expect(requests).toEqual([])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('excludes non-foreground invocations and respects the queue bound', async () => {
    const f = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    try {
      const background = await createTelemetry(f.consent, '0.2.67', false)
      await background.capture('command_started', 'status'); await background.shutdown()
      expect(fetch).not.toHaveBeenCalled()
      const foreground = await createTelemetry(f.consent, '0.2.67', true)
      for (let i = 0; i < 510; i++) await foreground.error(new Error('secret'))
      const content = await readFile(join(f.path, 'telemetry-cli/state.json'), 'utf8')
      expect(JSON.parse(content).diagnostics.length).toBe(500)
      await foreground.shutdown()
      expect(content).not.toContain('secret')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})
