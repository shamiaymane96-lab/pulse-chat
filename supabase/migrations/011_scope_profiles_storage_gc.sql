-- Medium-severity cleanups:
--   1. Scope profiles reads to people you share a room with
--   2. Track orphaned storage objects so the bucket can be reclaimed
--   3. Give reactions a conversation_id so Realtime can filter them
--   4. Stop rpc_rate_limits growing forever

-- ---------------------------------------------------------------------------
-- 1) profiles: `using (true)` let any authenticated user enumerate every
-- display_name and last_seen in the database, across all rooms.
-- ---------------------------------------------------------------------------

create or replace function public.shares_room_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.participants mine
    join public.participants theirs on theirs.conversation_id = mine.conversation_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_user
  );
$$;

grant execute on function public.shares_room_with(uuid) to authenticated;

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_roommates"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_room_with(id));

-- ---------------------------------------------------------------------------
-- 2) Storage garbage collection
--
-- delete_message, clear_room_messages and room teardown all remove attachment
-- rows, but nothing ever removed the objects in the chat-files bucket, so
-- storage only ever grew. Deleting from storage.objects in SQL is not enough to
-- reclaim the bytes -- that has to go through the Storage API -- so record the
-- paths and let a scheduled job drain the queue.
-- ---------------------------------------------------------------------------

create table if not exists public.orphaned_storage_objects (
  id bigint generated always as identity primary key,
  bucket_id text not null default 'chat-files',
  storage_path text not null,
  queued_at timestamptz not null default now(),
  removed_at timestamptz
);

create index if not exists orphaned_storage_pending_idx
  on public.orphaned_storage_objects (queued_at)
  where removed_at is null;

alter table public.orphaned_storage_objects enable row level security;
-- No policies: service_role only. Clients must never read this.

create or replace function public.queue_orphaned_attachment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.storage_path is not null and old.storage_path <> '' then
    insert into public.orphaned_storage_objects (storage_path)
    values (old.storage_path);
  end if;
  return old;
end;
$$;

drop trigger if exists attachments_queue_orphan on public.attachments;
create trigger attachments_queue_orphan
  after delete on public.attachments
  for each row execute function public.queue_orphaned_attachment();

-- Drain helper for the scheduled job: returns paths, marks them claimed.
-- Output columns are deliberately not named `id` / `storage_path`: OUT params
-- shadow column names inside plpgsql and make the body ambiguous.
create or replace function public.claim_orphaned_objects(p_limit int default 100)
returns table (object_id bigint, object_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    update public.orphaned_storage_objects o
    set removed_at = now()
    where o.id in (
      select o2.id
      from public.orphaned_storage_objects o2
      where o2.removed_at is null
      order by o2.queued_at
      limit greatest(coalesce(p_limit, 100), 1)
    )
    returning o.id, o.storage_path
  )
  select claimed.id, claimed.storage_path from claimed;
end;
$$;

revoke all on function public.claim_orphaned_objects(int) from public, anon, authenticated;
grant execute on function public.claim_orphaned_objects(int) to service_role;

-- ---------------------------------------------------------------------------
-- 3) reactions.conversation_id
--
-- The client subscribed to every reaction in the database because there was no
-- column to filter on, so one person reacting woke up every connected client.
-- ---------------------------------------------------------------------------

alter table public.reactions add column if not exists conversation_id uuid;

update public.reactions r
set conversation_id = m.conversation_id
from public.messages m
where m.id = r.message_id and r.conversation_id is null;

create index if not exists reactions_conversation_idx
  on public.reactions (conversation_id);

create or replace function public.reactions_set_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is null then
    select m.conversation_id into new.conversation_id
    from public.messages m where m.id = new.message_id;
  end if;
  return new;
end;
$$;

drop trigger if exists reactions_set_conversation on public.reactions;
create trigger reactions_set_conversation
  before insert on public.reactions
  for each row execute function public.reactions_set_conversation();

-- ---------------------------------------------------------------------------
-- 4) rpc_rate_limits retention
--
-- One row per user, never pruned. Sampled cleanup keeps it cheap.
-- ---------------------------------------------------------------------------

create index if not exists rpc_rate_limits_window_idx
  on public.rpc_rate_limits (window_started_at);

create or replace function public.check_rpc_rate_limit(
  p_bucket text,
  p_max_hits int,
  p_window_seconds int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.rpc_rate_limits%rowtype;
  window_secs int := greatest(coalesce(p_window_seconds, 60), 1);
  max_hits int := greatest(coalesce(p_max_hits, 10), 1);
begin
  -- ~1% of calls sweep rows that fell out of every window long ago.
  if random() < 0.01 then
    delete from public.rpc_rate_limits
    where window_started_at < now() - interval '1 day';
  end if;

  insert into public.rpc_rate_limits (bucket_key, window_started_at, hit_count)
  values (p_bucket, now(), 1)
  on conflict (bucket_key) do update
    set
      hit_count = case
        when public.rpc_rate_limits.window_started_at <= now() - make_interval(secs => window_secs)
          then 1
        else public.rpc_rate_limits.hit_count + 1
      end,
      window_started_at = case
        when public.rpc_rate_limits.window_started_at <= now() - make_interval(secs => window_secs)
          then now()
        else public.rpc_rate_limits.window_started_at
      end
  returning * into rec;

  if rec.hit_count > max_hits then
    raise exception 'Too many attempts - wait a minute and try again';
  end if;
end;
$$;

revoke all on function public.check_rpc_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rpc_rate_limit(text, int, int) to service_role;
