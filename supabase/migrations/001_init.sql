-- Pulse Chat Phase 1 schema + RLS
-- Run in Supabase SQL editor or via supabase db push

create extension if not exists "pgcrypto";

-- Profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique not null,
  display_name text not null,
  avatar_url text,
  last_seen timestamptz default now(),
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_]{3,24}$')
);

-- Conversations
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  title text,
  created_at timestamptz not null default now()
);

-- Participants
create table if not exists public.participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists participants_user_id_idx on public.participants (user_id);

-- Messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

-- Attachments
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  file_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists attachments_message_id_idx on public.attachments (message_id);

-- Push subscriptions
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- Helper: is participant
create or replace function public.is_conversation_participant(conv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.participants p
    where p.conversation_id = conv_id and p.user_id = auth.uid()
  );
$$;

-- Auto-create profile on signup (username from metadata)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text;
  dname text;
  email_local text;
begin
  email_local := split_part(coalesce(new.email, ''), '@', 1);
  uname := lower(coalesce(
    nullif(new.raw_user_meta_data->>'username', ''),
    nullif(email_local, ''),
    'guest'
  ));
  uname := regexp_replace(uname, '[^a-z0-9_]', '', 'g');
  if uname is null or length(uname) < 3 then
    uname := 'u' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;
  uname := left(uname, 32);

  dname := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    uname
  );
  dname := left(dname, 32);

  insert into public.profiles (id, username, display_name)
  values (new.id, uname, dname)
  on conflict (id) do nothing;

  return new;
exception
  when unique_violation then
    uname := 'u' || substr(replace(new.id::text, '-', ''), 1, 10);
    insert into public.profiles (id, username, display_name)
    values (new.id, uname, coalesce(dname, uname))
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Start or get 1:1 conversation
create or replace function public.get_or_create_dm(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_id uuid;
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if other_user_id = me then
    raise exception 'Cannot chat with yourself';
  end if;
  if not exists (select 1 from public.profiles where id = other_user_id) then
    raise exception 'User not found';
  end if;

  select c.id into conv_id
  from public.conversations c
  join public.participants p1 on p1.conversation_id = c.id and p1.user_id = me
  join public.participants p2 on p2.conversation_id = c.id and p2.user_id = other_user_id
  where c.is_group = false
  limit 1;

  if conv_id is not null then
    return conv_id;
  end if;

  insert into public.conversations (is_group) values (false) returning id into conv_id;
  insert into public.participants (conversation_id, user_id) values (conv_id, me), (conv_id, other_user_id);
  return conv_id;
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;
grant execute on function public.is_conversation_participant(uuid) to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.participants enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.push_subscriptions enable row level security;

-- Profiles policies
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select to authenticated
  using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Conversations
drop policy if exists "conversations_select_participant" on public.conversations;
create policy "conversations_select_participant"
  on public.conversations for select to authenticated
  using (public.is_conversation_participant(id));

drop policy if exists "conversations_insert_authenticated" on public.conversations;
create policy "conversations_insert_authenticated"
  on public.conversations for insert to authenticated
  with check (true);

-- Participants
drop policy if exists "participants_select_member" on public.participants;
create policy "participants_select_member"
  on public.participants for select to authenticated
  using (public.is_conversation_participant(conversation_id));

drop policy if exists "participants_insert_self" on public.participants;
create policy "participants_insert_self"
  on public.participants for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "participants_update_own" on public.participants;
create policy "participants_update_own"
  on public.participants for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Messages
drop policy if exists "messages_select_participant" on public.messages;
create policy "messages_select_participant"
  on public.messages for select to authenticated
  using (public.is_conversation_participant(conversation_id));

drop policy if exists "messages_insert_participant" on public.messages;
create policy "messages_insert_participant"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id)
  );

-- Message body/receipt updates go through SECURITY DEFINER RPCs only
drop policy if exists "messages_update_participant" on public.messages;

-- Attachments
drop policy if exists "attachments_select_participant" on public.attachments;
create policy "attachments_select_participant"
  on public.attachments for select to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_participant(m.conversation_id)
    )
  );

drop policy if exists "attachments_insert_sender" on public.attachments;
create policy "attachments_insert_sender"
  on public.attachments for insert to authenticated
  with check (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and m.sender_id = auth.uid()
        and public.is_conversation_participant(m.conversation_id)
    )
  );

-- Push
drop policy if exists "push_select_own" on public.push_subscriptions;
create policy "push_select_own"
  on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "push_insert_own" on public.push_subscriptions;
create policy "push_insert_own"
  on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "push_delete_own" on public.push_subscriptions;
create policy "push_delete_own"
  on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "push_update_own" on public.push_subscriptions;
create policy "push_update_own"
  on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Realtime (ignore if already added)
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.participants;
  exception when duplicate_object then null;
  end;
end $$;

-- Storage bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-files',
  'chat-files',
  false,
  52428800,
  null
)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "chat_files_select" on storage.objects;
create policy "chat_files_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-files'
    and public.is_conversation_participant((storage.foldername(name))[1]::uuid)
  );

drop policy if exists "chat_files_insert" on storage.objects;
create policy "chat_files_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and public.is_conversation_participant((storage.foldername(name))[1]::uuid)
  );

drop policy if exists "chat_files_delete_own" on storage.objects;
create policy "chat_files_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'chat-files'
    and owner = auth.uid()
  );
