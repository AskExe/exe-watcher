/** Owned, disposable hosted qualification. Never uses the review account's real vault/history. */
import { createClient, type Session } from '@supabase/supabase-js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { WatcherAccount } from '../src/cloud/account.js'
import { CloudLocalState } from '../src/cloud/local-state.js'
import { saveDailyCache } from '../src/daily-cache.js'
import deployment from '../src/cloud/deployment.json'
import type { BackupPointer } from '@odd-core/recovery/backup'

const run = promisify(execFile)
const ref = 'vjiexzktmduoguxvleiy'
const checks: string[] = [], cleanupFailures: string[] = [], owners: string[] = []
const requestFailures: Array<{ route: string; status: number; code?: string; hints?: string[] }> = []
let failureClass: string | undefined
let phase = 'preflight', directory = ''
function check(condition: unknown, name: string): asserts condition {
  phase = name
  if (!condition) throw new Error('Hosted qualification failed')
  checks.push(name)
}
const boundedFetch: typeof fetch = async (input, init) => {
  try {
    const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    if (!response.ok && requestFailures.length < 30) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const route = url.pathname.startsWith('/storage/v1/') ? 'storage' :
        url.pathname.startsWith('/rest/v1/rpc/') ? 'rpc' :
        url.pathname.startsWith('/auth/v1/') ? 'auth' : 'other'
      let code: string | undefined
      let hints: string[] = []
      try {
        const body = await response.clone().json()
        if (typeof body.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(body.code)) code = body.code
        const text = JSON.stringify(body).toLowerCase()
        hints = ['permission denied', 'insufficient privilege', 'schema', 'function', 'column',
          'syntax', 'deadlock', 'duplicate', 'row-level security', 'trigger', 'read-only',
          'watcher_private', 'auth', 'storage', '42501', '42703', '42883', '23505'].filter(x => text.includes(x))
      } catch {}
      requestFailures.push({ route, status: response.status, ...(code ? { code } : {}), hints })
    }
    return response
  }
  catch { return Response.json({ message: 'QA network unavailable' }, { status: 408 }) }
}
async function sql(statement: string) {
  const file = join(directory, `${randomUUID()}.sql`)
  await writeFile(file, statement, { mode: 0o600 })
  const childEnv = { ...process.env }; delete childEnv.WATCHER_SERVICE_SECRET
  try {
    const result = await run(process.env.WATCHER_SUPABASE_CLI ?? 'supabase',
      ['db', 'query', '--linked', '--project-ref', ref, '--file', file, '--output', 'json'],
      { env: childEnv, timeout: 45_000, maxBuffer: 1024 * 1024 })
    return JSON.parse(result.stdout).rows as Array<Record<string, unknown>>
  } finally { await rm(file, { force: true }) }
}
async function main() {
  check(process.env.WATCHER_QA_DISPOSABLE === '1' && deployment.enabled === false &&
    deployment.authUrl === `https://${ref}.supabase.co`, 'explicit disposable fixture mode; public rollout disabled')
  const secret = process.env.WATCHER_SERVICE_SECRET
  check(secret?.startsWith('sb_secret_'), 'protected existing server key provided')
  directory = await mkdtemp(join(tmpdir(), 'watcher-hosted-qa-'))
  process.env.EXE_WATCHER_CACHE_DIR = join(directory, 'cache')
  const admin = createClient(deployment.authUrl, secret!, {
    auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: boundedFetch },
  })
  const stores: Map<string, string>[] = []
  try {
    const rows = await sql('select enabled from watcher_private.watcher_settings;')
    check(rows.length === 1 && rows[0]?.enabled === false, 'server public rollout disabled')
    const marker = randomUUID()
    async function device(email: string, name: string) {
      const values = new Map<string, string>(); stores.push(values)
      let session: Session | undefined, pauseAfterUpload = false
      const local = new CloudLocalState(join(directory, name))
      const account = new WatcherAccount({
        getItem: async key => values.get(key) ?? null,
        setItem: async (key, value) => { values.set(key, value) },
        removeItem: async key => { values.delete(key) },
      }, local, { ...deployment, enabled: true }, async (input, init) => {
        const response = await boundedFetch(input, init)
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (response.ok && /\/auth\/v1\/(verify|token)/.test(url)) {
          const value = await response.clone().json()
          if (value.access_token) session = value
        }
        if (pauseAfterUpload && response.ok && url.includes('/storage/v1/object/watcher-history/') && init?.method === 'POST') {
          pauseAfterUpload = false; await local.pause()
        }
        return response
      })
      const link = await admin.auth.admin.generateLink({ type: 'magiclink', email })
      check(!link.error && !!link.data.properties.email_otp, `${name}: genuine GoTrue OTP issued without sending mail`)
      check((await account.run({ action: 'verifyCode', email, code: link.data.properties.email_otp })).signedIn === true, `${name}: genuine hosted sign-in`)
      return { account, local, session: () => session!, interrupt: () => { pauseAfterUpload = true } }
    }
    const emails: string[] = []
    for (const label of ['a', 'b']) {
      const email = `oddcommunityreview+watcher-${label}-${marker}@gmail.com`
      const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { watcher_disposable_qa: marker } })
      check(!created.error && !!created.data.user, `fixture ${label}: new owned identity created`)
      const id = created.data.user.id
      check(/^[0-9a-f-]{36}$/.test(id), `fixture ${label}: canonical owner bound`)
      owners.push(id); emails.push(email)
    }
    await sql(`insert into watcher_private.watcher_qa_accounts(user_id,expires_at) values ${owners.map(id => `('${id}',now()+interval '2 hours')`).join(',')};`)
    const a = await device(emails[0]!, 'owner-a'), b = await device(emails[1]!, 'owner-b')
    const totals = { cost: 12, calls: 4, sessions: 2, inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 3, cacheWriteTokens: 4, editTurns: 0, oneShotTurns: 0, models: {}, categories: {} }
    await saveDailyCache({ version: 9, scopeKey: 'global', lastComputedDate: '2026-10-25', days: [{
      ...totals, date: '2026-10-25', providers: { claude: totals }, projects: {},
    }] })
    const phrase = (await a.account.run({ action: 'recoveryPhrase' })).phrase
    check(typeof phrase === 'string', 'new disposable recovery phrase generated in memory')
    check((await a.account.run({ action: 'enable', phrase, confirm: true })).backupEnabled === true, 'owner consent and recovery capsule enrolled')
    phase = 'first encrypted hosted backup'
    check((await a.account.run({ action: 'backup' })).backedUp === true, 'encrypted hosted backup and read-back')
    const deviceId = (await a.local.read()).deviceId
    const client = (session: Session) => createClient(deployment.dataUrl!, deployment.dataPublishableKey!, {
      accessToken: async () => session.access_token, auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: boundedFetch },
    })
    const own = client(a.session()), foreign = client(b.session())
    const stored = await own.from('watcher_backups').select('pointer').eq('device_id', deviceId).single()
    check(!stored.error && !!stored.data?.pointer, 'owner can read its completed pointer')
    const pointer = stored.data.pointer as BackupPointer
    const otherDevices = (await b.account.run({ action: 'devices' })).devices
    check(Array.isArray(otherDevices) && otherDevices.length === 0, 'second account sees only its own empty device list')
    check((await foreign.from('watcher_backups').select('pointer').eq('device_id', deviceId)).data?.length === 0, 'cross-account pointer denied')
    check(!!(await foreign.storage.from('watcher-history').download(pointer.object_path)).error, 'cross-account ciphertext denied')
    check(!(await foreign.rpc('watcher_enable_backup')).error, 'second owned account separately consents')
    check(!!(await foreign.storage.from('watcher-history').upload(`watcher/${owners[0]}/9999999999999999.blob`, new Uint8Array([1]), { contentType: 'application/octet-stream' })).error, 'cross-account upload denied despite own consent')
    check(!!(await foreign.rpc('watcher_publish_backup', { p_device_id: deviceId, p_pointer: pointer, p_expected: 0 })).error, 'cross-account publication denied')
    await foreign.rpc('watcher_delete_history')
    check((await own.from('watcher_backups').select('pointer').eq('device_id', deviceId)).data?.length === 1, 'other-owner history deletion preserves this account')
    const anonymous = createClient(deployment.dataUrl!, deployment.dataPublishableKey!, { global: { fetch: boundedFetch } })
    check(!!(await anonymous.storage.from('watcher-history').download(pointer.object_path)).error, 'anonymous ciphertext denied')
    check(!!(await own.storage.from('watcher-history').upload(pointer.object_path, new Uint8Array([1]), { upsert: true, contentType: 'application/octet-stream' })).error, 'immutable object overwrite denied')
    const ciphertext = await own.storage.from('watcher-history').download(pointer.object_path)
    check(!ciphertext.error && !(await ciphertext.data!.text()).includes('apiEquivalentUSD'), 'stored history is ciphertext')
    const restored = await device(emails[0]!, 'new-device-a')
    await restored.account.run({ action: 'enable', phrase, confirm: true })
    const result = await restored.account.run({ action: 'restore', deviceId, confirm: true })
    check((result.history as { apiEquivalentUSD?: number })?.apiEquivalentUSD === 12, 'new-device encrypted restore matches synthetic history')
    for (let i = 0; i < 2; i++) await a.account.run({ action: 'backup' })
    const previous = await admin.from('watcher_backups').select('pointer,previous_pointer').eq('user_id', owners[0]!).single()
    check(!previous.error && !!previous.data?.previous_pointer, 'current and previous completed versions retained')
    const retainedCleanup = await boundedFetch(`${deployment.authUrl}/functions/v1/watcher-maintenance`, {
      method: 'POST', headers: { apikey: deployment.authPublishableKey, 'x-watcher-service-key': secret! },
    })
    check(retainedCleanup.ok, 'retention cleanup executes through protected endpoint')
    for (const retained of [previous.data.pointer, previous.data.previous_pointer] as BackupPointer[]) {
      for (const path of [retained.object_path, ...retained.part_paths])
        check(!(await own.storage.from('watcher-history').download(path)).error, 'current or previous retained object survives cleanup')
    }
    check(!!(await own.storage.from('watcher-history').download(pointer.object_path)).error, 'superseded ciphertext physically removed')
    a.interrupt()
    let interrupted = false
    try { await a.account.run({ action: 'backup' }) } catch { interrupted = true }
    check(interrupted && await a.local.isPaused(), 'consent revoked during upload prevents publication')
    const unchanged = await admin.from('watcher_backups').select('pointer').eq('user_id', owners[0]!).single()
    check(!unchanged.error && JSON.stringify(unchanged.data?.pointer) === JSON.stringify(previous.data.pointer), 'interrupted upload preserves completed pointer')
    check((await a.account.run({ action: 'delete', confirm: true })).deleted === true, 'owned Watcher history deletion queued')
    const cleanup = await boundedFetch(`${deployment.authUrl}/functions/v1/watcher-maintenance`, {
      method: 'POST', headers: { apikey: deployment.authPublishableKey, 'x-watcher-service-key': secret! },
    })
    check(cleanup.ok && (await cleanup.json()).ok === true, 'protected hosted Storage cleanup executed')
    check((await admin.storage.from('watcher-history').list(`watcher/${owners[0]}`)).data?.length === 0, 'history ciphertext physically removed')
    const beforeRevocation = b.session()
    await b.account.run({ action: 'logout' })
    check(!!(await client(beforeRevocation).rpc('watcher_enable_backup')).error, 'revoked hosted session cannot enable backup')
    await a.account.run({ action: 'enable', phrase, confirm: true })
    await a.account.run({ action: 'backup' })
    const fresh = await admin.auth.admin.generateLink({ type: 'magiclink', email: emails[0]! })
    check(!fresh.error && !!fresh.data.properties.email_otp, 'fresh disposable deletion OTP issued')
    await a.account.run({ action: 'verifyCode', email: emails[0], code: fresh.data.properties.email_otp })
    const erased = await boundedFetch(`${deployment.authUrl}/functions/v1/delete-account`, {
      method: 'POST', headers: { apikey: deployment.authPublishableKey,
        Authorization: `Bearer ${a.session().access_token}`, 'X-Expected-Account-Id': owners[0]! },
    })
    const erasedBody = await erased.json()
    check(erased.ok && erasedBody.deleted === true && erasedBody.counts?.watcher_objects >= 2, 'central account deletion removes owned Watcher ciphertext')
    check((await admin.auth.admin.getUserById(owners[0]!)).error?.status === 404, 'deleted disposable Auth identity is absent')
    check(!!(await client(a.session()).rpc('watcher_enable_backup')).error, 'deleted account stale JWT cannot regain backup access')
  } finally {
    // Cleanup is independent of functional assertions. Never touch an existing identity.
    for (const id of owners) {
      try {
        const purge = await admin.rpc('watcher_purge_account', { p_user: id })
        if (purge.error) throw new Error('cleanup')
        const list = await admin.storage.from('watcher-history').list(`watcher/${id}`, { limit: 100 })
        if (list.error || !list.data.every(row => /^[1-9][0-9]{0,15}[.]blob$/.test(row.name))) throw new Error('cleanup')
        if (list.data.length && (await admin.storage.from('watcher-history').remove(list.data.map(row => `watcher/${id}/${row.name}`))).error) throw new Error('cleanup')
        const existing = await admin.auth.admin.getUserById(id)
        if (existing.error && existing.error.status !== 404) throw new Error('cleanup')
        if (existing.data.user && (await admin.auth.admin.deleteUser(id)).error) throw new Error('cleanup')
      } catch { cleanupFailures.push(id) }
    }
    try {
      const finalized = await boundedFetch(`${deployment.authUrl}/functions/v1/watcher-maintenance`, {
        method: 'POST', headers: { apikey: deployment.authPublishableKey, 'x-watcher-service-key': secret! },
      })
      if (!finalized.ok) cleanupFailures.push('maintenance-finalization')
    } catch { cleanupFailures.push('maintenance-finalization') }
    for (const values of stores) values.clear()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
main().then(() => { if (cleanupFailures.length) throw new Error('QA cleanup incomplete') }).catch((error: unknown) => {
  failureClass = error instanceof Error && ['Error', 'TypeError', 'CloudError'].includes(error.constructor.name) ? error.constructor.name : 'Error'
  process.exitCode = 1
}).finally(async () => {
  const receipt = { ok: !process.exitCode, phase, failureClass, requestFailures, checks, disposableOwners: owners, cleanupFailures }
  if (process.env.WATCHER_QA_RECEIPT) await writeFile(process.env.WATCHER_QA_RECEIPT, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ok: receipt.ok, phase, passedChecks: checks.length, cleanupFailures: cleanupFailures.length }))
})
