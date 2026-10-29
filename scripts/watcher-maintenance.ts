/** Protected server/CI entry point. This does not create a timer or use local user credentials. */
import { createClient } from '@supabase/supabase-js'
import { runMaintenance } from '../supabase/maintenance.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error('Missing protected Watcher maintenance configuration')
  return value
}
async function main() {
  const ref = required('WATCHER_PROJECT_REF')
  if (ref !== 'vjiexzktmduoguxvleiy') throw new Error('Maintenance must bind the configured shared Odd project')
  const url = `https://${ref}.supabase.co`
  const secret = required('WATCHER_SERVICE_SECRET')
  if (!secret.startsWith('sb_secret_')) throw new Error('Use a protected new-style Watcher service key')
  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) } })
  async function rpc(name: string, args?: Record<string, unknown>) {
    const { data, error } = await admin.rpc(name, args)
    if (error) throw new Error('Watcher maintenance operation failed')
    return data
  }
  const result = await runMaintenance({
    queueDeletedAccounts: async () => await rpc('watcher_sweep_deleted_accounts') as number,
    queueAbandoned: async () => { await rpc('watcher_queue_abandoned') },
    pendingObjects: async () => {
      const rows = await rpc('watcher_gc_batch')
      if (!Array.isArray(rows)) throw new Error('Invalid Watcher cleanup response')
      return rows.map(row => row.path)
    },
    removeObjects: async paths => {
      const { error } = await admin.storage.from('watcher-history').remove(paths)
      if (error) throw new Error('Watcher object cleanup failed')
    },
    acknowledgeObjects: async paths => { await rpc('watcher_gc_done', { p_paths: paths }) },
  })
  console.log(JSON.stringify({ ok: true, ...result }))
}
main().catch(() => { console.error('Watcher maintenance failed; existing cleanup progress was preserved.'); process.exitCode = 1 })
