/** Stop a native-owned CLI if the app exits before it can cancel/reap its child.
 * Only enable for a verified direct parent; interactive CLI commands are unaffected.
 */
type ParentWatch = { parent: () => number; checkAlive: (pid: number) => void; exit: () => void }
const live: ParentWatch = { parent: () => process.ppid, checkAlive: pid => { process.kill(pid, 0) }, exit: () => { process.exit(1) } }
export function watchMenubarParent(parentPid: number, runtime: ParentWatch = live): () => void {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || runtime.parent() !== parentPid) return () => {}
  const timer = setInterval(() => {
    if (runtime.parent() !== parentPid) { runtime.exit(); return }
    try { runtime.checkAlive(parentPid) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') runtime.exit() }
  }, 2000)
  timer.unref()
  return () => clearInterval(timer)
}
