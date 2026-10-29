-- Watcher-specific objects in the existing central Odd project (2026-10-29 decision).
-- Never change existing central private-schema permissions or other app policies.
-- Rollout stays disabled until storage, purge and cross-account checks pass.
begin;
set local lock_timeout = '2s';
create schema watcher_private;
revoke all on schema watcher_private from public, anon, authenticated;
grant usage on schema watcher_private to anon, authenticated;

create table watcher_private.watcher_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into watcher_private.watcher_settings(id,enabled) values (true, false);
create table watcher_private.watcher_accounts (
  user_id uuid primary key,
  enabled boolean not null default false,
  deleted boolean not null default false,
  deleted_at timestamptz
);
create table watcher_private.watcher_gc (
  path text primary key,
  queued_at timestamptz not null default now()
);
revoke all on watcher_private.watcher_settings, watcher_private.watcher_accounts, watcher_private.watcher_gc from public, anon, authenticated;

create function watcher_private.watcher_owner() returns uuid
language sql stable security definer set search_path = '' as $$
  select case when
    (select auth.jwt()) ->> 'iss' = 'https://vjiexzktmduoguxvleiy.supabase.co/auth/v1'
    and (select auth.jwt()) ->> 'role' = 'authenticated'
    and (select auth.jwt()) ->> 'is_anonymous' = 'false'
    and coalesce((select auth.jwt()) ->> 'email', '') <> ''
    and not ((select auth.jwt()) ? 'client_id')
    and exists (select 1 from auth.users u where u.id=(select auth.uid())
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,true)
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
    and exists (select 1 from auth.sessions s where s.user_id=(select auth.uid())
      and s.id::text=(select auth.jwt())->>'session_id')
    and exists (select 1 from watcher_private.watcher_settings where enabled)
    and not exists (select 1 from watcher_private.watcher_accounts where user_id = (select auth.uid()) and deleted)
  then (select auth.uid()) else null end
$$;
revoke all on function watcher_private.watcher_owner() from public, anon;
grant execute on function watcher_private.watcher_owner() to anon, authenticated;

create function watcher_private.watcher_writable() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from watcher_private.watcher_accounts
    where user_id = watcher_private.watcher_owner() and enabled and not deleted)
$$;
revoke all on function watcher_private.watcher_writable() from public, anon;
grant execute on function watcher_private.watcher_writable() to anon, authenticated;

