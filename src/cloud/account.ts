import { CloudError } from './error.js'
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID } from 'node:crypto'
import { OddCloudBackup, type BackupPointer, type VerifiedRecoveryOwner } from '@odd-core/recovery/backup'
import { createRecoveryPhrase, createRecoveryHeader, parseRecoveryHeader, recoveryRootFromPhrase,
  deriveAppRecoveryWrappingKey, unwrapAppRecoveryKey, isWeakRecoveryEntropy, type OddRecoveryHeader } from '@odd-core/recovery/account'
import { nextAppKeyCapsule, parseAppKeyCapsule } from '@odd-core/recovery/capsule'
import deployment from './deployment.json'
import { CloudLocalState, type CloudState } from './local-state.js'
import { WatcherSecureStore, type SecureStore } from './secure-store.js'
import { captureSnapshot, decodeSnapshot, isUUID, mergeSnapshotHistory, summarizeSnapshot, type WatcherSnapshot } from './snapshot.js'
import { snapshotCipher } from './cipher.js'
import { loadDailyCache } from '../daily-cache.js'
import { readTimeIndex } from '../time-index.js'
import { summarizeTime, TIME_HISTORY_START } from '../time-tracking.js'

export type AccountRequest = { action: string; email?: string; code?: string; phrase?: string; confirm?: boolean; deviceId?: string; month?: string; createAccount?: boolean; acceptTerms?: boolean }
type SavedSession = { version: 1; userId: string; refreshToken: string; email: string }
type SavedKey = { version: 1; accountId: string; vaultId: string; revision: number; key: string }
export type CloudDeployment = { authUrl: string; authPublishableKey: string; dataUrl: string | null; dataPublishableKey: string | null; enabled: boolean }
const SERVICE_UNAVAILABLE = 'Cloud backup is not available in this build yet. Local Watcher tracking still works.'

