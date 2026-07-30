-- Chat CX features: join codes, replies, reactions, seen receipts, room RPCs.
--
-- NOTE: this migration was originally applied directly to the hosted project and
-- kept here only as a `select 1` placeholder, which left the repo unable to
-- rebuild the database from scratch. It has been reconstructed from the live
-- schema so `001 -> 009` now produces an equivalent database.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.conversations add column if not exists join_code text;

create unique index if not exists conversations_join_code_uidx
  on public.conversations (join_code)
  where join_code is not null;

alter table public.messages add column if not exists reply_to_id uuid;
alter table public.messages add column if not exists seen_at timestamptz;

do $$
begin
  alter table public.messages
    add constraint messages_reply_to_id_fkey
    foreign key (reply_to_id) references public.messages (id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists messages_reply_to_idx on public.messages (reply_to_id);

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

create table if not exists public.reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji),
  constraint reactions_emoji_check check (char_length(emoji) >= 1 and char_length(emoji) <= 8)
);

create index if not exists reactions_message_id_idx on public.reactions (message_id);

alter table public.reactions enable row level security;

drop policy if exists "reactions_select_participant" on public.reactions;
create policy "reactions_select_participant"
  on public.reactions for select to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_participant(m.conversation_id)
    )
  );

drop policy if exists "reactions_insert_participant" on public.reactions;
create policy "reactions_insert_participant"
  on public.reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_participant(m.conversation_id)
    )
  );

drop policy if exists "reactions_delete_own" on public.reactions;
create policy "reactions_delete_own"
  on public.reactions for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Senders can hard-delete their own message (used by the send-failure rollback
-- in sendNow). Present in the live database but absent from every migration.
-- ---------------------------------------------------------------------------

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own"
  on public.messages for delete to authenticated
  using (sender_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Tighten conversation insert (001 shipped `with check (true)`)
-- ---------------------------------------------------------------------------

drop policy if exists "conversations_insert_authenticated" on public.conversations;
create policy "conversations_insert_authenticated"
  on public.conversations for insert to authenticated
  with check (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.toggle_reaction(p_message_id uuid, p_emoji text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.messages m
    where m.id = p_message_id and public.is_conversation_participant(m.conversation_id)
  ) then
    raise exception 'Not allowed';
  end if;

  if exists (
    select 1 from public.reactions r
    where r.message_id = p_message_id and r.user_id = me and r.emoji = p_emoji
  ) then
    delete from public.reactions
    where message_id = p_message_id and user_id = me and emoji = p_emoji;
  else
    insert into public.reactions (message_id, user_id, emoji)
    values (p_message_id, me, p_emoji);
  end if;
end;
$$;

create or replace function public.mark_message_delivered(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  conv uuid;
  sender uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select conversation_id, sender_id into conv, sender
  from public.messages where id = p_message_id;
  if conv is null then return; end if;
  if sender = auth.uid() then return; end if;
  if not public.is_conversation_participant(conv) then raise exception 'Not allowed'; end if;
  update public.messages
  set delivered_at = coalesce(delivered_at, now())
  where id = p_message_id and delivered_at is null;
end;
$$;

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
end;
$$;

create or replace function public.regenerate_room_code(p_conversation_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  new_code text := '';
  i int;
begin
  if auth.uid() is null or not public.is_conversation_participant(p_conversation_id) then
    raise exception 'Not allowed';
  end if;

  loop
    new_code := '';
    for i in 1..6 loop
      new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.conversations c where c.join_code = new_code);
  end loop;

  update public.conversations
  set join_code = new_code, title = new_code
  where id = p_conversation_id;

  return new_code;
end;
$$;

grant execute on function public.toggle_reaction(uuid, text) to authenticated;
grant execute on function public.mark_message_delivered(uuid) to authenticated;
grant execute on function public.clear_room_messages(uuid) to authenticated;
grant execute on function public.regenerate_room_code(uuid) to authenticated;

-- Realtime
do $$
begin
  begin
    alter publication supabase_realtime add table public.reactions;
  exception when duplicate_object then null;
  end;
end $$;
