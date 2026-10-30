import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'

let db: PGlite
const alice = '10000000-0000-4000-8000-000000000001', bob = '10000000-0000-4000-8000-000000000002'
const device = '20000000-0000-4000-8000-000000000001'
const claims = (id = alice, extra = {}) => ({ sub: id, iss: 'https://vjiexzktmduoguxvleiy.supabase.co/auth/v1', role: 'authenticated', session_id: id === bob ? '30000000-0000-4000-8000-000000000002' : '30000000-0000-4000-8000-000000000001', is_anonymous: false, email: 'fixture@example.test', ...extra })
async function asUser(id = alice, extra = {}) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims(id, extra))])
  await db.exec('set role authenticated')
}
function pointer(version: number, id = alice) {
  return { app_code: 'watcher', user_id: id, version, object_path: `watcher/${id}/${version}.blob`, crypto_version: 1,
    size_bytes: 100, part_paths: [`watcher/${id}/${version + 10000}.blob`] }
}
async function objects(version: number, id = alice) {
  await asUser(id)
  await db.query('select watcher_enable_backup()')
  for (const name of [pointer(version, id).object_path, ...pointer(version, id).part_paths]) {
    // Actual Storage: check the user INSERT in a rolled-back transaction, then
    // finalize the S3 upload under service_role with the authenticated owner.
    await asUser(id)
    await db.exec('begin')
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2) returning *', ['watcher-history', name])
    await db.exec('rollback; reset role')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })])
    await db.exec('set role service_role')
    await db.query('insert into storage.objects(bucket_id,name,owner,owner_id) values($1,$2,$3,$4) returning *', ['watcher-history', name,id,id])
  }
}
async function publish(value: unknown, expected: number) {
  return db.query('select public.watcher_publish_backup($1,$2::jsonb,$3) as ok', [device, JSON.stringify(value), expected])
}
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.sessions(id uuid primary key,user_id uuid);
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
    insert into auth.users(id,email_confirmed_at,is_anonymous) values('${alice}',now(),false),('${bob}',now(),false);
    insert into auth.sessions(id,user_id) values('30000000-0000-4000-8000-000000000001','${alice}'),('30000000-0000-4000-8000-000000000002','${bob}');
    create table public.apps(code text primary key,name text);
    create schema private;
    create table private.unrelated_secret(id integer);
    grant usage on schema private to authenticated;
    grant select on private.unrelated_secret to authenticated;
    create function auth.jwt() returns jsonb language sql stable as $$ select current_setting('request.jwt.claims',true)::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth,storage to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    -- Include actual hosted Storage owner fields: an omitted owner column hid a
    -- PL/pgSQL variable/column ambiguity in both upload admission and deletion.
    create table storage.objects(bucket_id text,name text,created_at timestamptz default now(),owner uuid,owner_id text,primary key(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
  `)
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(file, migrations), 'utf8'))
}, 30_000)
afterAll(async () => { await db?.close() })

it('defaults to disabled and fails closed for wrong issuer, anonymous and OAuth sessions', async () => {
  await asUser()
  expect((await db.query<{ owner: string | null }>('select watcher_private.watcher_owner() as owner')).rows[0]?.owner).toBeNull()
  await expect(db.query('select watcher_enable_backup()')).rejects.toThrow()
  await db.exec('reset role')
  await db.query("insert into watcher_private.watcher_qa_accounts(user_id,expires_at) values($1,now()+interval '1 hour')", [alice])
  await asUser(alice)
  expect((await db.query<{ owner: string }>('select watcher_private.watcher_owner() as owner')).rows[0]?.owner).toBe(alice)
  await asUser(bob)
  expect((await db.query<{ owner: string | null }>('select watcher_private.watcher_owner() as owner')).rows[0]?.owner).toBeNull()
  await expect(db.query("insert into watcher_private.watcher_qa_accounts(user_id,expires_at) values($1,now()+interval '1 hour')",[bob])).rejects.toThrow()
  await db.exec("reset role; update watcher_private.watcher_qa_accounts set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'")
  await asUser(alice)
  expect((await db.query<{ owner: string | null }>('select watcher_private.watcher_owner() as owner')).rows[0]?.owner).toBeNull()
  await db.exec('reset role; delete from watcher_private.watcher_qa_accounts; update watcher_private.watcher_settings set enabled=true')
  for (const extra of [{ iss: 'https://other-project.example' }, { is_anonymous: true }, { client_id: 'unregistered' }, { role: 'service_role' }, { email: '' }, { session_id: 'revoked-or-unrecognized' }]) {
    await asUser(alice, extra)
    expect((await db.query<{ owner: string | null }>('select watcher_private.watcher_owner() as owner')).rows[0]?.owner).toBeNull()
    await expect(db.query('select watcher_enable_backup()')).rejects.toThrow()
  }
})
it('requires consent, immutable owned objects, and compare-and-swap publication', async () => {
  await objects(1); await asUser(); await db.query('select watcher_pause_backup()')
  await expect(publish(pointer(1), 0)).rejects.toThrow()
  await db.query('select watcher_enable_backup()')
  await expect(publish(pointer(2), 0)).rejects.toThrow('Missing')
  expect((await publish(pointer(1), 0)).rows[0]).toEqual({ ok: true })
  await objects(2); await asUser()
  expect((await publish(pointer(2), 0)).rows[0]).toEqual({ ok: false })
  expect((await publish(pointer(2), 1)).rows[0]).toEqual({ ok: true })
  await expect(db.query('update watcher_backups set pointer=$1', [pointer(1)])).rejects.toThrow()
  await expect(db.query("update storage.objects set name='overwritten' where bucket_id='watcher-history'")).resolves.toMatchObject({ affectedRows: 0 })
})
it('rejects malformed pointer fields and another owner’s namespace', async () => {
  await objects(3); await asUser()
  for (const p of [{ ...pointer(3), user_id: bob }, { ...pointer(3), size_bytes: null }, { ...pointer(3), version: '3' },
    { ...pointer(3), extra: 'PRIVATE' }, { ...pointer(3), part_paths: [pointer(3).object_path] }, { ...pointer(3), object_path: `watcher/${bob}/3.blob` }]) {
    await expect(publish(p, 2)).rejects.toThrow()
  }
})
it('isolates all reads, uploads, publication, maintenance and deletion across accounts', async () => {
  await asUser(bob); await db.query('select watcher_enable_backup()')
  expect((await db.query('select device_id,pointer from watcher_backups')).rows).toEqual([])
  expect((await db.query('select name from storage.objects')).rows).toEqual([])
  await expect(db.query('insert into storage.objects values($1,$2)', ['watcher-history', `watcher/${alice}/99.blob`])).rejects.toThrow()
  await expect(publish(pointer(3, alice), 0)).rejects.toThrow()
  await expect(db.query('select watcher_gc_batch()')).rejects.toThrow()
  await expect(db.query('select watcher_purge_account($1)', [alice])).rejects.toThrow()
  await db.query('select watcher_delete_history()')
  await asUser(alice)
  expect((await db.query('select device_id from watcher_backups')).rows).toHaveLength(1)
})
it('keeps current and previous versions, queues older objects, and prevents queued objects becoming live again', async () => {
  await asUser(); await db.query('select watcher_enable_backup()')
  expect((await publish(pointer(3), 2)).rows[0]).toEqual({ ok: true })
  await db.exec('reset role')
  const row = (await db.query<{ pointer: { version: number }; previous_pointer: { version: number } }>('select pointer,previous_pointer from watcher_backups')).rows[0]!
  expect(row.pointer.version).toBe(3); expect(row.previous_pointer.version).toBe(2)
  await asUser()
  await expect(db.query('select watcher_publish_backup($1,$2::jsonb,0)', ['20000000-0000-4000-8000-000000000002', JSON.stringify(pointer(3))])).rejects.toThrow('invalid immutable')
  await db.exec('reset role')
  const paths = (await db.query<{ path: string }>('select path from watcher_private.watcher_gc')).rows.map(x => x.path)
  expect(paths).toContain(pointer(1).object_path); expect(paths).not.toContain(pointer(2).object_path)
  await asUser(); await db.query('select watcher_delete_history()')
  expect((await db.query('select device_id from watcher_backups')).rows).toEqual([])
  await db.query('select watcher_enable_backup()')
  await expect(publish(pointer(3), 0)).rejects.toThrow('invalid immutable')
})
it('bounds trusted Storage finalization to consenting live owners, owned paths and quota', async () => {
  await asUser(bob); await db.query('select watcher_enable_backup()')
  async function finalize(name: string, owner = bob, ownerId = owner) {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })])
    await db.exec('set role service_role')
    return db.query('insert into storage.objects(bucket_id,name,owner,owner_id) values($1,$2,$3,$4)', ['watcher-history', name,owner,ownerId])
  }
  await expect(finalize(`watcher/${alice}/80001.blob`)).rejects.toThrow()
  await expect(finalize(`watcher/${bob}/80001.blob`,bob,alice)).rejects.toThrow()
  await asUser(bob); await db.query('select watcher_pause_backup()')
  await expect(finalize(`watcher/${bob}/80001.blob`)).rejects.toThrow()
  await asUser(bob); await db.query('select watcher_enable_backup()')
  await db.exec('reset role; update watcher_private.watcher_settings set enabled=false')
  await expect(finalize(`watcher/${bob}/80001.blob`)).rejects.toThrow()
  await db.exec('reset role')
  await db.query("insert into watcher_private.watcher_qa_accounts(user_id,expires_at) values($1,now()+interval '1 hour')",[bob])
  const existing = Number((await db.query<{ count: string }>('select count(*)::text as count from storage.objects where bucket_id=$1 and name like $2',['watcher-history',`watcher/${bob}/%`])).rows[0]!.count)
  const added: string[] = []
  for (let i = existing; i < 100; i++) {
    const name = `watcher/${bob}/${80001+i}.blob`
    await finalize(name); added.push(name)
  }
  await expect(finalize(`watcher/${bob}/99999.blob`)).rejects.toThrow('quota')
  await db.exec('reset role')
  for (const name of added) await db.query('delete from storage.objects where bucket_id=$1 and name=$2',['watcher-history',name])
  await db.exec('delete from watcher_private.watcher_qa_accounts; update watcher_private.watcher_settings set enabled=true')
})
it('tombstones a deleted account and refuses a stale signed-in device', async () => {
  await db.exec('reset role; set role service_role')
  await db.query('select watcher_purge_account($1)', [alice])
  await asUser()
  await expect(db.query('select watcher_enable_backup()')).rejects.toThrow()
  await expect(db.query('insert into storage.objects values($1,$2)', ['watcher-history', `watcher/${alice}/500.blob`])).rejects.toThrow()
})
it('preserves existing private-schema grants and other-app storage access alongside broad policies', async () => {
  await db.exec(`reset role;
    insert into private.unrelated_secret values(7);
    insert into storage.objects(bucket_id,name) values('other-app','unrelated');
    create policy existing_broad_access on storage.objects for all to anon,authenticated using(true) with check(true);
  `)
  await asUser(bob)
  expect((await db.query('select * from private.unrelated_secret')).rows).toEqual([{ id: 7 }])
  await objects(10, bob)
  await asUser(bob)
  const visible = (await db.query<{ name: string }>('select name from storage.objects')).rows.map(x => x.name)
  expect(visible).toContain('unrelated')
  expect(visible).toContain(pointer(10, bob).object_path)
  expect(visible.some(x => x.includes(alice))).toBe(false)
  await expect(db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['watcher-history', pointer(99, alice).object_path])).rejects.toThrow()
  expect((await db.query("update storage.objects set name='changed' where bucket_id='watcher-history'")).affectedRows).toBe(0)
  expect((await db.query("delete from storage.objects where bucket_id='watcher-history'")).affectedRows).toBe(0)
  await expect(db.query("update storage.objects set bucket_id='watcher-history' where bucket_id='other-app'")).rejects.toThrow()
  await db.exec("reset role; select set_config('request.jwt.claims','{}',false); set role anon")
  expect((await db.query("select name from storage.objects where bucket_id='other-app'")).rows).toEqual([{ name: 'unrelated' }])
  expect((await db.query("select name from storage.objects where bucket_id='watcher-history'")).rows).toEqual([])
  await expect(db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['watcher-history', pointer(99, bob).object_path])).rejects.toThrow()
})
it('queues only Watcher data during a central Auth deletion and rejects the stale JWT afterward', async () => {
  await asUser(bob)
  expect((await publish(pointer(10, bob), 0)).rows[0]).toEqual({ ok: true })
  await db.exec('reset role')
  await db.query('delete from auth.users where id=$1', [bob])
  expect((await db.query('select 1 from public.watcher_backups where user_id=$1', [bob])).rows).toEqual([])
  const queue = (await db.query<{ path: string }>('select path from watcher_private.watcher_gc')).rows.map(x => x.path)
  expect(queue).toContain(pointer(10, bob).object_path)
  expect((await db.query("select name from storage.objects where bucket_id='other-app'")).rows).toEqual([{ name: 'unrelated' }])
  await asUser(bob)
  await expect(db.query('select watcher_enable_backup()')).rejects.toThrow()
  expect((await db.query("select name from storage.objects where bucket_id='watcher-history'")).rows).toEqual([])
})
