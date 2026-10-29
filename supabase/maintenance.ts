export interface MaintenancePorts {
  /** Same-project Auth trigger already queues deletion; this catches soft-deleted/orphaned rows. */
  queueDeletedAccounts(): Promise<number>
  queueAbandoned(): Promise<void>
  pendingObjects(): Promise<string[]>
  removeObjects(paths: string[]): Promise<void>
  acknowledgeObjects(paths: string[]): Promise<void>
}

/** Only the Storage API removes ciphertext; failed removals remain durably queued. */
export async function runMaintenance(ports: MaintenancePorts): Promise<{ purgedAccounts: number; removedObjects: number }> {
  const purgedAccounts = await ports.queueDeletedAccounts()
  if (!Number.isSafeInteger(purgedAccounts) || purgedAccounts < 0 || purgedAccounts > 100) throw new Error('Invalid Watcher deletion sweep')
  await ports.queueAbandoned()
  let removedObjects = 0
  for (let i = 0; i < 10; i++) {
    const paths = await ports.pendingObjects()
    if (!paths.length) break
    if (paths.length > 100 || !paths.every(p => /^watcher\/[0-9a-f-]{36}\/[1-9][0-9]{0,15}[.]blob$/.test(p))) throw new Error('Invalid Watcher cleanup queue')
    await ports.removeObjects(paths)
    await ports.acknowledgeObjects(paths)
    removedObjects += paths.length
  }
  return { purgedAccounts, removedObjects }
}
