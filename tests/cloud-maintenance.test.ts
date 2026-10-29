import { describe, expect, it, vi } from 'vitest'
import { runMaintenance, type MaintenancePorts } from '../supabase/maintenance.js'

const id = '10000000-0000-4000-8000-000000000001'
function setup() {
  const path = `watcher/${id}/1.blob`
  let pending = [path]
  const ports: MaintenancePorts = {
    queueDeletedAccounts: vi.fn(async () => 1), queueAbandoned: vi.fn(async () => {}), pendingObjects: vi.fn(async () => pending),
    removeObjects: vi.fn(async () => {}), acknowledgeObjects: vi.fn(async () => { pending = [] }),
  }
  return { ports, path }
}
describe('shared Odd deletion and Watcher ciphertext retention', () => {
  it('sweeps deleted owners and acknowledges only successful Storage API deletion', async () => {
    const x = setup()
    expect(await runMaintenance(x.ports)).toEqual({ purgedAccounts: 1, removedObjects: 1 })
    expect(x.ports.queueDeletedAccounts).toHaveBeenCalledOnce()
    expect(x.ports.removeObjects).toHaveBeenCalledWith([x.path])
    expect(x.ports.acknowledgeObjects).toHaveBeenCalledWith([x.path])
  })
  it.each([-1, 1.5, 101, NaN])('rejects an invalid sweep count %s before deleting objects', async count => {
    const x = setup(); x.ports.queueDeletedAccounts = async () => count
    await expect(runMaintenance(x.ports)).rejects.toThrow('deletion sweep')
    expect(x.ports.removeObjects).not.toHaveBeenCalled()
  })
  it('leaves failed cleanup queued', async () => {
    const x = setup(); x.ports.removeObjects = vi.fn(async () => { throw new Error('Storage offline') })
    await expect(runMaintenance(x.ports)).rejects.toThrow('Storage offline')
    expect(x.ports.acknowledgeObjects).not.toHaveBeenCalled()
  })
  it('refuses a cleanup path outside Watcher', async () => {
    const x = setup(); x.ports.pendingObjects = async () => [`qg/${id}/1.blob`]
    await expect(runMaintenance(x.ports)).rejects.toThrow('cleanup queue')
    expect(x.ports.removeObjects).not.toHaveBeenCalled()
  })
  it('bounds a run without acknowledging objects beyond the attempted batches', async () => {
    const x = setup(); x.ports.pendingObjects = async () => [x.path]
    const result = await runMaintenance(x.ports)
    expect(result.removedObjects).toBe(10)
    expect(x.ports.removeObjects).toHaveBeenCalledTimes(10)
    expect(x.ports.acknowledgeObjects).toHaveBeenCalledTimes(10)
  })
})
