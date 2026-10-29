import { CloudError } from './error.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfigFilePath } from '../config.js'
import { decodeSnapshot, isUUID, type WatcherSnapshot } from './snapshot.js'

export type CloudState = { version: 1; deviceId: string; accountId?: string; backupEnabled: boolean; lastBackupAt?: string }
export class CloudLocalState {
  constructor(readonly directory = join(dirname(getConfigFilePath()), 'odd-account')) {}
  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const final = join(this.directory, name), temp = `${final}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
      await rename(temp, final)
    } finally { await unlink(temp).catch(() => {}) }
  }
  async read(): Promise<CloudState> {
    let raw: string
    try { raw = await readFile(join(this.directory, 'state.json'), 'utf8') }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const state: CloudState = { version: 1, deviceId: randomUUID(), backupEnabled: false }
      await this.write('state.json', state); return state
    }
    const state = JSON.parse(raw) as CloudState
    if (state.version !== 1 || !isUUID(state.deviceId) || (state.accountId !== undefined && !isUUID(state.accountId)) || typeof state.backupEnabled !== 'boolean') {
      throw new CloudError('Watcher account state is damaged. Existing data was preserved.')
    }
    return state
  }
  async save(state: CloudState) { await this.write('state.json', state) }
  async pause() { await this.write('paused.json', { paused: true }) }
  async isPaused() {
    try { await readFile(join(this.directory, 'paused.json')); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
  async resume() { await unlink(join(this.directory, 'paused.json')).catch(e => { if (e.code !== 'ENOENT') throw e }) }
  private archiveName(accountId: string, deviceId: string) {
    if (!isUUID(accountId) || !isUUID(deviceId)) throw new CloudError('Invalid history owner.')
    return `history-${accountId}-${deviceId}.json`
  }
  async archive(accountId: string, snapshot: WatcherSnapshot) {
    const name = this.archiveName(accountId, snapshot.deviceId)
    // Preserve the prior restored view until the new file has been validated and atomically committed.
    await this.write(name, decodeSnapshot(new TextEncoder().encode(JSON.stringify(snapshot))))
  }
  async history(accountId: string, deviceId: string): Promise<WatcherSnapshot | null> {
    try { return decodeSnapshot(await readFile(join(this.directory, this.archiveName(accountId, deviceId)))) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }
}
