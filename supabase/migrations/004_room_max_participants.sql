-- Configurable room capacity (also applied live via MCP)

alter table public.conversations
  add column if not exists max_participants int not null default 2;

alter table public.conversations
  drop constraint if exists conversations_max_participants_check;

alter table public.conversations
  add constraint conversations_max_participants_check
  check (max_participants >= 2 and max_participants <= 20);

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
    max_p := coalesce(p_max_participants, 2);
    if max_p < 2 then max_p := 2; end if;
    if max_p > 20 then max_p := 20; end if;

    insert into public.conversations (is_group, join_code, title, max_participants)
    values (max_p > 2, code, code, max_p)
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

  select c.max_participants into room_max
  from public.conversations c
  where c.id = conv_id;

  if member_count = 0 then
    delete from public.messages where conversation_id = conv_id;
    max_p := coalesce(p_max_participants, room_max, 2);
    if max_p < 2 then max_p := 2; end if;
    if max_p > 20 then max_p := 20; end if;
    update public.conversations
      set max_participants = max_p,
          is_group = max_p > 2
      where id = conv_id;
    insert into public.participants (conversation_id, user_id)
    values (conv_id, me);
    return conv_id;
  end if;

  if member_count >= coalesce(room_max, 2) then
    raise exception 'This room is full (% people max)', coalesce(room_max, 2);
  end if;

  insert into public.participants (conversation_id, user_id)
  values (conv_id, me);

  return conv_id;
end;
$$;

grant execute on function public.join_room_by_code(text, text, int) to authenticated, anon;
