import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OptimizeResult } from '../src/optimize.js'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:crypto', () => ({ randomUUID: () => '12345678-1234-1234-1234-123456789abc' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: vi.fn(actual.homedir) }
})
import { copyOptimizeMarkdown, formatOptimizeMarkdown, saveOptimizeMarkdown } from '../src/optimize-share.js'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platformDescriptor); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })
const result: OptimizeResult = {
  healthGrade: 'D', healthScore: 45, costRate: 0.00001,
  coverage: { completedFiles: 2, totalFiles: 99, partial: true },
  findings: [
    { title: 'Read less', impact: 'high', tokensSaved: 1000, explanation: 'Repeated reads across projects.', fix: { type: 'paste', label: 'Tell Claude:', text: 'Read this once.\nKeep the result.' } },
    { title: 'Cap output', impact: 'medium', tokensSaved: 500, explanation: 'Output is too large.', fix: { type: 'command', label: 'Add to your shell:', text: 'export LIMIT=1000\necho "$(never-run)"' } },
    { title: 'Trim config', impact: 'low', tokensSaved: 250, trend: 'improving', explanation: 'A large config.', fix: { type: 'file-content', label: 'Suggested contents:', path: '/project/CLAUDE.md', content: '# Rules\n```text\nKeep this fence\n```\n' } },
  ],
}

it('exports every complete fix with period, estimates and partial warnings, without a misleading grade', () => {
  const markdown = formatOptimizeMarkdown(result, { periodLabel: '7 Days', projectFilter: ['app'], excludeFilter: ['other'] })
  expect(markdown).toContain('Period: 7 Days')
  expect(markdown).toContain('Provider: Claude Code')
  expect(markdown).toContain('Included projects: app')
  expect(markdown).toContain('Excluded projects: other')
  expect(markdown).toContain('Partial analysis: 2/99 logs fully checked')
  expect(markdown).not.toContain('Setup health:')
  expect(markdown).toContain('Token and cost savings are estimates')
  for (const finding of result.findings) {
    expect(markdown).toContain(finding.title)
    expect(markdown).toContain(finding.fix.type === 'file-content' ? finding.fix.content : finding.fix.text)
  }
  expect(markdown).toContain('/project/CLAUDE.md')
  expect(markdown).toContain('````text\n# Rules\n```text')
  expect(markdown).not.toContain('\x1b')
})

it('distinguishes empty partial results from a complete check', () => {
  expect(formatOptimizeMarkdown({ ...result, findings: [] }, { periodLabel: 'Today' })).toContain('unchecked history is unknown')
  const full = formatOptimizeMarkdown({ ...result, findings: [], coverage: undefined }, { periodLabel: 'Today' })
  expect(full).toContain('Setup health: D (45/100)')
  expect(full).toContain('No recommendations found for this period')
})

it('creates a private Markdown file and refuses both existing files and symlinks', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'))
  const directory = await mkdtemp(join(tmpdir(), 'watcher-optimize-share-'))
  try {
    const markdown = formatOptimizeMarkdown(result, { periodLabel: 'Today' })
    const path = await saveOptimizeMarkdown(markdown, directory)
    expect(path).toMatch(/\.md$/)
    expect(await readFile(path, 'utf8')).toBe(markdown)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(saveOptimizeMarkdown('overwrite', directory)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path, 'utf8')).toBe(markdown)
    await rm(path)
    const target = join(directory, 'keep.txt')
    await writeFile(target, 'keep this')
    await symlink(target, path)
    await expect(saveOptimizeMarkdown('overwrite', directory)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('keep this')
    expect(await readdir(directory)).toHaveLength(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('saves to Downloads when available and otherwise to the current folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watcher-optimize-location-'))
  vi.mocked(homedir).mockReturnValueOnce(directory).mockReturnValueOnce(directory)
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  try {
    expect(await saveOptimizeMarkdown('fallback')).toMatch(new RegExp(`^${directory}/exe-watcher-optimizer-`))
    await mkdir(join(directory, 'Downloads'))
    const downloaded = await saveOptimizeMarkdown('download')
    expect(downloaded).toContain(join(directory, 'Downloads') + '/')
    expect(await readFile(downloaded, 'utf8')).toBe('download')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: vi.fn() })
}

describe('system clipboard', () => {
  it('pipes the full document to the fixed Mac clipboard command without executing its contents', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = child()
    let input = ''
    proc.stdin.on('data', chunk => { input += chunk.toString() })
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)
    const markdown = 'User text: $(never-run) `also-never-run`\nUnicode: ≈'
    const copying = copyOptimizeMarkdown(markdown)
    expect(spawn).toHaveBeenCalledWith('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    proc.emit('close', 0)
    await copying
    expect(input).toBe(markdown)
  })

  it('falls back from an unavailable Wayland clipboard to X11', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const wayland = child(), x11 = child()
    vi.mocked(spawn).mockReturnValueOnce(wayland as unknown as ReturnType<typeof spawn>).mockReturnValueOnce(x11 as unknown as ReturnType<typeof spawn>)
    const copying = copyOptimizeMarkdown('fixes')
    wayland.emit('error', new Error('ENOENT'))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    x11.emit('close', 0)
    await copying
    expect(spawn).toHaveBeenLastCalledWith('xclip', ['-selection', 'clipboard'], expect.anything())
  })

  it('preserves Unicode with the Windows clipboard', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = child(), chunks: Buffer[] = []
    proc.stdin.on('data', chunk => { chunks.push(chunk) })
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)
    const copying = copyOptimizeMarkdown('≈ Read once → edit')
    proc.emit('close', 0)
    await copying
    const input = Buffer.concat(chunks)
    expect(input.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(input.subarray(2).toString('utf16le')).toBe('≈ Read once → edit')
  })

  it('kills a stuck clipboard after three seconds and offers file export', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = child()
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)
    const copying = expect(copyOptimizeMarkdown('fixes')).rejects.toThrow('Press e to save a Markdown file')
    await vi.advanceTimersByTimeAsync(3000)
    await copying
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
