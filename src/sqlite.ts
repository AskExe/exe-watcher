import { chargeRead, ResourceBudgetError } from './resource-budget.js'
import { createRequire } from 'node:module'

/// Thin SQLite read-only wrapper over Node's built-in `node:sqlite` module (stable in
/// Node 24, experimental in Node 22 / 23). Replaces the earlier `better-sqlite3` binding
/// so the dependency graph no longer pulls in the deprecated `prebuild-install` package
/// (issue #75). Works across Cursor and OpenCode session DBs, both of which we only read.

const requireForSqlite = createRequire(import.meta.url)

type Row = Record<string, unknown>

export type SqliteDatabase = {
  query<T extends Row = Row>(sql: string, params?: unknown[]): T[]
  close(): void
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => {
  prepare(sql: string): { all(...params: unknown[]): Row[]; iterate(...params: unknown[]): Iterable<Row> }
  close(): void
}

let DatabaseSync: DatabaseSyncCtor | null = null
let loadAttempted = false
let loadError: string | null = null

/// Lazily imports `node:sqlite`. On Node 22/23 it emits an ExperimentalWarning the first
/// time the module is loaded; we silence that specific warning once so dashboards aren't
/// preceded by a scary stderr line every run. Any other warnings (including future
/// non-SQLite ones) are left untouched.
function loadDriver(): boolean {
  if (loadAttempted) return DatabaseSync !== null
  loadAttempted = true

  const origEmit = process.emit.bind(process)
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    process.emit = origEmit
  }

  // Node's `process.emit` signature is overloaded; we intercept the 'warning' channel
  // only and proxy everything else through unchanged. The `any` cast avoids chasing the
  // overload union which isn't worth its verbosity for a single-purpose shim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.emit = function patchedEmit(this: NodeJS.Process, event: string, ...args: any[]): boolean {
    if (event === 'warning') {
      const warning = args[0] as { name?: string; message?: string } | undefined
      if (
        warning?.name === 'ExperimentalWarning' &&
        typeof warning.message === 'string' &&
        /SQLite/i.test(warning.message)
      ) {
        return false
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origEmit as any).call(this, event, ...args)
  } as typeof process.emit

  try {
    const mod = requireForSqlite('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
    DatabaseSync = mod.DatabaseSync
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    loadError =
      'SQLite-based providers (Cursor, OpenCode) need Node 22+ with the node:sqlite module.\n' +
      `Current Node: ${process.version}.\n` +
      'Upgrade Node (https://nodejs.org) and run exe-watcher again.\n' +
      `(underlying error: ${message})`
    return false
  } finally {
    // The ExperimentalWarning fires on the next microtask after require(), not synchronously.
    // Defer restore so the shim is still active when the warning actually emits.
    setTimeout(restore, 0)
  }
}

export function isSqliteAvailable(): boolean {
  return loadDriver()
}

export function getSqliteLoadError(): string {
  return loadError ?? 'SQLite driver not available'
}

export function openDatabase(path: string): SqliteDatabase {
  if (!loadDriver() || DatabaseSync === null) {
    throw new Error(getSqliteLoadError())
  }

  const db = new DatabaseSync(path, { readOnly: true })

  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
      const rows: T[] = []
      let bytes = 0
      for (const row of db.prepare(sql).iterate(...params)) {
        const size = Buffer.byteLength(JSON.stringify(row))
        bytes += size
        if (rows.length >= 100_000 || bytes > 32 * 1024 * 1024) throw new ResourceBudgetError('SQLite result budget')
        chargeRead(size)
        rows.push(row as T)
      }
      return rows
    },
    close() {
      db.close()
    },
  }
}
