-- Storage v1.80 completes an admitted upload under its trusted service role.
-- Keep ordinary user admission/session checks and every restrictive policy.
begin;
set local lock_timeout = '2s';

create or replace function watcher_private.watcher_admit_object() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if new.bucket_id <> 'watcher-history' then return new; end if;
  -- Check the actual database role, never a caller-supplied JWT role string.
  if current_setting('role',true) = 'service_role' then
    v_owner := new.owner;
    if v_owner is null or new.owner_id is distinct from v_owner::text then
      raise insufficient_privilege;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('watcher:' || v_owner::text,0));
    if not exists(select 1 from watcher_private.watcher_accounts a
        where a.user_id=v_owner and a.enabled and not a.deleted)
      or not exists(select 1 from auth.users u where u.id=v_owner
        and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,true)
        and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
      or not (exists(select 1 from watcher_private.watcher_settings where enabled)
        or exists(select 1 from watcher_private.watcher_qa_accounts q
          where q.user_id=v_owner and q.expires_at>now()))
    then raise insufficient_privilege; end if;
  else
    v_owner := watcher_private.watcher_owner();
    if v_owner is null then raise insufficient_privilege; end if;
    perform pg_advisory_xact_lock(hashtextextended('watcher:' || v_owner::text,0));
    if not watcher_private.watcher_writable() then raise insufficient_privilege; end if;
  end if;
  if new.name is null or new.name !~ ('^watcher/' || v_owner::text || '/[1-9][0-9]{0,15}[.]blob$') then
    raise insufficient_privilege;
  end if;
  if (select count(*) from storage.objects o where o.bucket_id='watcher-history'
      and o.name like 'watcher/' || v_owner::text || '/%') >= 100 then
    raise exception 'Watcher object quota reached';
  end if;
  return new;
end $$;

commit;
