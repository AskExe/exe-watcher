import { CloudError } from './error.js'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SecureStore {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/** App-owned Keychain broker. Secret values travel through pipes, never argv or environment. */
export class WatcherSecureStore implements SecureStore {
  private request(action: string, key: string, value?: string): Promise<string | null> {
    if (process.platform !== 'darwin') throw new CloudError('Cloud sign-in currently requires the Watcher Mac app and macOS Keychain.')
    const candidates = [process.env['EXE_WATCHER_KEYCHAIN_HELPER'],
      join(homedir(), 'Applications/Watcher by EXE.app/Contents/MacOS/ExeWatcherMenubar'),
      '/Applications/Watcher by EXE.app/Contents/MacOS/ExeWatcherMenubar']
    const executable = candidates.find((v): v is string => !!v && existsSync(v))
    if (!executable) throw new CloudError('Install the matching Watcher Mac app to store your Odd session securely.')
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['--odd-keychain'], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 })
      const buffers: Buffer[] = []; let size = 0
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 70_000) child.kill(); else buffers.push(chunk) })
      child.on('error', () => reject(new CloudError('Watcher could not access macOS Keychain.')))
      child.on('close', code => {
        try {
          const response = JSON.parse(Buffer.concat(buffers).toString('utf8'))
          if (code !== 0 || size > 70_000 || response.ok !== true || (response.value !== null && typeof response.value !== 'string')) throw new CloudError()
          resolve(response.value)
        } catch { reject(new CloudError('Watcher could not access macOS Keychain. Update the app or allow Keychain access and retry.')) }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ action, key, ...(value === undefined ? {} : { value }) }))
    })
  }
  getItem(key: string) { return this.request('get', key) }
  async setItem(key: string, value: string) { await this.request('set', key, value) }
  async removeItem(key: string) { await this.request('remove', key) }
}