create table public.watcher_backups (
  user_id uuid not null,
  device_id uuid not null,
  pointer jsonb not null,
  previous_pointer jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.watcher_backups enable row level security;
revoke all on public.watcher_backups from public, anon, authenticated;
grant select (device_id, pointer, updated_at) on public.watcher_backups to authenticated;
create policy watcher_owner_read on public.watcher_backups for select to authenticated
  using (user_id = (select watcher_private.watcher_owner()));

create function public.watcher_enable_backup() returns void
language plpgsql security definer set search_path = '' as $$
declare owner uuid := watcher_private.watcher_owner();
begin
  if owner is null then raise insufficient_privilege; end if;
  insert into watcher_private.watcher_accounts(user_id,enabled) values(owner,true)
  on conflict(user_id) do update set enabled = true where not watcher_accounts.deleted;
end $$;

create function public.watcher_pause_backup() returns void
language plpgsql security definer set search_path = '' as $$
declare owner uuid := watcher_private.watcher_owner();
begin
  if owner is null then raise insufficient_privilege; end if;
  update watcher_private.watcher_accounts set enabled = false where user_id = owner;
end $$;

create function watcher_private.watcher_queue(pointer jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if pointer is null then return; end if;
  insert into watcher_private.watcher_gc(path) values(pointer->>'object_path') on conflict do nothing;
  insert into watcher_private.watcher_gc(path) select jsonb_array_elements_text(pointer->'part_paths') on conflict do nothing;
end $$;
revoke all on function watcher_private.watcher_queue(jsonb) from public, anon, authenticated;

create function public.watcher_publish_backup(p_device_id uuid, p_pointer jsonb, p_expected bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare owner uuid := watcher_private.watcher_owner(); old public.watcher_backups; object_name text; paths text[];
begin
  if owner is null or not watcher_private.watcher_writable() then raise insufficient_privilege; end if;
  -- Same account lock is used by deletion, including the first publication (no row yet).
  perform pg_advisory_xact_lock(hashtextextended('watcher:' || owner::text,0));
  if not watcher_private.watcher_writable() then raise insufficient_privilege; end if;
  if coalesce(p_expected is null or p_expected < 0 or p_device_id is null or
    jsonb_typeof(p_pointer) <> 'object' or
    (select array_agg(key order by key) from jsonb_object_keys(p_pointer) key) <>
      array['app_code','crypto_version','object_path','part_paths','size_bytes','user_id','version']::text[] or
    p_pointer->>'app_code' <> 'watcher' or p_pointer->>'user_id' <> owner::text or
    p_pointer->>'crypto_version' <> '1' or
    jsonb_typeof(p_pointer->'crypto_version') <> 'number' or
    jsonb_typeof(p_pointer->'version') <> 'number' or jsonb_typeof(p_pointer->'size_bytes') <> 'number' or
    (p_pointer->>'version') !~ '^[1-9][0-9]{0,15}$' or
    (p_pointer->>'version')::numeric > 9007199254740991 or
    (p_pointer->>'version')::bigint <= p_expected or
    p_pointer->>'object_path' <> 'watcher/' || owner::text || '/' || (p_pointer->>'version') || '.blob' or
    (p_pointer->>'size_bytes') !~ '^[1-9][0-9]{0,7}$' or
    (p_pointer->>'size_bytes')::bigint > 10485760 or
    jsonb_typeof(p_pointer->'part_paths') <> 'array' or jsonb_array_length(p_pointer->'part_paths') not between 1 and 2, true)
  then raise exception 'Invalid Watcher pointer'; end if;
  paths := array[p_pointer->>'object_path'] || array(select jsonb_array_elements_text(p_pointer->'part_paths'));
  if cardinality(paths) <> (select count(distinct p) from unnest(paths) p) then raise exception 'Duplicate objects'; end if;
  foreach object_name in array paths loop
    if object_name !~ ('^watcher/' || owner::text || '/[1-9][0-9]{0,15}[.]blob$') or
       exists(select 1 from watcher_private.watcher_gc where path=object_name) or
       exists(select 1 from public.watcher_backups b where b.user_id=owner and
         (b.pointer->>'object_path'=object_name or (b.pointer->'part_paths') ? object_name or
          b.previous_pointer->>'object_path'=object_name or (b.previous_pointer->'part_paths') ? object_name)) or
       not exists (select 1 from storage.objects where bucket_id = 'watcher-history' and name = object_name)
    then raise exception 'Missing or invalid immutable object'; end if;
  end loop;
  select * into old from public.watcher_backups where user_id = owner and device_id = p_device_id for update;
  if coalesce((old.pointer->>'version')::bigint,0) <> p_expected then return false; end if;
  perform watcher_private.watcher_queue(old.previous_pointer);
  insert into public.watcher_backups(user_id,device_id,pointer,previous_pointer)
    values(owner,p_device_id,p_pointer,old.pointer)
    on conflict(user_id,device_id) do update set pointer=excluded.pointer,previous_pointer=excluded.previous_pointer,updated_at=now();
  return true;
end $$;

create function public.watcher_delete_history() returns void
language plpgsql security definer set search_path = '' as $$
declare owner uuid := watcher_private.watcher_owner(); row public.watcher_backups;
begin
  if owner is null then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('watcher:' || owner::text,0));
  update watcher_private.watcher_accounts set enabled=false where user_id=owner;
  for row in select * from public.watcher_backups where user_id=owner loop
    perform watcher_private.watcher_queue(row.pointer); perform watcher_private.watcher_queue(row.previous_pointer);
  end loop;
  -- Includes abandoned uploads, not only published pointers.
  insert into watcher_private.watcher_gc(path) select name from storage.objects
    where bucket_id='watcher-history' and name like 'watcher/' || owner::text || '/%' on conflict do nothing;
  delete from public.watcher_backups where user_id=owner;
end $$;

-- Admin-only endpoints for a protected maintenance worker. No scheduler is installed here.
create function public.watcher_gc_batch() returns table(path text)
language sql security definer set search_path = '' as $$
  select g.path from watcher_private.watcher_gc g order by g.queued_at limit 100
$$;
create function public.watcher_queue_abandoned() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into watcher_private.watcher_gc(path)
  select o.name from storage.objects o where o.bucket_id='watcher-history'
    and o.created_at < now()-interval '2 days'
    and not exists(select 1 from public.watcher_backups b where
      b.pointer->>'object_path'=o.name or (b.pointer->'part_paths') ? o.name or
      b.previous_pointer->>'object_path'=o.name or (b.previous_pointer->'part_paths') ? o.name)
  on conflict do nothing;
  -- Match Odd's deletion-id retention; never drop a marker while ciphertext remains.
  delete from watcher_private.watcher_accounts a
  where a.deleted and a.deleted_at<now()-interval '90 days'
    and not exists(select 1 from auth.users u where u.id=a.user_id)
    and not exists(select 1 from storage.objects o where o.bucket_id='watcher-history' and o.name like 'watcher/'||a.user_id::text||'/%')
    and not exists(select 1 from watcher_private.watcher_gc g where g.path like 'watcher/'||a.user_id::text||'/%');
end $$;
create function public.watcher_gc_done(p_paths text[]) returns void
language sql security definer set search_path = '' as $$
  delete from watcher_private.watcher_gc where path=any(p_paths)
$$;
create function public.watcher_purge_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare row public.watcher_backups;
begin
  if p_user is null then raise exception 'Missing account'; end if;
  perform pg_advisory_xact_lock(hashtextextended('watcher:' || p_user::text,0));
  insert into watcher_private.watcher_accounts(user_id,enabled,deleted,deleted_at) values(p_user,false,true,now())
    on conflict(user_id) do update set enabled=false,deleted=true,deleted_at=coalesce(watcher_accounts.deleted_at,now());
  for row in select * from public.watcher_backups where user_id=p_user loop
    perform watcher_private.watcher_queue(row.pointer); perform watcher_private.watcher_queue(row.previous_pointer);
  end loop;
  insert into watcher_private.watcher_gc(path) select name from storage.objects
    where bucket_id='watcher-history' and name like 'watcher/' || p_user::text || '/%' on conflict do nothing;
  delete from public.watcher_backups where user_id=p_user;
end $$;
-- Same-project account deletion queues only Watcher ciphertext before Auth erases the user.
create function watcher_private.watcher_auth_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.watcher_purge_account(old.id);
  return old;
end $$;
revoke all on function watcher_private.watcher_auth_delete() from public, anon, authenticated;
create trigger watcher_auth_delete before delete on auth.users
  for each row execute function watcher_private.watcher_auth_delete();

-- Also catches soft-deleted or otherwise orphaned users; called only by protected cleanup.
create function public.watcher_sweep_deleted_accounts() returns integer
language plpgsql security definer set search_path = '' as $$
declare owner uuid; purged integer:=0;
begin
  for owner in select a.user_id from watcher_private.watcher_accounts a
    where not a.deleted and not exists(select 1 from auth.users u where u.id=a.user_id and u.deleted_at is null)
    order by a.user_id limit 100
  loop
    perform public.watcher_purge_account(owner); purged:=purged+1;
  end loop;
  return purged;
end $$;
revoke all on function public.watcher_sweep_deleted_accounts() from public, anon, authenticated;
grant execute on function public.watcher_sweep_deleted_accounts() to service_role;

revoke all on function public.watcher_gc_batch(), public.watcher_gc_done(text[]), public.watcher_purge_account(uuid),public.watcher_queue_abandoned() from public,anon,authenticated;
grant execute on function public.watcher_gc_batch(), public.watcher_gc_done(text[]), public.watcher_purge_account(uuid),public.watcher_queue_abandoned() to service_role;

revoke all on function public.watcher_enable_backup(),public.watcher_pause_backup(),public.watcher_publish_backup(uuid,jsonb,bigint),public.watcher_delete_history() from public,anon;
grant execute on function public.watcher_enable_backup(),public.watcher_pause_backup(),public.watcher_publish_backup(uuid,jsonb,bigint),public.watcher_delete_history() to authenticated;

-- Never repair or make an existing bucket public implicitly.
do $$ begin
  if exists(select 1 from storage.buckets where id='watcher-history') then raise exception 'Watcher bucket already exists; inspect before applying'; end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('watcher-history','watcher-history',false,5242880,array['application/octet-stream']);
create policy watcher_object_read on storage.objects for select to authenticated
  using(bucket_id='watcher-history' and name ~ ('^watcher/' || (select watcher_private.watcher_owner())::text || '/[1-9][0-9]{0,15}[.]blob$'));
create policy watcher_object_insert on storage.objects for insert to authenticated
  with check(bucket_id='watcher-history' and (select watcher_private.watcher_writable()) and
    name ~ ('^watcher/' || (select watcher_private.watcher_owner())::text || '/[1-9][0-9]{0,15}[.]blob$'));
-- Restrictive guards protect this bucket even if another shared-project policy is broad.
-- Every other bucket keeps its existing access rules, including anonymous app flows.
create policy watcher_storage_read_guard on storage.objects as restrictive for select to anon, authenticated
  using(case when bucket_id='watcher-history' then
    coalesce(name ~ ('^watcher/' || watcher_private.watcher_owner()::text || '/[1-9][0-9]{0,15}[.]blob$'),false)
    else true end);
create policy watcher_storage_insert_guard on storage.objects as restrictive for insert to anon, authenticated
  with check(case when bucket_id='watcher-history' then
    watcher_private.watcher_writable() and
    coalesce(name ~ ('^watcher/' || watcher_private.watcher_owner()::text || '/[1-9][0-9]{0,15}[.]blob$'),false)
    else true end);
create policy watcher_storage_update_guard on storage.objects as restrictive for update to anon, authenticated
  using(bucket_id<>'watcher-history') with check(bucket_id<>'watcher-history');
create policy watcher_storage_delete_guard on storage.objects as restrictive for delete to anon, authenticated
  using(bucket_id<>'watcher-history');
create function watcher_private.watcher_admit_object() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  if new.bucket_id <> 'watcher-history' then return new; end if;
  owner:=watcher_private.watcher_owner();
  if owner is null then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('watcher:' || owner::text,0));
  if not watcher_private.watcher_writable() then raise insufficient_privilege; end if;
  if (select count(*) from storage.objects where bucket_id='watcher-history' and name like 'watcher/' || owner::text || '/%') >= 100 then
    raise exception 'Watcher object quota reached';
  end if;
  return new;
end $$;
revoke all on function watcher_private.watcher_admit_object() from public,anon,authenticated;
create trigger watcher_admit_object before insert on storage.objects for each row
  when (new.bucket_id='watcher-history') execute function watcher_private.watcher_admit_object();
-- No client overwrite/delete policies. GC uses the Storage API, never DELETE FROM storage.objects.
commit;
