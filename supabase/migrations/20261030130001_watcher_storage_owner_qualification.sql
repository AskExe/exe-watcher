-- Hosted Storage has an owner column. Keep PL/pgSQL variables unambiguous.
-- Preserve owner/session/consent/quota guards and existing function privileges.
begin;
set local lock_timeout = '2s';

create or replace function public.watcher_delete_history() returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := watcher_private.watcher_owner(); row public.watcher_backups;
begin
  if v_owner is null then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('watcher:' || v_owner::text,0));
  update watcher_private.watcher_accounts set enabled=false where user_id=v_owner;
  for row in select * from public.watcher_backups where user_id=v_owner loop
    perform watcher_private.watcher_queue(row.pointer); perform watcher_private.watcher_queue(row.previous_pointer);
  end loop;
  -- Includes abandoned uploads, not only published pointers.
  insert into watcher_private.watcher_gc(path) select name from storage.objects
    where bucket_id='watcher-history' and name like 'watcher/' || v_owner::text || '/%' on conflict do nothing;
  delete from public.watcher_backups where user_id=v_owner;
end $$;

create or replace function watcher_private.watcher_admit_object() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if new.bucket_id <> 'watcher-history' then return new; end if;
  v_owner:=watcher_private.watcher_owner();
  if v_owner is null then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('watcher:' || v_owner::text,0));
  if not watcher_private.watcher_writable() then raise insufficient_privilege; end if;
  if (select count(*) from storage.objects where bucket_id='watcher-history' and name like 'watcher/' || v_owner::text || '/%') >= 100 then
    raise exception 'Watcher object quota reached';
  end if;
  return new;
end $$;

commit;
