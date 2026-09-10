import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Cross-process lease. Dead owners are reclaimed under a separate exclusive reaper lock. */
export async function acquireFileLock(path: string, timeoutMs = 15_000): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true })
  const token = `${process.pid}:${Date.now()}:${Math.random()}`
  const started = Date.now()
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(token)
      await handle.close()
      return async () => { if (await readFile(path, 'utf8').catch(() => '') === token) await unlink(path).catch(() => {}) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const reaperPath = `${path}.reaper`
    const reaper = await open(reaperPath, 'wx', 0o600).catch(() => null)
    if (reaper) {
      try {
        await reaper.writeFile(token)
        const owner = await readFile(path, 'utf8').catch(() => '')
        const pid = Number(owner.split(':')[0])
        let dead = false
        if (pid > 0) {
          try { process.kill(pid, 0) } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH' }
        } else {
          // Allow the winner to finish writing its token before treating an empty lease as orphaned.
          const s = await stat(path).catch(() => null)
          dead = !!s && Date.now() - s.mtimeMs > 5000
        }
        if (dead) await unlink(path).catch(() => {})
      } finally { await reaper.close(); await unlink(reaperPath).catch(() => {}) }
    } else {
      // A process may die while reaping. Recover that short-lived mutex too.
      const owner = await readFile(reaperPath, 'utf8').catch(() => '')
      const pid = Number(owner.split(':')[0])
      let dead = false
      if (pid > 0) {
        try { process.kill(pid, 0) } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH' }
      } else {
        const s = await stat(reaperPath).catch(() => null)
        dead = !!s && Date.now() - s.mtimeMs > 5000
      }
      if (dead && await readFile(reaperPath, 'utf8').catch(() => '') === owner) await unlink(reaperPath).catch(() => {})
    }
    if (Date.now() - started >= timeoutMs) throw new Error('Another Watcher scan is still running. Keeping the last successful refresh.')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
