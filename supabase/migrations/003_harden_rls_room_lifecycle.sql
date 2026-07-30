-- Harden RLS + room lifecycle (also applied live via MCP)

drop policy if exists "participants_insert_self" on public.participants;
create policy "participants_insert_self"
  on public.participants for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "messages_update_participant" on public.messages;

drop policy if exists "push_update_own" on public.push_subscriptions;
create policy "push_update_own"
  on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.leave_room(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining int;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  delete from public.participants
  where conversation_id = p_conversation_id and user_id = auth.uid();

  select count(*) into remaining
  from public.participants
  where conversation_id = p_conversation_id;

  if remaining = 0 then
    delete from public.conversations where id = p_conversation_id;
  end if;
end;
$$;

create or replace function public.join_room_by_code(p_code text, p_display_name text)
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
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;

  code := upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
  if length(code) < 4 or length(code) > 12 then
    raise exception 'Code must be 4–12 letters or numbers';
  end if;

  dname := nullif(trim(coalesce(p_display_name, '')), '');
  if dname is null then
    dname := 'Guest';
  end if;
  dname := left(dname, 32);

  uname := 'u' || substr(replace(me::text, '-', ''), 1, 10);

  insert into public.profiles (id, username, display_name)
  values (me, uname, dname)
  on conflict (id) do update
    set display_name = excluded.display_name,
        last_seen = now();

  perform pg_advisory_xact_lock(hashtext('pulse_join:' || code));

  select c.id into conv_id
  from public.conversations c
  where c.join_code = code;

  if conv_id is null then
    insert into public.conversations (is_group, join_code, title)
    values (false, code, code)
    returning id into conv_id;

    insert into public.participants (conversation_id, user_id)
    values (conv_id, me);

    return conv_id;
  end if;

  select exists (
    select 1 from public.participants p
    where p.conversation_id = conv_id and p.user_id = me
  ) into already;

  if already then
    return conv_id;
  end if;

  select count(*) into member_count
  from public.participants p
  where p.conversation_id = conv_id;

  if member_count = 0 then
    delete from public.messages where conversation_id = conv_id;
    insert into public.participants (conversation_id, user_id)
    values (conv_id, me);
    return conv_id;
  end if;

  if member_count >= 2 then
    raise exception 'This code already has 2 people';
  end if;

  insert into public.participants (conversation_id, user_id)
  values (conv_id, me);

  return conv_id;
end;
$$;
