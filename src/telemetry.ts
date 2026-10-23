import { PrivacyClient, DEFAULT_COLLECTOR, sanitizeDiagnostic } from '@odd-core/analytics/privacy'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfigFilePath, type TelemetryConfig } from './config.js'
import { acquireFileLock } from './file-lock.js'

export const COLLECTOR = DEFAULT_COLLECTOR
export const ALIAS = 'public-watcher-cli-v1'
export const BASIC_NOTICE = 'Watcher shares basic app activity (daily activity, foreground time, feature outcomes, app version and platform) with Odd’s own servers. A random installation ID measures returning installations. Your content stays private. Turn off anytime: exe-watcher telemetry --usage off. Details: https://github.com/AskExe/exe-watcher#optional-analytics-and-error-reporting'
export const FEATURES = new Set(['status', 'report', 'optimize', 'compare', 'export', 'menubar', 'plan', 'currency', 'agent-status'])
export function resolveTelemetry(config: TelemetryConfig = {}, env = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { usageEnabled: false, diagnosticsEnabled: false }
  const disabled = config.enabled === false || env['EXE_WATCHER_TELEMETRY'] === '0' || env['DO_NOT_TRACK'] === '1' || Boolean(env['EXE_WATCHER_PARENT_PID'])
  return { usageEnabled: !disabled && (config.usageEnabled === undefined || config.usageEnabled === true), diagnosticsEnabled: !disabled && config.diagnosticsEnabled === true }
}
export function safeError(error: unknown, version = '0.0.0') {
  return sanitizeDiagnostic({ event: 'error', category: 'unhandled_exception', error_class: error instanceof Error ? error.name : 'Error', version, frames: [] }, [])!
}
const silent = () => ({ async capture(_event: string, _command: string, _success = true) {}, async error(_error: unknown) {}, async shutdown() {}, abort() {} })

/** One owner per persistent shared-client store. Busy telemetry never delays accounting. */
export async function createTelemetry(config: TelemetryConfig | undefined, version: string, foreground = Boolean(process.stdin.isTTY)) {
  if (process.env['EXE_WATCHER_PARENT_PID']) return silent()
  const initial = resolveTelemetry(config)
  // The product presents its first-run notice before applying a default-on choice.
  if (initial.usageEnabled && config?.usageEnabled === undefined && config?.basicNoticeVersion !== 1 && config?.diagnosticsEnabled !== true) return silent()
  const root = dirname(getConfigFilePath()), directory = join(root, 'telemetry-cli'), file = join(directory, 'state.json')
  if (!initial.usageEnabled && !initial.diagnosticsEnabled) {
    try { await readFile(file) } catch { return silent() }
  }
  let release: (() => Promise<void>) | undefined
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700)
    release = await acquireFileLock(join(directory, 'owner.lock'), 0)
    let firstId = false
    let installation: string | undefined
    // Share a pseudonymous installation with the Swift surface, not queue ownership.
    if (initial.usageEnabled) {
      const path = join(root, 'telemetry-id')
      try { await writeFile(path, randomUUID(), { flag: 'wx', mode: 0o600 }) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const candidate = (await readFile(path, 'utf8')).trim()
      if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(candidate)) installation = candidate
    } else if (config?.usageEnabled !== true) await unlink(join(root, 'telemetry-id')).catch(() => {})
    const client = await PrivacyClient.create({ app: 'watcher', usageAlias: ALIAS, diagnosticsAlias: ALIAS,
      appVersion: /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : '0.0.0',
      platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : undefined,
      features: [...FEATURES].map(name => `cli_${name.replaceAll('-', '_')}`), frames: [],
      randomUUID: () => { if (firstId) { firstId = false; return installation ?? randomUUID() }; return randomUUID() },
      storage: {
        async getItem() { try { const data = await readFile(file, 'utf8'); return data.length <= 524288 ? data : null } catch { return null } },
        async setItem(_key, value) {
          const temp = `${file}.${randomUUID()}.tmp`
          try { await writeFile(temp, value, { mode: 0o600, flag: 'wx' }); await rename(temp, file) }
          finally { await unlink(temp).catch(() => {}) }
        },
      },
      send: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options!.signal!, AbortSignal.timeout(1500)]) }),
    })
    // Existing client IDs remain stable; the first newly generated UUID is identity only
    // when consent transitions on. Event UUIDs must never reuse the installation ID.
    const epochs = { usage: config?.usageEpoch ?? 'initial', diagnostics: config?.diagnosticsEpoch ?? 'initial' }
    let prior: Record<string, string> = {}
    try { prior = JSON.parse(await readFile(join(directory, 'consent.json'), 'utf8')) } catch {}
    if (prior.usage !== epochs.usage) await client.setConsent({ usage: false })
    if (prior.diagnostics !== epochs.diagnostics) await client.setConsent({ diagnostics: false })
    firstId = initial.usageEnabled && !client.status().usage
    await client.setConsent({ usage: initial.usageEnabled, diagnostics: initial.diagnosticsEnabled })
    firstId = false
    const epochTemp = join(directory, `${randomUUID()}.tmp`)
    try { await writeFile(epochTemp, JSON.stringify(epochs), { mode: 0o600, flag: 'wx' }); await rename(epochTemp, join(directory, 'consent.json')) }
    finally { await unlink(epochTemp).catch(() => {}) }
    const syncConsent = async () => {
      let current = { usageEnabled: false, diagnosticsEnabled: false }
      let saved: TelemetryConfig = {}
      try { saved = JSON.parse(await readFile(getConfigFilePath(), 'utf8')).telemetry ?? {}; current = resolveTelemetry(saved) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = resolveTelemetry(undefined)
      }
      if ((saved.usageEpoch ?? 'initial') !== epochs.usage) current.usageEnabled = false
      if ((saved.diagnosticsEpoch ?? 'initial') !== epochs.diagnostics) current.diagnosticsEnabled = false
      const status = client.status()
      const usage = initial.usageEnabled && current.usageEnabled, diagnostics = initial.diagnosticsEnabled && current.diagnosticsEnabled
      if (status.usage !== usage || status.diagnostics !== diagnostics) await client.setConsent({ usage, diagnostics })
    }
    let marked = false, stopped = false
    return {
      async capture(event: string, command: string, success = true) {
        try {
          await syncConsent()
          if (!foreground || !FEATURES.has(command)) return
          const feature = `cli_${command.replaceAll('-', '_')}`
          if (event === 'command_started') {
            if (!marked) { await client.track({ event: 'active' }); marked = true }
            await client.track({ event: 'feature', feature })
          } else if (event === 'command_finished' && marked) {
            await client.track({ event: 'result', feature, outcome: success ? 'success' : 'failure' })
          }
        } catch {}
      },
      async error(error: unknown) { try { await syncConsent(); await client.report(safeError(error, version)) } catch {} },
      async shutdown() {
        if (stopped) return
        stopped = true
        const revocation = setInterval(() => { void syncConsent().catch(() => {}) }, 100)
        try { await syncConsent(); await client.flush() }
        finally { clearInterval(revocation); client.abort(); await release?.() }
      },
      abort() { client.abort() },
    }
  } catch { await release?.().catch(() => {}); return silent() }
}
