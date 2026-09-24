-- ============================================================
-- A ♥ A — migration 002: reactions, edit message, unsend.
-- Paste into Supabase → SQL Editor → Run.
-- Safe to run on the existing database, and safe to run more than once.
-- ============================================================

-- ---------- Messages: edit + unsend columns ----------
alter table public.messages add column if not exists edited_at  timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;

-- An unsent message keeps its row (so both sides see "… unsent a message") but has no content
alter table public.messages drop constraint if exists message_has_content;
alter table public.messages add constraint message_has_content
  check (
    deleted_at is not null
    or coalesce(length(trim(body)), 0) > 0
    or image_path is not null
  );

-- New messages can't arrive already edited or unsent; those states only come from the RPCs below
drop policy if exists "members send as themselves" on public.messages;
create policy "members send as themselves"
  on public.messages for insert to authenticated
  with check (
    public.is_member()
    and sender_id = auth.uid()
    and read_at is null
    and edited_at is null
    and deleted_at is null
  );

-- ---------- Reactions (one per person per message) ----------
create table if not exists public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.reactions enable row level security;

drop policy if exists "members can read reactions" on public.reactions;
create policy "members can read reactions"
  on public.reactions for select to authenticated
  using (public.is_member());

drop policy if exists "members react as themselves" on public.reactions;
create policy "members react as themselves"
  on public.reactions for insert to authenticated
  with check (
    public.is_member()
    and user_id = auth.uid()
    and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null)
  );

drop policy if exists "members change own reaction" on public.reactions;
create policy "members change own reaction"
  on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (
    public.is_member()
    and user_id = auth.uid()
    and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null)
  );

drop policy if exists "members remove own reaction" on public.reactions;
create policy "members remove own reaction"
  on public.reactions for delete to authenticated
  using (user_id = auth.uid());

-- ---------- Edit message ----------
-- Still no general UPDATE policy on messages: edits go through this function only.
create or replace function public.edit_message(p_id uuid, p_body text)
returns public.messages
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := btrim(p_body, E' \t\r\n');
  v_row  public.messages;
begin
  if not public.is_member() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_body is null or char_length(v_body) not between 1 and 4000 then
    raise exception 'message must be 1 to 4000 characters' using errcode = '22023';
  end if;

  update public.messages
     set body = v_body,
         edited_at = now()
   where id = p_id
     and sender_id = auth.uid()
     and deleted_at is null
     and image_path is null
  returning * into v_row;

  if not found then
    raise exception 'message not found or not editable' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

revoke execute on function public.edit_message(uuid, text) from public, anon;
grant  execute on function public.edit_message(uuid, text) to authenticated;

-- ---------- Unsend message ----------
-- Photo files are removed by the app through the Storage API after this succeeds.
create or replace function public.unsend_message(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_member() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.messages
     set deleted_at   = coalesce(deleted_at, now()),
         body         = null,
         image_path   = null,
         thumb_path   = null,
         image_width  = null,
         image_height = null,
         edited_at    = null
   where id = p_id
     and sender_id = auth.uid();

  if not found then
    raise exception 'message not found' using errcode = '42501';
  end if;

  delete from public.reactions where message_id = p_id;
end;
$$;

revoke execute on function public.unsend_message(uuid) from public, anon;
grant  execute on function public.unsend_message(uuid) to authenticated;

-- ---------- Realtime ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reactions'
  ) then
    alter publication supabase_realtime add table public.reactions;
  end if;
end;
$$;

-- ---------- Storage: let people delete photos in their own folder (used by unsend) ----------
drop policy if exists "members delete own photos" on storage.objects;
create policy "members delete own photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos'
    and public.is_member()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
