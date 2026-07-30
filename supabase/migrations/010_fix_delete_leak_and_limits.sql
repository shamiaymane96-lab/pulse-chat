-- Security fixes:
--   1. Stop broadcasting deleted message bodies to every authenticated client
--   2. Cap message body length on insert (not just via edit_message)
--   3. Require 6+ character codes when CREATING a room (brute-force surface)

-- ---------------------------------------------------------------------------
-- 1) Replica identity on messages
--
-- Realtime cannot apply RLS to DELETE events: the row is already gone, so there
-- is nothing to run the policy against. With REPLICA IDENTITY FULL (set in 006)
-- the entire old row -- message body included -- is broadcast to every client
-- subscribed to public.messages, not just room participants. Anonymous sign-up
-- is open, so that is world-readable in practice.
--
-- Reverting to DEFAULT means DELETE payloads carry only the primary key. The
-- trade-off: a `conversation_id=eq.X` filter can no longer match a DELETE, so
-- those events stop being delivered at all. `clear_room_messages` therefore
-- signals via conversations.messages_cleared_at below, and the client drops its
-- DELETE subscription.
--
-- participants and reactions stay FULL on purpose: their filters depend on it
-- and neither row carries message content (membership / emoji only).
alter table public.messages replica identity default;

alter table public.conversations
  add column if not exists messages_cleared_at timestamptz;

create or replace function public.clear_room_messages(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_conversation_participant(p_conversation_id) then
    raise exception 'Not allowed';
  end if;

  delete from public.messages where conversation_id = p_conversation_id;

  -- Bump so participants get a Realtime UPDATE on conversations and refetch.
  -- (DELETE events on messages are no longer deliverable -- see above.)
  update public.conversations
  set messages_cleared_at = now()
  where id = p_conversation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Message body length
--
-- Clients INSERT into public.messages directly and the RLS policy never
-- constrained size, so a participant could store multi-megabyte bodies.
-- edit_message already truncates at 4000; this makes insert agree.
-- Longest existing body at time of writing: 30 chars, so this validates clean.
do $$
begin
  alter table public.messages
    add constraint messages_body_length_check
    check (body is null or char_length(body) <= 4000);
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Minimum code length for NEW rooms
--
-- 4-character codes are ~1.7M combinations. The per-user rate limit added in
-- 009 does not bound this because anonymous sign-in mints unlimited users, and
-- a guessed-but-unused code silently CREATES a room. Existing short codes keep
-- working -- the floor applies only on the creation path.
create or replace function public.join_room_by_code(
  p_code text,
  p_display_name text,
  p_max_participants int default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  code text;
  conv_id uuid;
  member_count int;
  already boolean;
  uname text;
  dname text;
  max_p int;
  room_max int;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  -- 10 join attempts / rolling 60s per user (botnet throttle)
  perform public.check_rpc_rate_limit('join:' || me::text, 10, 60);

  code := upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
  if length(code) < 4 or length(code) > 12 then
    raise exception 'Code must be 4-12 letters or numbers';
  end if;

  dname := nullif(trim(coalesce(p_display_name, '')), '');
  if dname is null then dname := 'Guest'; end if;
  dname := left(dname, 32);
  uname := 'u' || substr(replace(me::text, '-', ''), 1, 10);

  insert into public.profiles (id, username, display_name)
  values (me, uname, dname)
  on conflict (id) do update
    set display_name = excluded.display_name, last_seen = now();

  perform pg_advisory_xact_lock(hashtext('pulse_join:' || code));

  select c.id into conv_id from public.conversations c where c.join_code = code;

  if conv_id is null then
    -- Creation path only: short codes are too cheap to guess.
    if length(code) < 6 then
      raise exception 'New room codes need at least 6 letters or numbers';
    end if;

    max_p := coalesce(p_max_participants, 2);
    if max_p < 2 then max_p := 2; end if;
    if max_p > 20 then max_p := 20; end if;
    insert into public.conversations (is_group, join_code, title, max_participants)
    values (max_p > 2, code, code, max_p)
    returning id into conv_id;
    insert into public.participants (conversation_id, user_id) values (conv_id, me);
    return conv_id;
  end if;

  select exists (
    select 1 from public.participants p
    where p.conversation_id = conv_id and p.user_id = me
  ) into already;
  if already then return conv_id; end if;

  select count(*) into member_count from public.participants p where p.conversation_id = conv_id;
  select c.max_participants into room_max from public.conversations c where c.id = conv_id;

  if member_count = 0 then
    delete from public.messages where conversation_id = conv_id;
    max_p := coalesce(p_max_participants, room_max, 2);
    if max_p < 2 then max_p := 2; end if;
    if max_p > 20 then max_p := 20; end if;
    update public.conversations
      set max_participants = max_p,
          is_group = max_p > 2,
          messages_cleared_at = now()
      where id = conv_id;
    insert into public.participants (conversation_id, user_id) values (conv_id, me);
    return conv_id;
  end if;

  if member_count >= coalesce(room_max, 2) then
    delete from public.participants p
    using public.profiles pr
    where p.conversation_id = conv_id
      and p.user_id = pr.id
      and p.user_id <> me
      and (pr.last_seen is null or pr.last_seen < now() - interval '45 minutes');
    select count(*) into member_count from public.participants p where p.conversation_id = conv_id;
  end if;

  if member_count >= coalesce(room_max, 2) then
    raise exception 'This room is full (% people max)', coalesce(room_max, 2);
  end if;

  insert into public.participants (conversation_id, user_id) values (conv_id, me);
  return conv_id;
end;
$$;

revoke execute on function public.join_room_by_code(text, text, int) from anon, public;
grant execute on function public.join_room_by_code(text, text, int) to authenticated;
