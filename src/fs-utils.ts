import { chargeRead, checkFileSize, ResourceBudgetError } from './resource-budget.js'
import { open } from 'fs/promises'
import { statSync, openSync, fstatSync, readSync, closeSync, constants } from 'fs'

// Hard cap well below V8's 512 MB string limit even with split('\n') doubling.
// Stream threshold chosen as empirical breakeven between readFile+split peak
// memory and createReadStream+readline overhead for typical session files.
export const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024
export const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024

function verbose(): boolean {
  return process.env.EXE_WATCHER_VERBOSE === '1'
}

function warn(msg: string): void {
  if (verbose()) process.stderr.write(`exe-watcher: ${msg}\n`)
}

/** Read only the metadata header during discovery, never the transcript body.
 * Bounded even for malformed files without a newline; close on every exit path.
 */
export async function readSessionFirstLine(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return null
  try {
    // Bound the header independently of transcript size: large files are streamed later.
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    const maxHeaderBytes = 8 * 1024 * 1024
    while (offset < maxHeaderBytes) {
      const length = Math.min(offset === 0 ? 4096 : buffer.length, maxHeaderBytes - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      chargeRead(bytesRead)
      if (bytesRead === 0) return Buffer.concat(chunks).toString('utf-8').replace(/\r$/, '')
      const chunk = buffer.subarray(0, bytesRead)
      const newline = chunk.indexOf(10)
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf-8').replace(/\r$/, '')
      }
      chunks.push(Buffer.from(chunk))
      offset += bytesRead
    }
    if (!checkFileSize(offset + 1, maxHeaderBytes)) return null
    return null
  } catch (err) {
    if (err instanceof ResourceBudgetError) throw err
    warn(`header read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  } finally {
    await handle.close()
  }
}

export async function readSessionFile(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return null
  try {
    const size = (await handle.stat()).size
    if (!checkFileSize(size, MAX_SESSION_FILE_BYTES)) {
      warn(`skipped oversize file ${filePath}`)
      return null
    }
    chargeRead(size)
    // Read a fixed snapshot. Appends after fstat are left for the next refresh.
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, size - offset), offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return buffer.toString('utf-8', 0, offset)
  } catch (err) {
    if (err instanceof ResourceBudgetError) throw err
    warn(`read failed for ${filePath}`)
    return null
  } finally { await handle.close() }
}

export function readSessionFileSync(filePath: string): string | null {
  // Use O_NOFOLLOW to avoid TOCTOU symlink swaps between stat and read.
  // Falls back to plain readFileSync on platforms that lack O_NOFOLLOW.
  const O_NOFOLLOW = (constants as Record<string, number>)['O_NOFOLLOW'] ?? 0
  let fd: number
  try {
    fd = openSync(filePath, constants.O_RDONLY | O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    // ELOOP = tried to open a symlink with O_NOFOLLOW — skip it
    if (code === 'ELOOP') { warn(`skipped symlink ${filePath}`); return null }
    warn(`open failed for ${filePath}: ${code}`)
    return null
  }

  try {
    const size = fstatSync(fd).size
    if (!checkFileSize(size, MAX_SESSION_FILE_BYTES)) {
      warn(`skipped oversize file ${filePath} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
      return null
    }
    chargeRead(size)
    const buf = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = readSync(fd, buf, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buf.toString('utf-8', 0, offset)
  } catch (err) {
    if (err instanceof ResourceBudgetError) throw err
    warn(`read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  } finally {
    closeSync(fd)
  }
}

export async function* readSessionLines(filePath: string, startByte = 0): AsyncGenerator<string> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return
  try {
    const size = (await handle.stat()).size
    if (size <= startByte) return
    // Streaming supports large transcripts without allocating the whole file.
    chargeRead(size - startByte)
    const stream = handle.createReadStream({ encoding: 'utf-8', start: startByte, end: size - 1, autoClose: false })
    let pieces: string[] = []
    let lineBytes = 0
    const maxLineBytes = 32 * 1024 * 1024
    const append = (piece: string) => {
      lineBytes += Buffer.byteLength(piece)
      if (lineBytes > maxLineBytes) throw new ResourceBudgetError('32 MiB JSONL record budget')
      pieces.push(piece)
    }
    try {
      for await (const chunk of stream) {
        let start = 0
        let newline: number
        while ((newline = chunk.indexOf('\n', start)) >= 0) {
          append(chunk.slice(start, newline))
          chargeRead(0)
          const line = pieces.join('').replace(/\r$/, '')
          pieces = []; lineBytes = 0
          yield line
          start = newline + 1
        }
        if (start < chunk.length) append(chunk.slice(start))
      }
      if (pieces.length) yield pieces.join('').replace(/\r$/, '')
    } finally { stream.destroy() }
  } catch (err) {
    if (err instanceof ResourceBudgetError) throw err
    warn(`stream read failed for ${filePath}`)
  } finally { await handle.close() }
}
