import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'

/// Public GitHub repo that hosts signed macOS release builds. `/releases/latest` returns the
/// newest tagged release; we filter its assets list for our zipped .app bundle.
const RELEASE_API_LATEST = 'https://api.github.com/repos/AskExe/exe-watcher/releases/latest'
const RELEASE_API_BY_TAG = 'https://api.github.com/repos/AskExe/exe-watcher/releases/tags/'
const APP_BUNDLE_NAME = 'Watcher by EXE.app'
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const SIGNING_REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "ZNU2X48VW5" and identifier "com.askexe.exe-watcher-menubar"'
const APP_PROCESS_NAME = 'ExeWatcherMenubar'
const SUPPORTED_OS = 'darwin'
const MIN_MACOS_MAJOR = 14
const DEFAULT_APP_EXIT_TIMEOUT_MS = 5_000
const DEFAULT_APP_LAUNCH_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 150

export type InstallResult = { installedPath: string; launched: boolean }

type ReleaseAsset = { name: string; browser_download_url: string; digest: string; size: number }
type VerifiedAsset = ReleaseAsset & { version: string }
type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[]; draft?: boolean; prerelease?: boolean }

function userApplicationsDir(): string {
  return join(homedir(), 'Applications')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function ensureSupportedPlatform(): Promise<void> {
  if (platform() !== SUPPORTED_OS) {
    throw new Error(`The menubar app is macOS only (detected: ${platform()}).`)
  }
  const major = Number((process.env.EXE_WATCHER_FORCE_MACOS_MAJOR ?? '')
    || (await sysProductVersion()).split('.')[0])
  if (!Number.isFinite(major) || major < MIN_MACOS_MAJOR) {
    throw new Error(`macOS ${MIN_MACOS_MAJOR}+ required (detected ${major}).`)
  }
}

async function sysProductVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/sw_vers', ['-productVersion'])
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`sw_vers exited with ${code}`))
      else resolve(out.trim())
    })
  })
}

