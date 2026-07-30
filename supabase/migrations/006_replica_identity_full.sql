-- Better Realtime filters on non-PK columns (conversation_id)
alter table public.messages replica identity full;
alter table public.participants replica identity full;
alter table public.reactions replica identity full;
