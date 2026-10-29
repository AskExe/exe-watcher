import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRecoveryPhrase, recoveryRootFromPhrase, createRecoveryHeader, deriveAppRecoveryWrappingKey, unwrapAppRecoveryKey } from '@odd-core/recovery/account'
import { WatcherAccount } from '../src/cloud/account.js'
import { CloudLocalState } from '../src/cloud/local-state.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'watcher-account-')); directories.push(directory)
  const values = new Map<string, string>()
  const secrets = { getItem: vi.fn(async (k: string) => values.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { values.set(k, v) }), removeItem: vi.fn(async (k: string) => { values.delete(k) }) }
  const userId = randomUUID(), email = 'fixture@example.test'
  const user = { id: userId, email, email_confirmed_at: '2026-10-26T00:00:00Z', is_anonymous: false, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' }
  const calls: string[] = []
  const rpcReplies = new Map<string, unknown>()
  const devices: Array<{ device_id: string; updated_at: string }> = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push(url)
    if (url.includes('/otp')) return new Response('{}')
    if (url.includes('/verify') || url.includes('/token')) return Response.json({ access_token: 'fixture-access-token', refresh_token: 'fixture-rotated-secret', token_type: 'bearer', expires_in: 3600, user })
    if (url.includes('/user')) return Response.json(user)
    if (url.includes('/logout')) return new Response('{}')
    if (url.includes('/rest/v1/watcher_backups')) return Response.json(devices)
    if (url.includes('/rpc/')) {
      const name = url.split('/rpc/')[1]!
      if (rpcReplies.has(name)) return Response.json(rpcReplies.get(name))
    }
    return new Response('{}', { status: 503 })
  }) as typeof fetch
  const config = { authUrl: 'https://odd.fixture.test', authPublishableKey: 'sb_publishable_fixture', dataUrl: null, dataPublishableKey: null, enabled: false }
  const local = new CloudLocalState(directory), account = new WatcherAccount(secrets, local, config, fetcher)
  return { account, local, secrets, values, calls, user, userId, config, fetcher, directory, rpcReplies, devices }
}
describe('Odd sign-in and explicit cloud consent', () => {
  it('never connects, reads credentials or enables backup through an automatic check with no consent', async () => {
    const x = await setup()
    expect(await x.account.run({ action: 'autoBackup' })).toEqual({ skipped: true })
    expect(x.calls).toEqual([]); expect(x.secrets.getItem).not.toHaveBeenCalled()
    expect((await x.local.read()).backupEnabled).toBe(false)
  })
  it('stores session secrets only in the injected secure store and does not enable backup at sign-in', async () => {
    const x = await setup()
    await x.account.run({ action: 'requestCode', email: x.user.email })
    const result = await x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })
    expect(result).toMatchObject({ signedIn: true, backupEnabled: false })
    expect(x.values.get('session')).toContain('fixture-rotated-secret')
    expect(await readFile(join(x.directory, 'state.json'), 'utf8')).not.toContain('fixture-rotated-secret')
    expect(x.calls.every(url => !/rest|storage/.test(url))).toBe(true)
    await expect(x.account.run({ action: 'backup' })).rejects.toThrow('not available')
  })
  it('requires separate Terms acknowledgement before requesting account creation', async () => {
    const x = await setup()
    await expect(x.account.run({ action: 'requestCode', email: x.user.email, createAccount: true })).rejects.toThrow('Terms')
    expect(x.calls).toEqual([])
    await x.account.run({ action: 'requestCode', email: x.user.email, createAccount: true, acceptTerms: true })
    const init = vi.mocked(x.fetcher).mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body)).create_user).toBe(true)
  })
  it('honors a durable pause even if an older operation saved enabled state afterward', async () => {
    const x = await setup()
    x.config.dataUrl = x.config.authUrl as never
    x.config.dataPublishableKey = 'sb_publishable_fixture' as never; x.config.enabled = true
    const state = await x.local.read(); state.accountId = x.userId; state.backupEnabled = true
    await x.local.save(state); await x.local.pause()
    expect(await x.account.run({ action: 'autoBackup' })).toEqual({ skipped: true })
    expect(x.calls).toEqual([]); expect(x.secrets.getItem).not.toHaveBeenCalled()
  })
  it('refuses an unconfirmed identity and preserves an existing account on unconfirmed switching', async () => {
    const x = await setup(); x.user.email_confirmed_at = ''
    await expect(x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })).rejects.toThrow('verified')
    expect(x.values.has('session')).toBe(false)
  })
  it('requires explicit confirmation before changing the stored account', async () => {
    const x = await setup(), priorId = randomUUID()
    const original = JSON.stringify({ version: 1, userId: priorId, email: 'prior@example.test', refreshToken: 'prior-secret' })
    x.values.set('session', original)
    const result = await x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })
    expect(result.accountSwitchRequired).toBe(true)
    expect(x.values.get('session')).toBe(original)
    expect((await x.local.read()).backupEnabled).toBe(false)
  })
  it('removes the local session and backup key even if remote sign-out is offline', async () => {
    const x = await setup()
    await x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })
    x.values.set(`key:${x.userId}`, 'secret-key')
    vi.mocked(x.fetcher).mockRejectedValue(new Error('PRIVATE network details'))
    const result = await x.account.run({ action: 'logout' })
    expect(result).toMatchObject({ signedIn: false, remoteRevoked: false })
    expect(x.values.size).toBe(0); expect((await x.local.read()).backupEnabled).toBe(false)
  })
  it('does not use an unconfigured or foreign data endpoint', async () => {
    const x = await setup(); x.config.dataUrl = 'https://foreign.fixture.test' as never
    x.config.dataPublishableKey = 'sb_publishable_fixture' as never; x.config.enabled = true
    await x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })
    await expect(x.account.run({ action: 'devices' })).rejects.toThrow('not available')
    expect(x.calls.some(url => /rest|storage/.test(url))).toBe(false)
  })
  it('preserves the working backup key when re-enrolling after a phrase reset', async () => {
    const x = await setup()
    x.config.dataUrl = x.config.authUrl as never
    x.config.dataPublishableKey = 'sb_publishable_fixture' as never; x.config.enabled = true
    await x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })
    const phrase = createRecoveryPhrase(), root = recoveryRootFromPhrase(phrase)
    const header = createRecoveryHeader(root, x.userId, randomUUID()), originalKey = randomBytes(32)
    x.values.set(`key:${x.userId}`, JSON.stringify({ version: 1, accountId: x.userId, vaultId: randomUUID(), revision: 1, key: originalKey.toString('base64') }))
    x.devices.push({ device_id: randomUUID(), updated_at: '2026-10-26T00:00:00Z' })
    x.rpcReplies.set('get_odd_backup_eligibility', true); x.rpcReplies.set('get_odd_recovery_header', header)
    x.rpcReplies.set('get_odd_app_key_capsule', null); x.rpcReplies.set('put_odd_app_key_capsule', null)
    x.rpcReplies.set('watcher_enable_backup', null)
    expect(await x.account.run({ action: 'enable', phrase, confirm: true })).toMatchObject({ backupEnabled: true })
    const stored = JSON.parse(x.values.get(`key:${x.userId}`)!)
    expect(stored.key).toBe(originalKey.toString('base64')); expect(stored.vaultId).toBe(header.vaultId)
    const capsuleCall = vi.mocked(x.fetcher).mock.calls.find(call => String(call[0]).endsWith('/put_odd_app_key_capsule'))!
    const capsule = JSON.parse(String(capsuleCall[1]?.body)).p_capsule
    const wrapping = deriveAppRecoveryWrappingKey(root, header, 'watcher')
    expect(Buffer.from(unwrapAppRecoveryKey(wrapping, header, capsule))).toEqual(originalKey)
    root.fill(0); wrapping.fill(0); originalKey.fill(0)
  })
  it('refuses to install a replacement key when cloud history exists but the original key is missing', async () => {
    const x = await setup()
    x.config.dataUrl = x.config.authUrl as never
    x.config.dataPublishableKey = 'sb_publishable_fixture' as never; x.config.enabled = true
    await x.account.run({ action: 'verifyCode', email: x.user.email, code: '123456' })
    const phrase = createRecoveryPhrase(), root = recoveryRootFromPhrase(phrase)
    x.devices.push({ device_id: randomUUID(), updated_at: '2026-10-26T00:00:00Z' })
    x.rpcReplies.set('get_odd_backup_eligibility', true)
    x.rpcReplies.set('get_odd_recovery_header', createRecoveryHeader(root, x.userId, randomUUID()))
    x.rpcReplies.set('get_odd_app_key_capsule', null)
    await expect(x.account.run({ action: 'enable', phrase, confirm: true })).rejects.toThrow('original backup key')
    expect(x.calls.some(url => url.endsWith('/put_odd_app_key_capsule'))).toBe(false)
    expect(x.values.has(`key:${x.userId}`)).toBe(false)
    expect((await x.local.read()).backupEnabled).toBe(false); root.fill(0)
  })
})