/** Every operation is serialized by the caller's account lock; SDK sessions never persist to disk. */
export class WatcherAccount {
  private auth: SupabaseClient
  constructor(private readonly secrets: SecureStore = new WatcherSecureStore(),
    private readonly local = new CloudLocalState(), private readonly config: CloudDeployment = deployment,
    fetcher: typeof fetch = fetch) {
    const boundedFetch: typeof fetch = async (input, init) => {
      try {
        return await fetcher(input, {
          ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
        })
      } catch {
        // auth-js logs thrown fetch exceptions verbatim. Convert them to a fixed response;
        // 408 also leaves retries to the user instead of holding the account lock for SDK backoff.
        return Response.json({ message: 'Cloud request unavailable' }, { status: 408 })
      }
    }
    this.auth = createClient(config.authUrl, config.authPublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: boundedFetch },
    })
    this.fetcher = boundedFetch
  }
  private fetcher: typeof fetch
  private get available() {
    return this.config.enabled && this.config.dataUrl === this.config.authUrl && !!this.config.dataPublishableKey
  }
  private async saved(): Promise<SavedSession | null> {
    const raw = await this.secrets.getItem('session')
    if (!raw) return null
    const x = JSON.parse(raw) as SavedSession
    if (x.version !== 1 || !isUUID(x.userId) || typeof x.refreshToken !== 'string' || !x.refreshToken || typeof x.email !== 'string') throw new CloudError('Sign in to Odd again to reconnect Watcher.')
    return x
  }
  private async keep(session: Session): Promise<void> {
    const u = session.user
    if (!isUUID(u.id) || !u.email || !u.email_confirmed_at || u.is_anonymous !== false) throw new CloudError('A verified Odd email account is required.')
    await this.secrets.setItem('session', JSON.stringify({ version: 1, userId: u.id, email: u.email, refreshToken: session.refresh_token } satisfies SavedSession))
  }
  private async session(): Promise<Session> {
    const prior = await this.saved()
    if (!prior) throw new CloudError('Sign in to Odd first.')
    const { data, error } = await this.auth.auth.refreshSession({ refresh_token: prior.refreshToken })
    if (error || !data.session) throw new CloudError('Could not reconnect to Odd. Check your connection or sign in again.')
    // Persist rotated credentials immediately, including when a later network verification fails.
    if (data.session.user.id !== prior.userId) throw new CloudError('Odd account changed. Sign out before switching accounts.')
    await this.keep(data.session)
    const verified = await this.auth.auth.getUser(data.session.access_token)
    if (verified.error || verified.data.user?.id !== prior.userId || !verified.data.user.email_confirmed_at || verified.data.user.is_anonymous !== false) throw new CloudError('Odd could not verify this account.')
    return data.session
  }
  private async rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.auth.rpc(name, args)
    if (error) throw new CloudError('Odd recovery is unavailable or changed on another device. Your existing backup was preserved.')
    return data
  }
  private async header(userId: string): Promise<OddRecoveryHeader | null> {
    const value = await this.rpc('get_odd_recovery_header')
    if (!value) return null
    const h = parseRecoveryHeader(value)
    if (h.accountId !== userId) throw new CloudError('Recovery account does not match.')
    return h
  }
  private async keys(userId: string, header: OddRecoveryHeader): Promise<SavedKey> {
    const raw = await this.secrets.getItem(`key:${userId}`)
    if (!raw) throw new CloudError('Unlock backup with your Odd recovery phrase first.')
    const k = JSON.parse(raw) as SavedKey
    if (k.version !== 1 || k.accountId !== userId || k.vaultId !== header.vaultId || !Number.isSafeInteger(k.revision) || k.revision < 1 ||
        typeof k.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(k.key)) throw new CloudError('Your Odd recovery phrase changed. Unlock backup again.')
    const capsule = parseAppKeyCapsule(await this.rpc('get_odd_app_key_capsule', { p_app_code: 'watcher' }), header, 'watcher')
    if (capsule.revision !== k.revision) throw new CloudError('Watcher recovery keys changed. Unlock backup again.')
    return k
  }
  private data(session: Session) {
    if (!this.available) throw new CloudError(SERVICE_UNAVAILABLE)
    return createClient(this.config.dataUrl!, this.config.dataPublishableKey!, {
      accessToken: async () => session.access_token,
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: this.fetcher },
    })
  }
  private async capture(deviceId: string) {
    const index = await readTimeIndex()
    const time = Object.keys(index.files).length ? summarizeTime(index, { start: new Date(TIME_HISTORY_START), end: new Date() }) : null
    return captureSnapshot(await loadDailyCache(), deviceId, time)
  }
  async run(request: AccountRequest): Promise<Record<string, unknown>> {
    const state = await this.local.read()
    if (request.action === 'autoBackup') {
      const last = state.lastBackupAt ? Date.parse(state.lastBackupAt) : NaN
      if (!this.available || !state.accountId || !state.backupEnabled || await this.local.isPaused() || (Number.isFinite(last) && Date.now() - last < 6 * 60 * 60_000)) return { skipped: true }
      return this.run({ action: 'backup' })
    }
    if (request.action === 'localDashboard') return { history: summarizeSnapshot(await this.capture(state.deviceId), request.month), private: true }
    if (request.action === 'requestCode') {
      if (typeof request.email !== 'string' || request.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email)) throw new CloudError('Enter a valid email address.')
      if (request.createAccount === true && request.acceptTerms !== true) throw new CloudError('Accept the Odd Terms and read the Privacy Policy before creating an account.')
      const { error } = await this.auth.auth.signInWithOtp({ email: request.email.trim(), options: {
        shouldCreateUser: request.createAccount === true,
        ...(request.createAccount === true ? { data: { terms_accepted_at: new Date().toISOString(), terms_source: 'watcher' } } : {}),
      } })
      if (error) throw new CloudError('Odd could not send a code. Check the address and try again shortly.')
      return { codeSent: true }
    }
    if (request.action === 'verifyCode') {
      if (typeof request.email !== 'string' || typeof request.code !== 'string' || !/^\d{6,10}$/.test(request.code.trim())) throw new CloudError('Enter the code from your Odd email.')
      const prior = await this.saved()
      const { data, error } = await this.auth.auth.verifyOtp({ email: request.email, token: request.code.trim(), type: 'email' })
      if (error || !data.session) throw new CloudError('That code expired or could not be verified. Request another code.')
      if (prior && prior.userId !== data.session.user.id && request.confirm !== true) {
        await this.auth.auth.signOut({ scope: 'local' })
        return { accountSwitchRequired: true, email: data.session.user.email }
      }
      await this.keep(data.session)
      if (state.accountId !== data.session.user.id) {
        state.accountId = data.session.user.id; state.backupEnabled = false; delete state.lastBackupAt
        await this.local.save(state)
      }
      return { signedIn: true, email: data.session.user.email, backupEnabled: state.backupEnabled }
    }
    if (request.action === 'status') {
      const saved = await this.saved()
      return { signedIn: !!saved, email: saved?.email ?? null, backupAvailable: this.available,
        backupEnabled: !!saved && saved.userId === state.accountId && state.backupEnabled && !await this.local.isPaused(),
        deviceId: state.deviceId, lastBackupAt: state.lastBackupAt ?? null, private: true }
    }
    if (request.action === 'disable' || request.action === 'logout') {
      await this.local.pause()
      state.backupEnabled = false; await this.local.save(state)
      if (request.action === 'logout') {
        const saved = await this.saved(); let remoteRevoked = false
        try { await this.session(); remoteRevoked = !(await this.auth.auth.signOut({ scope: 'local' })).error } catch { /* Still remove the local session offline. */ }
        await this.secrets.removeItem('session')
        if (saved) await this.secrets.removeItem(`key:${saved.userId}`)
        delete state.accountId; delete state.lastBackupAt; await this.local.save(state)
        return { signedIn: false, remoteRevoked, backupEnabled: false }
      }
      return { backupEnabled: false }
    }
    if (!this.available) throw new CloudError(SERVICE_UNAVAILABLE)
    const session = await this.session(), userId = session.user.id
    if (state.accountId !== userId) throw new CloudError('Sign in again before using this account’s history.')
    const data = this.data(session)
    if (request.action === 'recoveryPhrase') {
      if (await this.header(userId)) return { existingPhrase: true }
      return { phrase: createRecoveryPhrase(), existingPhrase: false }
    }
    if (request.action === 'enable') {
      if (request.confirm !== true || typeof request.phrase !== 'string') throw new CloudError('Confirm private cloud backup and enter your Odd recovery phrase.')
      // Prove Watcher's owner-only endpoint works before creating any recovery metadata.
      const existingDevices = await this.list(data)
      if (await this.rpc('get_odd_backup_eligibility', { p_app_code: 'watcher' }) !== true) throw new CloudError('Watcher backup is not enabled for this Odd account yet.')
      const root = recoveryRootFromPhrase(request.phrase)
      let key: Uint8Array | undefined, wrapping: Uint8Array | undefined
      try {
        let header = await this.header(userId)
        if (!header) {
          if (existingDevices.length) throw new CloudError('Cloud history already exists, but its recovery vault is missing. Existing history was preserved.')
          if (isWeakRecoveryEntropy(root)) throw new CloudError('Use a new recovery phrase generated by Odd.')
          header = createRecoveryHeader(root, userId, randomUUID())
          await this.rpc('create_odd_recovery_header', { p_header: header, p_app_code: 'watcher' })
          header = await this.header(userId)
          if (!header) throw new CloudError('Could not enroll Odd recovery.')
        }
        wrapping = deriveAppRecoveryWrappingKey(root, header, 'watcher')
        const stored = await this.rpc('get_odd_app_key_capsule', { p_app_code: 'watcher' })
        let revision = 1
        if (stored) {
          const capsule = parseAppKeyCapsule(stored, header, 'watcher')
          key = unwrapAppRecoveryKey(wrapping, header, capsule); revision = capsule.revision
        } else {
          // A phrase reset replaces the vault/capsule, not this device's working backup key.
          // Preserve that key so existing snapshots can open via the prior-vault context.
          const localKey = await this.secrets.getItem(`key:${userId}`)
          if (localKey) {
            const prior = JSON.parse(localKey) as SavedKey
            if (prior.version !== 1 || prior.accountId !== userId || !isUUID(prior.vaultId) ||
                typeof prior.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(prior.key)) throw new CloudError('Existing Watcher backup key is damaged. No cloud keys were replaced.')
            key = Buffer.from(prior.key, 'base64')
          } else {
            if (existingDevices.length) throw new CloudError('Existing cloud history needs its original backup key. Unlock from a device that still has it, or explicitly delete cloud history before starting over.')
            key = randomBytes(32)
          }
          const next = nextAppKeyCapsule(wrapping, header, 'watcher', null, key)
          await this.rpc('put_odd_app_key_capsule', { p_capsule: next.capsule, p_expected_revision: 0 })
        }
        if (key.length !== 32) throw new CloudError('Unsupported Watcher backup key.')
        await this.secrets.setItem(`key:${userId}`, JSON.stringify({ version: 1, accountId: userId, vaultId: header.vaultId, revision, key: Buffer.from(key).toString('base64') } satisfies SavedKey))
        const enabled = await data.rpc('watcher_enable_backup')
        if (enabled.error) throw new CloudError('Cloud backup could not be enabled. Your local history is safe.')
        await this.local.resume()
        state.backupEnabled = true; await this.local.save(state)
        return { backupEnabled: true, message: 'Private backup enabled. Use Back up now to save this device’s history.' }
      } finally { root.fill(0); key?.fill(0); wrapping?.fill(0) }
    }
    if (request.action === 'devices') return { devices: await this.list(data), private: true }
    if (request.action === 'delete') {
      if (request.confirm !== true) throw new CloudError('Confirm deletion of Watcher cloud history. Your local tracking and Odd account will remain.')
      await this.local.pause(); state.backupEnabled = false; await this.local.save(state)
      const { error } = await data.rpc('watcher_delete_history')
      if (error) throw new CloudError('Cloud history deletion could not finish. Backup is paused; retry when connected.')
      delete state.lastBackupAt; await this.local.save(state)
      return { deleted: true, backupEnabled: false }
    }
    if (request.action === 'backup' && (!state.backupEnabled || await this.local.isPaused())) throw new CloudError('Choose Enable private backup first.')
    const header = await this.header(userId)
    if (!header) throw new CloudError('Set up your Odd recovery phrase first.')
    const k = await this.keys(userId, header), key = Buffer.from(k.key, 'base64')
    const deviceId = request.action === 'backup' ? state.deviceId : request.deviceId
    if (!isUUID(deviceId)) { key.fill(0); throw new CloudError('Choose a device from your private cloud history.') }
    const owner: VerifiedRecoveryOwner = { accountId: userId, vaultId: header.vaultId, generation: 0, appOwnerId: deviceId, storageOwnerId: userId }
    let restored: WatcherSnapshot | null = null
    let captured: WatcherSnapshot | null = null
    let baselineVersion: number | null = null
    const cipher = snapshotCipher(key, k.revision); key.fill(0)
    const engine = new OddCloudBackup('watcher', {
      owner: async () => {
        const current = await this.local.read()
        if (current.accountId !== userId || (request.action === 'backup' && (!current.backupEnabled || await this.local.isPaused()))) throw new CloudError('Backup was paused or the account changed.')
        const latestHeader = await this.header(userId)
        if (!latestHeader || latestHeader.vaultId !== header.vaultId) throw new CloudError('Odd recovery changed. Unlock backup again.')
        return owner
      },
      activeMember: async () => (await this.rpc('get_odd_backup_eligibility', { p_app_code: 'watcher' })) === true,
      latest: async () => {
        const { data: rows, error } = await data.from('watcher_backups').select('pointer').eq('device_id', deviceId).limit(1)
        if (error) throw new CloudError('Could not read cloud history. No backup was overwritten.')
        const pointer = (rows?.[0]?.pointer as BackupPointer | undefined) ?? null
        if (baselineVersion !== null && (pointer?.version ?? 0) !== baselineVersion) throw new CloudError('Cloud history changed on another device. Reload it before backing up.')
        baselineVersion = pointer?.version ?? 0
        return pointer
      },
      upload: async (path, bytes) => {
        const { error } = await data.storage.from('watcher-history').upload(path, bytes, { contentType: 'application/octet-stream', upsert: false })
        if (error) throw new CloudError('Cloud upload failed. Your previous backup is intact.')
      },
      download: async path => {
        const { data: blob, error } = await data.storage.from('watcher-history').download(path)
        if (error || !blob || blob.size > 5 * 1024 * 1024) throw new CloudError('Could not read encrypted history.')
        return new Uint8Array(await blob.arrayBuffer())
      },
      publish: async (pointer, expected) => {
        const { data: published, error } = await data.rpc('watcher_publish_backup', { p_device_id: deviceId, p_pointer: pointer, p_expected: expected })
        return !error && published === true
      },
      priorVaultIds: async () => {
        const status = await this.rpc('get_odd_recovery_reset_status') as { prior_vault_ids?: unknown }
        return Array.isArray(status?.prior_vault_ids) ? status.prior_vault_ids.filter(isUUID) : []
      },
    }, {
      capture: async () => {
        const current = await this.capture(deviceId)
        captured = restored ? mergeSnapshotHistory(restored, current) : current
        return new TextEncoder().encode(JSON.stringify(captured))
      },
      stage: async bytes => {
        const snapshot = decodeSnapshot(bytes)
        if (snapshot.deviceId !== deviceId) throw new CloudError('History belongs to a different device.')
        return { commit: async check => { await check(); await this.local.archive(userId, snapshot); restored = snapshot }, discard: async () => {} }
      },
    }, cipher, true)
    try {
      if (request.action === 'backup') {
        // Read/validate this device's completed cloud view before replacing it. A new local
        // cache may have less history; lost days are preserved and regressed rows are refused.
        const existing = await data.from('watcher_backups').select('pointer').eq('device_id', deviceId).limit(1)
        if (existing.error) throw new CloudError('Could not read existing cloud history. No backup was overwritten.')
        if (existing.data?.length) await engine.restore()
        else baselineVersion = 0
        await engine.backup()
        if (captured) await this.local.archive(userId, captured)
        state.lastBackupAt = new Date().toISOString(); await this.local.save(state)
        return { backedUp: true, lastBackupAt: state.lastBackupAt }
      }
      if (request.action === 'restore' || request.action === 'dashboard') {
        if (request.action === 'restore' && request.confirm !== true) throw new CloudError('Confirm downloading this device’s private history.')
        await engine.restore()
        if (!restored) throw new CloudError('No completed cloud history was restored.')
        return { restored: true, history: summarizeSnapshot(restored, request.month), private: true,
          message: 'Cloud history is a separate saved view. Current local logs and recorded costs were preserved.' }
      }
      throw new CloudError('Unknown Watcher account action.')
    } finally { cipher.destroy?.() }
  }
  private async list(client: SupabaseClient) {
    const { data, error } = await client.from('watcher_backups').select('device_id,updated_at').order('updated_at', { ascending: false }).limit(100)
    if (error) throw new CloudError('Watcher cloud storage is not ready. Local history is safe.')
    if (!Array.isArray(data) || !data.every(x => isUUID(x.device_id) && typeof x.updated_at === 'string')) throw new CloudError('Invalid cloud device list.')
    return data
  }
}