async function fetchLatestReleaseAsset(version?: string): Promise<VerifiedAsset> {
  // If a specific version is requested, fetch that tag; otherwise use /releases/latest.
  const tag = version ? (version.startsWith('mac-') ? version : `mac-${version.startsWith('v') ? version : `v${version}`}`) : undefined
  if (tag && !/^mac-v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Choose a stable Watcher release version.')
  const url = tag ? `${RELEASE_API_BY_TAG}${tag}` : RELEASE_API_LATEST
  const response = await fetch(url, {
    headers: {
      // Identify the installer so GitHub's abuse heuristics treat us as a known client.
      'User-Agent': 'exe-watcher-installer',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 403) {
    // GitHub rate limit — read X-RateLimit-Reset to give user a helpful wait time.
    const resetHeader = response.headers.get('X-RateLimit-Reset')
    if (resetHeader) {
      const resetTimestamp = Number(resetHeader)
      const waitMinutes = Math.max(1, Math.ceil((resetTimestamp - Date.now() / 1000) / 60))
      throw new Error(`GitHub API rate limit reached. Try again in ${waitMinutes} minutes.`)
    }
    throw new Error('GitHub API rate limit reached. Try again later.')
  }
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
  }
  const body = await response.json() as ReleaseResponse
  if (!body || body.draft || body.prerelease || !/^mac-v\d+\.\d+\.\d+$/.test(body.tag_name) ||
      (tag && body.tag_name !== tag) || !Array.isArray(body.assets)) {
    throw new Error('GitHub did not return the requested stable Watcher release.')
  }
  const releaseVersion = body.tag_name.slice('mac-v'.length)
  const name = `ExeWatcherMenubar-v${releaseVersion}.zip`
  const matches = body.assets.filter(a => a?.name === name)
  if (matches.length !== 1) throw new Error('The Watcher release must contain exactly one matching app archive.')
  const asset = matches[0]
  const expectedURL = `https://github.com/AskExe/exe-watcher/releases/download/${body.tag_name}/${name}`
  if (!asset || asset.browser_download_url !== expectedURL || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) {
    throw new Error('The Watcher archive has missing or untrusted integrity metadata.')
  }
  return { ...asset, version: releaseVersion }
}

async function downloadToFile(asset: VerifiedAsset, destPath: string): Promise<void> {
  let url = asset.browser_download_url
  let response: Response
  // Validate every redirect before sending another request, including HTTPS.
  for (let redirects = 0; ; redirects++) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !DOWNLOAD_HOSTS.has(parsed.hostname)) {
      throw new Error('The Watcher download redirected to an untrusted destination.')
    }
    response = await fetch(url, {
      headers: { 'User-Agent': 'exe-watcher-installer' }, redirect: 'manual', signal: AbortSignal.timeout(120_000),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects >= 4) throw new Error('The Watcher download returned an invalid redirect.')
    url = new URL(location, url).href
  }
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: HTTP ${response.status}`)
  }
  let bytes = 0
  const hash = createHash('sha256')
  const integrity = new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length
    if (bytes > asset.size) { done(new Error('The Watcher archive exceeds its published size.')); return }
    hash.update(chunk)
    done(null, chunk)
  } })
  const nodeStream = Readable.fromWeb(response.body as never)
  await pipeline(nodeStream, integrity, createWriteStream(destPath, { flags: 'wx', mode: 0o600 }))
  if (bytes !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) {
    throw new Error('The Watcher archive failed its published SHA-256 or size check. Your installed app was preserved.')
  }
}

/** Authenticate the complete staged app before touching the installed copy. */
export async function verifyMacCandidate(appPath: string, version: string): Promise<void> {
  await runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R', SIGNING_REQUIREMENT, appPath])
  await runCommand('/usr/bin/xcrun', ['stapler', 'validate', appPath])
  await runCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath])
  const info = await captureCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(appPath, 'Contents/Info.plist')])
  if (info.code !== 0 || info.stdout.trim() !== version) throw new Error('The signed app version does not match the requested Watcher release.')
}

async function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with status ${code}`))
    })
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function captureCommand(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.on('error', () => resolve({ code: 1, stdout: '' }))
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

function parsePids(output: string): number[] {
  return output
    .split(/\s+/)
    .map(s => Number(s))
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

async function runningAppPids(): Promise<number[]> {
  // `pgrep -f` is intentionally used instead of relying only on bundle APIs: it catches stale
  // menu bar helpers that survived a bundle replacement and still have the old executable mapped.
  const result = await captureCommand('/usr/bin/pgrep', ['-f', APP_PROCESS_NAME])
  return result.code === 0 ? parsePids(result.stdout) : []
}

async function isAppRunning(): Promise<boolean> {
  return (await runningAppPids()).length > 0
}

function timeoutFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '')
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

async function waitForNoRunningApp(timeoutMs = timeoutFromEnv('EXE_WATCHER_APP_EXIT_TIMEOUT_MS', DEFAULT_APP_EXIT_TIMEOUT_MS)): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await runningAppPids()).length === 0) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return (await runningAppPids()).length === 0
}

async function waitForRunningApp(timeoutMs = timeoutFromEnv('EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS', DEFAULT_APP_LAUNCH_TIMEOUT_MS)): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await runningAppPids()).length > 0) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return (await runningAppPids()).length > 0
}

