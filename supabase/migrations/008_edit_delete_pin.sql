-- Batch 1+2: edit, soft-delete, pin

alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;

alter table public.conversations add column if not exists pinned_message_id uuid;

do $$
begin
  alter table public.conversations
    add constraint conversations_pinned_message_fkey
    foreign key (pinned_message_id) references public.messages(id) on delete set null;
exception when duplicate_object then null;
end $$;

create or replace function public.edit_message(p_message_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg public.messages%rowtype;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  select * into msg from public.messages where id = p_message_id;
  if msg.id is null then raise exception 'Message not found'; end if;
  if msg.sender_id <> me then raise exception 'Not allowed'; end if;
  if msg.deleted_at is not null then raise exception 'Message deleted'; end if;
  if not public.is_conversation_participant(msg.conversation_id) then raise exception 'Not allowed'; end if;
  if nullif(trim(coalesce(p_body, '')), '') is null then raise exception 'Empty message'; end if;

  update public.messages
  set body = left(trim(p_body), 4000),
      edited_at = now()
  where id = p_message_id;
end;
$$;

create or replace function public.delete_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg public.messages%rowtype;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  select * into msg from public.messages where id = p_message_id;
  if msg.id is null then return; end if;
  if msg.sender_id <> me then raise exception 'Not allowed'; end if;
  if not public.is_conversation_participant(msg.conversation_id) then raise exception 'Not allowed'; end if;

  update public.messages
  set body = null,
      deleted_at = coalesce(deleted_at, now()),
      edited_at = null
  where id = p_message_id;

  delete from public.attachments where message_id = p_message_id;
  delete from public.reactions where message_id = p_message_id;

  update public.conversations
  set pinned_message_id = null
  where pinned_message_id = p_message_id;
end;
$$;

create or replace function public.pin_message(p_conversation_id uuid, p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg public.messages%rowtype;
begin
  if me is null or not public.is_conversation_participant(p_conversation_id) then
    raise exception 'Not allowed';
  end if;

  if p_message_id is null then
    update public.conversations set pinned_message_id = null where id = p_conversation_id;
    return;
  end if;

  select * into msg from public.messages where id = p_message_id;
  if msg.id is null or msg.conversation_id <> p_conversation_id then
    raise exception 'Message not in this room';
  end if;
  if msg.deleted_at is not null then raise exception 'Cannot pin deleted message'; end if;

  update public.conversations
  set pinned_message_id = p_message_id
  where id = p_conversation_id;
end;
$$;

grant execute on function public.edit_message(uuid, text) to authenticated;
grant execute on function public.delete_message(uuid) to authenticated;
grant execute on function public.pin_message(uuid, uuid) to authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.conversations;
  exception when duplicate_object then null;
  end;
end $$;
