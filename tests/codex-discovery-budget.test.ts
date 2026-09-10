import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCodexProvider } from '../src/providers/codex.js'
import { MAX_SESSION_FILE_BYTES, readSessionFirstLine, readSessionFile } from '../src/fs-utils.js'

vi.mock('../src/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs-utils.js')>()
  return { ...actual, readSessionFile: vi.fn(actual.readSessionFile) }
})

let dir: string
async function fixture(header: string, size?: number) {
  dir = await mkdtemp(join(tmpdir(), 'watcher-header-'))
  const day = join(dir, 'sessions/2026/09/10')
  await mkdir(day, { recursive: true })
  const path = join(day, 'rollout-test.jsonl')
  await writeFile(path, header)
  if (size) {
    const handle = await open(path, 'r+')
    await handle.truncate(size)
    await handle.close()
  }
  return path
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  if (dir) await rm(dir, { recursive: true, force: true })
})

it('discovers a large transcript using only one 4KB header read', async () => {
  const header = JSON.stringify({ type: 'session_meta', payload: { originator: 'codex_cli_rs', cwd: '/work/project' } })
  const path = await fixture(header + '\n', 64 * 1024 * 1024)
  const handle = await open(path, 'r')
  const read = vi.spyOn(Object.getPrototypeOf(handle), 'read')
  try {
    expect(await createCodexProvider(dir).discoverSessions()).toEqual([
      { path, project: 'work-project', provider: 'codex' },
    ])
    expect(readSessionFile).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[2]).toBe(4096)
  } finally { await handle.close() }
})

it('handles UTF-8 headers across chunks, CRLF, and EOF without a newline', async () => {
  const header = 'x'.repeat(4095) + '猫'
  const path = await fixture(header + '\r\nbody')
  expect(await readSessionFirstLine(path)).toBe(header)
  await writeFile(path, header)
  expect(await readSessionFirstLine(path)).toBe(header)
})

it('bounds malformed headers and tolerates missing and empty files', async () => {
  const path = await fixture('invalid', MAX_SESSION_FILE_BYTES + 1)
  expect(await readSessionFirstLine(path)).toBeNull()
  expect(await createCodexProvider(dir).discoverSessions()).toEqual([])
  await writeFile(path, '')
  expect(await readSessionFirstLine(path)).toBe('')
  expect(await readSessionFirstLine(path + '.missing')).toBeNull()
})

it('preserves sessions with multi-megabyte instruction headers', async () => {
  const header = JSON.stringify({ type: 'session_meta', payload: {
    originator: 'codex_cli_rs', cwd: '/work/project', instructions: 'x'.repeat(2 * 1024 * 1024),
  } })
  const path = await fixture(header + '\nbody')
  expect(await readSessionFirstLine(path)).toBe(header)
  expect(await createCodexProvider(dir).discoverSessions()).toHaveLength(1)
})
