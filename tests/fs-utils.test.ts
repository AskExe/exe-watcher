import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ResourceBudgetError, withScanBudget } from '../src/resource-budget.js'

import {
  MAX_SESSION_FILE_BYTES,
  STREAM_THRESHOLD_BYTES,
  readSessionFile,
  readSessionLines,
} from '../src/fs-utils.js'

describe('readSessionFile', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    delete process.env.EXE_WATCHER_VERBOSE
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function tmpPath(content: string | Buffer): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'exe-watcher-fs-'))
    tmpDirs.push(base)
    const p = join(base, 'x.jsonl')
    await writeFile(p, content)
    return p
  }

  it('returns content for small files via readFile fast path', async () => {
    const p = await tmpPath('hello\nworld\n')
    expect(await readSessionFile(p)).toBe('hello\nworld\n')
  })

  it('returns content for files at the stream threshold via stream path', async () => {
    const p = await tmpPath(Buffer.alloc(STREAM_THRESHOLD_BYTES, 'a'))
    const got = await readSessionFile(p)
    expect(got).not.toBeNull()
    expect(got!.length).toBe(STREAM_THRESHOLD_BYTES)
  })

  it('returns null and skips files over the cap', async () => {
    const p = await tmpPath(Buffer.alloc(MAX_SESSION_FILE_BYTES + 1, 'b'))
    expect(await readSessionFile(p)).toBeNull()
  })

  it('emits stderr warning under EXE_WATCHER_VERBOSE=1 for skipped file', async () => {
    process.env.EXE_WATCHER_VERBOSE = '1'
    const p = await tmpPath(Buffer.alloc(MAX_SESSION_FILE_BYTES + 1, 'c'))
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await readSessionFile(p)
    expect(spy).toHaveBeenCalled()
    const msg = (spy.mock.calls[0][0] as string)
    expect(msg).toContain('exe-watcher')
    expect(msg).toContain('oversize')
    spy.mockRestore()
  })

  it('returns null on stat failure without throwing', async () => {
    expect(await readSessionFile('/nonexistent/path/x.jsonl')).toBeNull()
  })
})

describe('readSessionLines', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function tmpPath(content: string): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'exe-watcher-lines-'))
    tmpDirs.push(base)
    const p = join(base, 'session.jsonl')
    await writeFile(p, content)
    return p
  }

  it('yields all lines from a file', async () => {
    const p = await tmpPath('line1\nline2\nline3\n')
    const lines: string[] = []
    for await (const line of readSessionLines(p)) lines.push(line)
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('does not leak file descriptors when generator is abandoned early', async () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n')
    const p = await tmpPath(content)
    const gen = readSessionLines(p)
    await gen.next()
    await gen.return(undefined)
  })

  it('resumes at completed UTF-8/CRLF records across a byte-budget interruption', async () => {
    const expected = ['🌏'.repeat(16382), '你好', 'done']
    const content = expected.join('\r\n') + '\r\n'
    const p = await tmpPath(content)
    const lines: string[] = []
    let offset = 0
    await expect(withScanBudget(async () => {
      for await (const line of readSessionLines(p, 0, undefined, next => { offset = next })) lines.push(line)
    }, 100, undefined, 65536)).rejects.toBeInstanceOf(ResourceBudgetError)
    expect(lines).toEqual(expected.slice(0, 1))
    expect(offset).toBe(Buffer.byteLength(expected[0]! + '\r\n'))
    await withScanBudget(async () => {
      for await (const line of readSessionLines(p, offset)) lines.push(line)
    }, 100, undefined, 65536)
    expect(lines).toEqual(expected)
  })

  it('does not advance a cursor for a record the consumer fails to process', async () => {
    const p = await tmpPath('first\nsecond\nthird\n')
    let offset = 0
    await expect((async () => {
      for await (const line of readSessionLines(p, 0, undefined, next => { offset = next })) {
        if (line === 'second') throw new ResourceBudgetError('fixture')
      }
    })()).rejects.toBeInstanceOf(ResourceBudgetError)
    expect(offset).toBe(Buffer.byteLength('first\n'))
  })
})
