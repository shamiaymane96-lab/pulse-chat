-- Security: block dangerous upload MIME types + rate-limit join_room_by_code

-- 1) Bucket allowlist (Storage API rejects other Content-Types)
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/avif',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain'
]
where id = 'chat-files';

-- Helper: deny known dangerous / scriptable types (defense in depth vs spoofed headers)
create or replace function public.is_dangerous_mime(p_mime text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(nullif(trim(p_mime), ''), 'application/octet-stream')) ~*
    '^(text/html|text/javascript|application/javascript|application/x-javascript|image/svg\+xml|application/xhtml\+xml|text/xml|application/xml|application/xhtml|application/x-msdownload|application/x-msdos-program|application/x-executable|application/x-sh|application/x-csh|application/x-bat|application/vnd\.microsoft\.portable-executable|application/wasm)(;|$)';
$$;

create or replace function public.is_allowed_chat_mime(p_mime text)
returns boolean
language sql
immutable
as $$
  select
    not public.is_dangerous_mime(p_mime)
    and lower(split_part(coalesce(nullif(trim(p_mime), ''), ''), ';', 1)) = any (array[
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/heic',
      'image/heif',
      'image/bmp',
      'image/avif',
      'audio/webm',
      'audio/mp4',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
      'audio/x-m4a',
      'audio/aac',
      'audio/flac',
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip',
      'application/x-zip-compressed',
      'text/plain'
    ]);
$$;

-- Tighten storage insert: participant + MIME allowlist from object metadata
drop policy if exists "chat_files_insert" on storage.objects;
create policy "chat_files_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and public.is_conversation_participant((storage.foldername(name))[1]::uuid)
    and public.is_allowed_chat_mime(coalesce(metadata->>'mimetype', metadata->>'contentType', ''))
  );

-- Block dangerous MIME on attachment rows (even if storage somehow accepted)
create or replace function public.attachments_mime_guard()
returns trigger
language plpgsql
as $$
begin
  if public.is_dangerous_mime(new.mime_type) or not public.is_allowed_chat_mime(new.mime_type) then
    raise exception 'File type not allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists attachments_mime_guard on public.attachments;
create trigger attachments_mime_guard
  before insert or update of mime_type on public.attachments
  for each row execute function public.attachments_mime_guard();

-- 2) Rate limit join attempts (per authenticated user)
create table if not exists public.rpc_rate_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  hit_count int not null default 0
);

alter table public.rpc_rate_limits enable row level security;

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
    raise exception 'Too many attempts — wait a minute and try again';
  end if;
end;
$$;

revoke all on function public.check_rpc_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rpc_rate_limit(text, int, int) to service_role;

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
    raise exception 'Code must be 4–12 letters or numbers';
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
    update public.conversations set max_participants = max_p, is_group = max_p > 2 where id = conv_id;
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

-- 3) Realtime DELETE schema note: messages uses REPLICA IDENTITY FULL so filters on
-- conversation_id work. RLS still blocks row data for non-participants; column names
-- in DELETE payloads are a known Realtime limitation (Low). Leaving FULL intentionally.
