import { describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { captureSnapshot, decodeSnapshot, summarizeSnapshot, mergeSnapshotHistory, PROVIDERS } from '../src/cloud/snapshot.js'
import { getAllProviders } from '../src/providers/index.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { snapshotCipher } from '../src/cloud/cipher.js'
import { OddCloudBackup, type BackupPointer, type VerifiedRecoveryOwner } from '@odd-core/recovery/backup'
import { createRecoveryPhrase, recoveryRootFromPhrase, createRecoveryHeader, deriveAppRecoveryWrappingKey, wrapAppRecoveryKey, unwrapAppRecoveryKey } from '@odd-core/recovery/account'
import type { DailyCache } from '../src/daily-cache.js'

const deviceId = randomUUID()
function cache(): DailyCache {
  return { version: 9, scopeKey: 'global', lastComputedDate: '2026-10-25', days: [{
    date: '2026-10-25', cost: 12, calls: 4, sessions: 2, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 3, cacheWriteTokens: 4, editTurns: 0, oneShotTurns: 0, models: { 'PRIVATE MODEL': {} as any },
    categories: {}, projects: { '/PRIVATE/project': { cost: 12, sessions: 2 } },
    providers: { claude: { cost: 12, calls: 4, sessions: 2, inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 3, cacheWriteTokens: 4, editTurns: 0, oneShotTurns: 0, models: {}, categories: {} } },
  }] }
}
const bytes = () => new TextEncoder().encode(JSON.stringify(captureSnapshot(cache(), deviceId, null)))

describe('private history data boundary', () => {
  it('covers every supported provider without quietly omitting new adapters', async () => {
    expect([...PROVIDERS].sort()).toEqual((await getAllProviders()).map(p => p.name).sort())
  })
  it('matches the pinned shared recovery source inventory', async () => {
    const base = new URL('../vendor/odd-core-recovery/', import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('PROVENANCE.json', base), 'utf8'))
    const shared = JSON.parse(await readFile(new URL('../supabase/SHARED_PROJECT_PROVENANCE.json', import.meta.url), 'utf8'))
    for (const [path, pin] of Object.entries(shared.files) as Array<[string, { sha256: string }]>) {
      expect(createHash('sha256').update(await readFile(new URL('../' + path, import.meta.url))).digest('hex')).toBe(pin.sha256)
    }
    for (const [path, hashes] of Object.entries(manifest.files) as Array<[string, { vendoredSha256: string }]>) {
      expect(createHash('sha256').update(await readFile(new URL(path, base))).digest('hex')).toBe(hashes.vendoredSha256)
    }
  })
  it('captures only approved totals and labels API estimates accurately', () => {
    const snapshot = captureSnapshot(cache(), deviceId, null)
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
    expect(snapshot.days[0]).toEqual({ date: '2026-10-25', provider: 'claude', apiEquivalentUSD: 12,
      calls: 4, inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 })
    expect(summarizeSnapshot(snapshot, '2026-10').apiEquivalentUSD).toBe(12)
    expect(summarizeSnapshot(snapshot, '2026-09').apiEquivalentUSD).toBe(0)
    expect(snapshot.costBasis).toContain('not-invoices')
  })
  it.each([
    (x: any) => { x.prompts = ['PRIVATE'] },
    (x: any) => { x.days[0].project = '/PRIVATE' },
    (x: any) => { x.days[0].apiEquivalentUSD = -1 },
    (x: any) => { x.days[0].calls = 1.2 },
    (x: any) => { x.days.push(x.days[0]) },
    (x: any) => { x.days[0].provider = 'PRIVATE' },
    (x: any) => { x.timezone = 'PRIVATE' },
    (x: any) => { x.days[0].date = '2026-02-30' },
  ])('rejects malformed or expanded remote data before restore', mutate => {
    const x = JSON.parse(Buffer.from(bytes()).toString()); mutate(x)
    expect(() => decodeSnapshot(new TextEncoder().encode(JSON.stringify(x)))).toThrow()
  })
  it('does not let a scoped/filter-only cache replace global history', () => {
    expect(() => captureSnapshot({ ...cache(), scopeKey: 'filtered' }, deviceId, null)).toThrow('global history')
  })
  it('preserves backed-up days when a cleared local cache has only recent history', () => {
    const previous = captureSnapshot(cache(), deviceId, null)
    const current = structuredClone(previous)
    current.days[0]!.date = '2026-10-26'
    expect(mergeSnapshotHistory(previous, current).days.map(d => d.date)).toEqual(['2026-10-25', '2026-10-26'])
  })
  it('refuses regressed accounting instead of overwriting a completed cloud row', () => {
    const previous = captureSnapshot(cache(), deviceId, null), current = structuredClone(previous)
    current.days[0]!.apiEquivalentUSD = 1
    expect(() => mergeSnapshotHistory(previous, current)).toThrow('preserved')
    expect(previous.days[0]!.apiEquivalentUSD).toBe(12)
  })
  it('uses the same Odd phrase while deriving a distinct Watcher wrapping key', () => {
    const root = recoveryRootFromPhrase(createRecoveryPhrase())
    const header = createRecoveryHeader(root, randomUUID(), randomUUID())
    const watcher = deriveAppRecoveryWrappingKey(root, header, 'watcher')
    const qg = deriveAppRecoveryWrappingKey(root, header, 'qg')
    expect(watcher).not.toEqual(qg)
    const key = randomBytes(32), capsule = wrapAppRecoveryKey(watcher, header, 'watcher', 1, key)
    expect(Buffer.from(unwrapAppRecoveryKey(watcher, header, capsule))).toEqual(key)
    expect(() => unwrapAppRecoveryKey(qg, header, capsule)).toThrow()
    root.fill(0); watcher.fill(0); qg.fill(0); key.fill(0)
  })
})

