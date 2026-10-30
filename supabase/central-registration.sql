-- Compatibility/idempotent catalog check; canonical storage migration now registers Watcher atomically.
-- Does not alter OAuth clients, other apps or backup paywall settings.
begin;
set local lock_timeout='2s';
do $$ begin
  if exists(select 1 from public.apps where code='watcher' and name is distinct from 'Watcher') then
    raise exception 'Existing Watcher catalog entry differs; inspect before registration';
  end if;
end $$;
insert into public.apps(code,name) values('watcher','Watcher') on conflict(code) do nothing;
-- No OAuth clients, app data, subscriptions, paywall flags or credentials change.
commit;
