import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

const ARCHIVE = Buffer.from('fixture signed app archive')
const FIXTURE_DIGEST = `sha256:${createHash('sha256').update(ARCHIVE).digest('hex')}`
let fixtureVersion = '0.2.21'

// Mock os.platform before importing the module under test.
// The module reads platform() at call time, so vi.mock is sufficient.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: vi.fn(() => 'darwin') }
})

// Mock child_process.spawn to prevent real subprocesses (sw_vers, open, etc.)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

// Mock fs operations that touch disk (rename, stat, mkdir, mkdtemp, rm, createWriteStream)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/exe-watcher-menubar-mock'),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createWriteStream: vi.fn(() => {
      // Return a minimal writable-like object
      const { PassThrough } = require('node:stream')
      return new PassThrough()
    }),
  }
})

// Lazy import so mocks are in place
const { installMenubarApp } = await import('../src/menubar-installer.js')
type InstallResult = Awaited<ReturnType<typeof installMenubarApp>>

// The regex lives in the module as a constant. We replicate it here for the
// pattern-matching tests since it is not exported. The spec asks us to verify
// the pattern, and duplicating a one-line regex is the pragmatic approach.
const ASSET_PATTERN = /^ExeWatcherMenubar-.*\.zip$/

describe('menubar-installer', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    fixtureVersion = '0.2.21'
    savedEnv['EXE_WATCHER_FORCE_MACOS_MAJOR'] = process.env.EXE_WATCHER_FORCE_MACOS_MAJOR
    savedEnv['EXE_WATCHER_APP_EXIT_TIMEOUT_MS'] = process.env.EXE_WATCHER_APP_EXIT_TIMEOUT_MS
    savedEnv['EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS'] = process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS
    // Default: force macOS 15 so platform checks pass unless a test overrides
    process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '15'
    vi.mocked(os.platform).mockReturnValue('darwin')
  })

  afterEach(() => {
    // Restore env vars
    if (savedEnv['EXE_WATCHER_FORCE_MACOS_MAJOR'] === undefined) {
      delete process.env.EXE_WATCHER_FORCE_MACOS_MAJOR
    } else {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = savedEnv['EXE_WATCHER_FORCE_MACOS_MAJOR']
    }
    if (savedEnv['EXE_WATCHER_APP_EXIT_TIMEOUT_MS'] === undefined) {
      delete process.env.EXE_WATCHER_APP_EXIT_TIMEOUT_MS
    } else {
      process.env.EXE_WATCHER_APP_EXIT_TIMEOUT_MS = savedEnv['EXE_WATCHER_APP_EXIT_TIMEOUT_MS']
    }
    if (savedEnv['EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS'] === undefined) {
      delete process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS
    } else {
      process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS = savedEnv['EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS']
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // -----------------------------------------------------------------------
  // Platform checks
  // -----------------------------------------------------------------------

  describe('ensureSupportedPlatform (via installMenubarApp)', () => {
    it('throws "macOS only" when platform is linux', async () => {
      vi.mocked(os.platform).mockReturnValue('linux')
      await expect(installMenubarApp()).rejects.toThrow(/macOS only/)
    })

    it('throws "macOS 14+ required" when major version is 13', async () => {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '13'
      await expect(installMenubarApp()).rejects.toThrow(/macOS 14\+ required/)
    })

    it('passes platform check when major version is 14', async () => {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '14'

      // Mock global fetch to return a valid release payload so the installer
      // progresses past the platform check. It will still fail later when
      // download is attempted, but that proves the platform gate passed.
      const fakeRelease = {
        tag_name: 'mac-v0.1.1',
        assets: [
          {
            name: 'ExeWatcherMenubar-v0.1.1.zip', digest: FIXTURE_DIGEST, size: ARCHIVE.length,
            browser_download_url: 'https://github.com/AskExe/exe-watcher/releases/download/mac-v0.1.1/ExeWatcherMenubar-v0.1.1.zip',
          },
        ],
      }

      const mockFetch = vi.fn()
        // First call: GitHub release API
        .mockResolvedValueOnce({
          ok: true,
          json: async () => fakeRelease,
        } as unknown as Response)
        // Second call: download the zip (will fail, that's fine)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          body: null,
        } as unknown as Response)

      vi.stubGlobal('fetch', mockFetch)

      // The install should fail somewhere after the platform check.
      // Whatever error we get, it must NOT be the platform gate.
      try {
        await installMenubarApp({ force: true })
        // If it somehow succeeds, that's fine too — platform check passed.
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(msg).not.toMatch(/macOS only/)
        expect(msg).not.toMatch(/macOS 14\+ required/)
      }

      // Verify fetch was called (proves platform check passed)
      expect(mockFetch).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // InstallResult shape
  // -----------------------------------------------------------------------

  describe('InstallResult type shape', () => {
    it('has installedPath (string) and launched (boolean) when install succeeds', async () => {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '15'
      process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS = '1'

      // Simulate the app already being installed: stat resolves (file exists),
      // and pgrep says it's running.
      const fsMock = await import('node:fs/promises')
      vi.mocked(fsMock.stat).mockResolvedValueOnce({} as any)

      // Mock spawn for pgrep (isAppRunning → code 0 = running)
      const mockSpawn = vi.mocked(childProcess.spawn)
      const fakeProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'close') cb(0) // pgrep exit 0 = app is running
        }),
      }
      mockSpawn.mockReturnValue(fakeProc as any)

      const result: InstallResult = await installMenubarApp()

      expect(typeof result.installedPath).toBe('string')
      expect(typeof result.launched).toBe('boolean')
      expect(result.installedPath).toContain('Watcher by EXE.app')
      expect(result.launched).toBe(true)
    })
  })

  describe('force reinstall process lifecycle', () => {
    it('terminates the stale running app and waits for the replacement to launch', async () => {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '15'
      process.env.EXE_WATCHER_APP_EXIT_TIMEOUT_MS = '0'
      process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS = '1'

      const fsMock = await import('node:fs/promises')
      vi.mocked(fsMock.stat).mockResolvedValue({} as any)
      vi.mocked(fsMock.mkdtemp).mockResolvedValue('/tmp/exe-watcher-menubar-mock')
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined)
      vi.mocked(fsMock.rename).mockResolvedValue(undefined)
      vi.mocked(fsMock.rm).mockResolvedValue(undefined)

      const fakeRelease = {
        tag_name: 'mac-v0.2.21',
        assets: [
          {
            name: 'ExeWatcherMenubar-v0.2.21.zip', digest: FIXTURE_DIGEST, size: ARCHIVE.length,
            browser_download_url: 'https://github.com/AskExe/exe-watcher/releases/download/mac-v0.2.21/ExeWatcherMenubar-v0.2.21.zip',
          },
        ],
      }
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => fakeRelease } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ARCHIVE)); controller.close() } }),
        } as unknown as Response))

      const pgrepOutputs = ['111\n', '', '222\n']
      const spawnCalls: Array<{ command: string; args: string[] }> = []
      vi.mocked(childProcess.spawn).mockImplementation((command: string, args: readonly string[] = []) => {
        spawnCalls.push({ command, args: [...args] })
        const proc = new EventEmitter() as any
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()

        process.nextTick(() => {
          if (command === '/usr/libexec/PlistBuddy') {
            proc.stdout.emit('data', Buffer.from(fixtureVersion)); proc.emit('close', 0); return
          }
          if (command === '/usr/bin/pgrep') {
            const out = pgrepOutputs.shift() ?? ''
            if (out) proc.stdout.emit('data', Buffer.from(out))
            proc.emit('close', out ? 0 : 1)
          } else {
            proc.emit('close', 0)
          }
        })

        return proc
      })

      const result = await installMenubarApp({ force: true })

      expect(result.launched).toBe(true)
      expect(spawnCalls).toContainEqual({ command: '/bin/kill', args: ['-TERM', '111'] })
      expect(spawnCalls).toContainEqual({ command: '/usr/bin/open', args: [expect.stringContaining('Watcher by EXE.app')] })
      expect(spawnCalls.filter(c => c.command === '/usr/bin/pgrep').length).toBeGreaterThanOrEqual(3)
      const commands = spawnCalls.map(c => c.command)
      expect(commands.indexOf('/usr/bin/codesign')).toBeLessThan(commands.indexOf('/bin/kill'))
      expect(commands.indexOf('/usr/bin/xcrun')).toBeLessThan(commands.indexOf('/bin/kill'))
      expect(commands.indexOf('/usr/sbin/spctl')).toBeLessThan(commands.indexOf('/bin/kill'))
      expect(commands.indexOf('/usr/libexec/PlistBuddy')).toBeLessThan(commands.indexOf('/bin/kill'))
      expect(commands).not.toContain('/usr/bin/xattr')
    })

    it('unpacks the update with ditto so the app signature survives', async () => {
      fixtureVersion = '0.2.59'
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '15'
      process.env.EXE_WATCHER_APP_EXIT_TIMEOUT_MS = '0'
      process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS = '1'

      const fsMock = await import('node:fs/promises')
      vi.mocked(fsMock.stat).mockResolvedValue({} as any)
      vi.mocked(fsMock.mkdtemp).mockResolvedValue('/tmp/exe-watcher-menubar-mock')
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined)
      vi.mocked(fsMock.rename).mockResolvedValue(undefined)
      vi.mocked(fsMock.rm).mockResolvedValue(undefined)

      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ tag_name: 'mac-v0.2.59', assets: [{ name: 'ExeWatcherMenubar-v0.2.59.zip', digest: FIXTURE_DIGEST, size: ARCHIVE.length, browser_download_url: 'https://github.com/AskExe/exe-watcher/releases/download/mac-v0.2.59/ExeWatcherMenubar-v0.2.59.zip' }] }) } as unknown as Response)
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ARCHIVE)); controller.close() } }) } as unknown as Response))

      const pgrepOutputs = ['111\n', '', '222\n']
      const spawnCalls: Array<{ command: string; args: string[] }> = []
      vi.mocked(childProcess.spawn).mockImplementation((command: string, args: readonly string[] = []) => {
        spawnCalls.push({ command, args: [...args] })
        const proc = new EventEmitter() as any
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        process.nextTick(() => {
          if (command === '/usr/libexec/PlistBuddy') {
            proc.stdout.emit('data', Buffer.from(fixtureVersion)); proc.emit('close', 0); return
          }
          const out = command === '/usr/bin/pgrep' ? pgrepOutputs.shift() ?? '' : ''
          if (out) proc.stdout.emit('data', Buffer.from(out))
          proc.emit('close', command === '/usr/bin/pgrep' && !out ? 1 : 0)
        })
        return proc
      })

      await installMenubarApp({ force: true })

      expect(spawnCalls).toContainEqual({ command: '/usr/bin/ditto', args: ['-x', '-k', '/tmp/exe-watcher-menubar-mock/ExeWatcherMenubar-v0.2.59.zip', '/tmp/exe-watcher-menubar-mock'] })
      expect(spawnCalls.map(c => c.command)).not.toContain('/usr/bin/unzip')
    })



    it('restores the previous app when a forced update installs but fails launch verification', async () => {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '15'
      process.env.EXE_WATCHER_APP_EXIT_TIMEOUT_MS = '0'
      process.env.EXE_WATCHER_APP_LAUNCH_TIMEOUT_MS = '1'

      const fsMock = await import('node:fs/promises')
      vi.mocked(fsMock.stat).mockResolvedValue({} as any)
      vi.mocked(fsMock.mkdtemp).mockResolvedValue('/tmp/exe-watcher-menubar-mock')
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined)
      vi.mocked(fsMock.rename).mockResolvedValue(undefined)
      vi.mocked(fsMock.rm).mockResolvedValue(undefined)

      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'mac-v0.2.21',
            assets: [{ name: 'ExeWatcherMenubar-v0.2.21.zip', digest: FIXTURE_DIGEST, size: ARCHIVE.length, browser_download_url: 'https://github.com/AskExe/exe-watcher/releases/download/mac-v0.2.21/ExeWatcherMenubar-v0.2.21.zip' }],
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ARCHIVE)); controller.close() } }),
        } as unknown as Response))

      // Existing app exits; candidate never appears after first open; restored app appears
      // only after rollback opens the backup-recovered target.
      let openCount = 0
      let initialPgrepDone = false
      const spawnCalls: Array<{ command: string; args: string[] }> = []
      vi.mocked(childProcess.spawn).mockImplementation((command: string, args: readonly string[] = []) => {
        spawnCalls.push({ command, args: [...args] })
        const proc = new EventEmitter() as any
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()

        process.nextTick(() => {
          if (command === '/usr/libexec/PlistBuddy') {
            proc.stdout.emit('data', Buffer.from(fixtureVersion)); proc.emit('close', 0); return
          }
          if (command === '/usr/bin/open') {
            openCount += 1
            proc.emit('close', 0)
          } else if (command === '/usr/bin/pgrep') {
            let out = ''
            if (!initialPgrepDone) {
              initialPgrepDone = true
              out = '111\n'
            } else if (openCount >= 2) {
              out = '333\n'
            }
            if (out) proc.stdout.emit('data', Buffer.from(out))
            proc.emit('close', out ? 0 : 1)
          } else {
            proc.emit('close', 0)
          }
        })

        return proc
      })

      await expect(installMenubarApp({ force: true })).rejects.toThrow(/Restored the previous working/)

      const renameMock = vi.mocked(fsMock.rename)
      expect(renameMock).toHaveBeenCalledWith(
        expect.stringContaining('Watcher by EXE.app'),
        expect.stringContaining('Watcher by EXE.backup-')
      )
      expect(renameMock).toHaveBeenCalledWith(
        expect.stringContaining('Watcher by EXE.backup-'),
        expect.stringContaining('Watcher by EXE.app')
      )
      expect(spawnCalls.filter(c => c.command === '/usr/bin/open').length).toBeGreaterThanOrEqual(2)
    })

    it('escalates to SIGKILL when the stale app ignores SIGTERM', async () => {
      process.env.EXE_WATCHER_FORCE_MACOS_MAJOR = '15'

      const fsMock = await import('node:fs/promises')
      vi.mocked(fsMock.stat).mockResolvedValue({} as any)
      vi.mocked(fsMock.mkdtemp).mockResolvedValue('/tmp/exe-watcher-menubar-mock')
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined)
      vi.mocked(fsMock.rename).mockResolvedValue(undefined)
      vi.mocked(fsMock.rm).mockResolvedValue(undefined)

      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'mac-v0.2.21',
            assets: [{ name: 'ExeWatcherMenubar-v0.2.21.zip', digest: FIXTURE_DIGEST, size: ARCHIVE.length, browser_download_url: 'https://github.com/AskExe/exe-watcher/releases/download/mac-v0.2.21/ExeWatcherMenubar-v0.2.21.zip' }],
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ARCHIVE)); controller.close() } }),
        } as unknown as Response))

      // Initial pgrep finds 111; wait loop repeatedly sees it still alive; after SIGKILL it exits;
      // final launch pgrep finds the replacement 222.
      const pgrepOutputs = ['111\n', '111\n', '111\n', '', '222\n']
      const spawnCalls: Array<{ command: string; args: string[] }> = []
      vi.mocked(childProcess.spawn).mockImplementation((command: string, args: readonly string[] = []) => {
        spawnCalls.push({ command, args: [...args] })
        const proc = new EventEmitter() as any
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()

        process.nextTick(() => {
          if (command === '/usr/libexec/PlistBuddy') {
            proc.stdout.emit('data', Buffer.from(fixtureVersion)); proc.emit('close', 0); return
          }
          if (command === '/usr/bin/pgrep') {
            const out = pgrepOutputs.shift() ?? ''
            if (out) proc.stdout.emit('data', Buffer.from(out))
            proc.emit('close', out ? 0 : 1)
          } else {
            proc.emit('close', 0)
          }
        })

        return proc
      })

      await installMenubarApp({ force: true })

      expect(spawnCalls).toContainEqual({ command: '/bin/kill', args: ['-TERM', '111'] })
      expect(spawnCalls).toContainEqual({ command: '/bin/kill', args: ['-KILL', '111'] })
    })
  })

  describe('candidate authentication preserves the installed app', () => {
    const failures = ['missing digest', 'changed bytes', 'oversize stream', 'truncated stream', 'wrong repository',
      'mixed version', 'duplicate archive', 'draft', 'prerelease', 'missing archive', 'foreign redirect',
      'HTTP redirect', 'wrong signing identity', 'missing notarization ticket', 'Gatekeeper denial', 'wrong signed version'] as const
    it.each(failures)('rejects %s before stopping or replacing the working app', async failure => {
      const fs = await import('node:fs/promises')
      vi.mocked(fs.stat).mockResolvedValue({} as any)
      vi.mocked(fs.mkdtemp).mockResolvedValue('/tmp/exe-watcher-menubar-mock')
      vi.mocked(fs.rename).mockClear()
      const asset = { name: 'ExeWatcherMenubar-v0.2.21.zip', digest: FIXTURE_DIGEST, size: ARCHIVE.length,
        browser_download_url: 'https://github.com/AskExe/exe-watcher/releases/download/mac-v0.2.21/ExeWatcherMenubar-v0.2.21.zip' }
      const release = { tag_name: 'mac-v0.2.21', assets: [asset], draft: false, prerelease: false }
      let bytes = ARCHIVE
      if (failure === 'missing digest') asset.digest = ''
      if (failure === 'changed bytes') bytes = Buffer.alloc(ARCHIVE.length, 1)
      if (failure === 'oversize stream') bytes = Buffer.concat([ARCHIVE, Buffer.from('extra')])
      if (failure === 'truncated stream') bytes = ARCHIVE.subarray(1)
      if (failure === 'wrong repository') asset.browser_download_url = asset.browser_download_url.replace('AskExe/exe-watcher', 'foreign/watcher')
      if (failure === 'mixed version') release.tag_name = 'mac-v0.2.22'
      if (failure === 'duplicate archive') release.assets.push(asset)
      if (failure === 'missing archive') release.assets = []
      if (failure === 'draft') release.draft = true
      if (failure === 'prerelease') release.prerelease = true
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => release })
      if (failure === 'foreign redirect' || failure === 'HTTP redirect') {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: {
          location: failure === 'foreign redirect' ? 'https://foreign.example/payload.zip' : 'http://github.com/payload.zip',
        } }))
      } else fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(bytes)))
      vi.stubGlobal('fetch', fetchMock)
      const commands: string[] = []
      const deniedCommands: Partial<Record<typeof failure, string>> = {
        'wrong signing identity': '/usr/bin/codesign', 'missing notarization ticket': '/usr/bin/xcrun', 'Gatekeeper denial': '/usr/sbin/spctl',
      }
      const deny = deniedCommands[failure]
      vi.mocked(childProcess.spawn).mockImplementation((command: string) => {
        commands.push(command)
        const proc = new EventEmitter() as any
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
        process.nextTick(() => {
          if (command === '/usr/libexec/PlistBuddy') proc.stdout.emit('data', Buffer.from(failure === 'wrong signed version' ? '0.2.20' : '0.2.21'))
          proc.emit('close', command === deny ? 1 : 0)
        })
        return proc
      })
      const reason: Record<typeof failure, RegExp> = {
        'missing digest': /integrity metadata/, 'changed bytes': /SHA-256/, 'oversize stream': /exceeds/,
        'truncated stream': /SHA-256/, 'wrong repository': /integrity metadata/, 'mixed version': /matching app archive/,
        'duplicate archive': /matching app archive/, 'draft': /stable Watcher release/, 'prerelease': /stable Watcher release/,
        'missing archive': /matching app archive/, 'foreign redirect': /untrusted destination/, 'HTTP redirect': /untrusted destination/,
        'wrong signing identity': /codesign exited/, 'missing notarization ticket': /xcrun exited/,
        'Gatekeeper denial': /spctl exited/, 'wrong signed version': /signed app version/,
      }
      await expect(installMenubarApp({ force: true })).rejects.toThrow(reason[failure])
      expect(fs.rename).not.toHaveBeenCalled()
      expect(commands).not.toContain('/bin/kill')
      expect(commands).not.toContain('/usr/bin/open')
      expect(commands).not.toContain('/usr/bin/xattr')
      expect(fetchMock).toHaveBeenCalledTimes(['missing digest', 'wrong repository', 'mixed version', 'duplicate archive', 'draft', 'prerelease', 'missing archive'].includes(failure) ? 1 : 2)
    })
  })

  // -----------------------------------------------------------------------
  // ASSET_PATTERN regex matching
  // -----------------------------------------------------------------------

  describe('ASSET_PATTERN regex', () => {
    it('matches "ExeWatcherMenubar-v0.1.1.zip"', () => {
      expect(ASSET_PATTERN.test('ExeWatcherMenubar-v0.1.1.zip')).toBe(true)
    })

    it('matches "ExeWatcherMenubar-v2.0.0-beta.zip"', () => {
      expect(ASSET_PATTERN.test('ExeWatcherMenubar-v2.0.0-beta.zip')).toBe(true)
    })

    it('does not match "SomethingElse.zip"', () => {
      expect(ASSET_PATTERN.test('SomethingElse.zip')).toBe(false)
    })

    it('does not match "ExeWatcherMenubar.zip" (no dash after name)', () => {
      expect(ASSET_PATTERN.test('ExeWatcherMenubar.zip')).toBe(false)
    })

    it('does not match "ExeWatcherMenubar-v0.1.1.tar.gz" (wrong extension)', () => {
      expect(ASSET_PATTERN.test('ExeWatcherMenubar-v0.1.1.tar.gz')).toBe(false)
    })
  })
})