async function signalPids(signal: 'TERM' | 'KILL', pids: number[]): Promise<void> {
  if (pids.length === 0) return
  await new Promise<void>((resolve) => {
    const proc = spawn('/bin/kill', [`-${signal}`, ...pids.map(String)])
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

async function movePath(source: string, dest: string): Promise<void> {
  try {
    await rename(source, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(source, dest, { recursive: true })
      await rm(source, { recursive: true, force: true })
    } else {
      throw err
    }
  }
}

async function restoreExistingApp(backupPath: string, targetPath: string): Promise<void> {
  if (!(await exists(backupPath))) return
  await killRunningApp().catch(() => {})
  await rm(targetPath, { recursive: true, force: true }).catch(() => {})
  await movePath(backupPath, targetPath)
  await runCommand('/usr/bin/open', [targetPath]).catch(() => {})
  await waitForRunningApp().catch(() => false)
}

async function killRunningApp(): Promise<void> {
  const initialPids = await runningAppPids()
  if (initialPids.length === 0) return

  console.log(`Stopping existing Exe Watcher Menubar (${initialPids.join(', ')})...`)
  await signalPids('TERM', initialPids)
  if (await waitForNoRunningApp()) return

  const stubbornPids = await runningAppPids()
  if (stubbornPids.length > 0) {
    console.log(`Force-stopping stale Exe Watcher Menubar (${stubbornPids.join(', ')})...`)
    await signalPids('KILL', stubbornPids)
  }

  if (!(await waitForNoRunningApp())) {
    throw new Error('Could not stop the existing Exe Watcher Menubar process. Please quit it and retry.')
  }
}

export async function installMenubarApp(options: { force?: boolean; version?: string } = {}): Promise<InstallResult> {
  await ensureSupportedPlatform()

  const appsDir = userApplicationsDir()
  const targetPath = join(appsDir, APP_BUNDLE_NAME)
  const alreadyInstalled = await exists(targetPath)

  if (alreadyInstalled && !options.force) {
    if (!(await isAppRunning())) {
      await runCommand('/usr/bin/open', [targetPath])
    }
    return { installedPath: targetPath, launched: true }
  }

  console.log(options.version
    ? `Looking up Exe Watcher Menubar release ${options.version}...`
    : 'Looking up the latest Exe Watcher Menubar release...')
  const asset = await fetchLatestReleaseAsset(options.version)

  const stagingDir = await mkdtemp(join(tmpdir(), 'exe-watcher-menubar-'))
  try {
    const archivePath = join(stagingDir, asset.name)
    console.log(`Downloading ${asset.name}...`)
    await downloadToFile(asset, archivePath)

    console.log('Unpacking...')
    // ditto, not unzip: the release ZIP is made with `ditto -c -k --sequesterRsrc`, and unzip
    // writes its AppleDouble entries into the bundle as ._ files (._PkgInfo, .__CodeSignature,
    // Helpers/._node). That breaks the sealed signature, so macOS reports the update as
    // "damaged and can't be opened" and the install is rolled back.
    await runCommand('/usr/bin/ditto', ['-x', '-k', archivePath, stagingDir])

    const unpackedApp = join(stagingDir, APP_BUNDLE_NAME)
    if (!(await exists(unpackedApp))) {
      throw new Error(`Archive did not contain ${APP_BUNDLE_NAME}.`)
    }

    await verifyMacCandidate(unpackedApp, asset.version)

    await mkdir(appsDir, { recursive: true })
    const backupPath = alreadyInstalled
      ? join(appsDir, `${basename(APP_BUNDLE_NAME, '.app')}.backup-${Date.now()}.app`)
      : undefined
    let targetReplaced = false

    try {
      if (alreadyInstalled && backupPath) {
        // Production updater rule: never delete the only installed copy. Move it aside first,
        // install the candidate, and restore the backup if launch verification fails.
        await killRunningApp()
        await movePath(targetPath, backupPath)
      }

      await movePath(unpackedApp, targetPath)
      targetReplaced = true

      console.log('Launching Exe Watcher Menubar...')
      await runCommand('/usr/bin/open', [targetPath])
      if (!(await waitForRunningApp())) {
        throw new Error('Installed Exe Watcher Menubar, but the app did not launch.')
      }

      if (backupPath) {
        await rm(backupPath, { recursive: true, force: true }).catch(() => {})
      }
      return { installedPath: targetPath, launched: true }
    } catch (err) {
      if (backupPath && (targetReplaced || await exists(backupPath))) {
        await restoreExistingApp(backupPath, targetPath)
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`${detail} Restored the previous working Exe Watcher Menubar; your menu bar app was not left broken.`)
      }
      throw err
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