describe('authenticated encrypted backup and recovery', () => {
  function setup() {
    let owner: VerifiedRecoveryOwner = { accountId: randomUUID(), vaultId: randomUUID(), generation: 0, appOwnerId: deviceId, storageOwnerId: '' }
    owner.storageOwnerId = owner.accountId
    const key = randomBytes(32), cipher = snapshotCipher(key, 1); key.fill(0)
    let pointer: BackupPointer | null = null, committed: Uint8Array | null = null
    const objects = new Map<string, Uint8Array>()
    const ports = {
      owner: async () => owner, activeMember: async () => true,
      latest: async () => pointer,
      upload: async (path: string, value: Uint8Array) => { if (objects.has(path)) throw new Error('Immutable'); objects.set(path, value.slice()) },
      download: async (path: string) => objects.get(path)!.slice(),
      publish: async (next: BackupPointer, expected: number) => {
        if ((pointer?.version ?? 0) !== expected) return false
        pointer = next; return true
      },
    }
    const snapshot = {
      capture: async () => bytes(),
      stage: async (value: Uint8Array) => { decodeSnapshot(value); return {
        commit: async (check: () => Promise<void>) => { await check(); committed = value.slice() }, discard: async () => {},
      } },
    }
    return { ports, snapshot, cipher, objects,
      engine: new OddCloudBackup('watcher', ports, snapshot, cipher, true),
      pointer: () => pointer, committed: () => committed,
      changeOwner: () => { owner = { ...owner, accountId: randomUUID(), generation: owner.generation + 1 } },
    }
  }
  it('uploads opaque authenticated bytes, reads them back, and restores identical history', async () => {
    const x = setup(); await x.engine.backup()
    expect(x.pointer()).not.toBeNull()
    for (const value of x.objects.values()) expect(Buffer.from(value).toString()).not.toContain('apiEquivalentUSD')
    await x.engine.restore()
    expect(decodeSnapshot(x.committed()!).days).toEqual(decodeSnapshot(bytes()).days)
    x.cipher.destroy?.()
  })
  it('preserves the old pointer on failed upload and rejects corruption before commit', async () => {
    const x = setup(); await x.engine.backup(); const original = x.pointer()
    x.ports.upload = async () => { throw new Error('Offline') }
    await expect(x.engine.backup()).rejects.toThrow('Offline')
    expect(x.pointer()).toBe(original)
    const object = x.objects.get(original!.object_path)!; object[14] = object[14]! ^ 1
    await expect(x.engine.restore()).rejects.toThrow()
    expect(x.committed()).toBeNull(); x.cipher.destroy?.()
  })
  it('does not publish or restore when an account changes during network work', async () => {
    const x = setup(), upload = x.ports.upload
    x.ports.upload = async (path, value) => { await upload(path, value); x.changeOwner() }
    await expect(x.engine.backup()).rejects.toThrow('account changed')
    expect(x.pointer()).toBeNull(); expect(x.committed()).toBeNull(); x.cipher.destroy?.()
  })
  it('never silently overwrites a concurrent completed backup', async () => {
    const x = setup(); await x.engine.backup(); const old = x.pointer()
    x.ports.publish = async () => false
    await expect(x.engine.backup()).rejects.toThrow('Another device')
    expect(x.pointer()).toBe(old); x.cipher.destroy?.()
  })
  it('binds ciphertext to account, device, vault, and version', async () => {
    const x = setup(), encrypted = await x.cipher.seal(bytes(), 'account/device/vault/1')
    for (const context of ['other/device/vault/1', 'account/other/vault/1', 'account/device/other/1', 'account/device/vault/2']) {
      await expect(x.cipher.open(encrypted, context)).rejects.toThrow()
    }
    x.cipher.destroy?.()
  })
})
