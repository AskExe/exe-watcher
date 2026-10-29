import { CloudError } from './error.js'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { acquireFileLock } from '../file-lock.js'
import { getConfigFilePath } from '../config.js'
import { WatcherAccount, type AccountRequest } from './account.js'
import { CloudLocalState } from './local-state.js'

async function ask(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new CloudError('Use an interactive terminal, or pass a JSON request through stdin with --json.')
  process.stderr.write(prompt)
  const silent = new Writable({ write(_chunk, _encoding, done) { done() } })
  const rl = createInterface({ input: process.stdin, output: hidden ? silent : process.stderr, terminal: true })
  try { return (await rl.question('')).trim() }
  finally { rl.close(); if (hidden) process.stderr.write('\n') }
}
async function readRequest(): Promise<AccountRequest> {
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
    if (Buffer.byteLength(data) > 16_384) throw new CloudError('Account request is too large.')
  }
  const request = JSON.parse(data)
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string' ||
      Object.keys(request).some(k => !['action', 'email', 'code', 'phrase', 'confirm', 'deviceId', 'month', 'createAccount', 'acceptTerms'].includes(k))) throw new CloudError('Invalid account request.')
  return request
}
export async function accountCommand(action: string, json: boolean): Promise<void> {
  // Never send account activity, addresses, codes, phrase or cloud history through product telemetry.
  const directory = join(dirname(getConfigFilePath()), 'odd-account')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let release: (() => Promise<void>) | undefined
  try {
    const input = json ? await readRequest() : undefined
    const operation = input?.action ?? action
    // Revocation must not wait behind the long-running operation it cancels.
    if (operation === 'disable' || operation === 'logout' || (operation === 'delete' && input?.confirm === true)) {
      await new CloudLocalState(directory).pause()
    }
    if (operation !== 'disable') release = await acquireFileLock(join(directory, 'account.lock'))
    const account = new WatcherAccount()
    let result: Record<string, unknown>
    if (json) result = await account.run(input!)
    else if (action === 'login') {
      const email = await ask('Odd account email: ')
      await account.run({ action: 'requestCode', email })
      const code = await ask('Email code: ', true)
      result = await account.run({ action: 'verifyCode', email, code })
      if (result.accountSwitchRequired) throw new CloudError('That is a different Odd account. Sign out of Watcher first, then sign in again. Local history will be preserved.')
    } else if (action === 'enable') {
      console.log('Private backup saves encrypted daily cost, provider/token totals and estimated AI running time to your Odd account. It excludes prompts, code, paths and credentials. Nothing is published to your profile. Signing in alone does not enable backup.')
      const recovery = await account.run({ action: 'recoveryPhrase' })
      if (typeof recovery.phrase === 'string') console.log(`Save this new Odd recovery phrase privately. It is needed on your other devices:\n\n${recovery.phrase}\n`)
      const phrase = await ask('Enter your 24-word Odd recovery phrase: ', true)
      const confirm = (await ask('Enable encrypted Watcher backup? Type yes: ')) === 'yes'
      result = await account.run({ action: 'enable', phrase, confirm })
    } else if (action === 'restore' || action === 'dashboard') {
      const devices = await account.run({ action: 'devices' })
      console.log(JSON.stringify(devices, null, 2))
      const deviceId = await ask('Device ID to view: ')
      result = await account.run({ action, deviceId, confirm: true })
    } else if (action === 'delete') {
      const confirm = (await ask('Delete all Watcher cloud history? Local tracking and your Odd account will remain. Type delete: ')) === 'delete'
      result = await account.run({ action: 'delete', confirm })
    } else result = await account.run({ action: action === 'local' ? 'localDashboard' : action })
    console.log(JSON.stringify({ ok: true, ...result }, null, json ? undefined : 2))
  } catch (error) {
    // Errors returned by the SDK are never serialized; only our fixed product messages escape.
    const message = error instanceof CloudError ? error.message : 'Watcher account request failed. Your existing history was preserved.'
    if (json) { console.log(JSON.stringify({ ok: false, message })); process.exitCode = 1 }
    else throw new CloudError(message)
  } finally { await release?.() }
}
