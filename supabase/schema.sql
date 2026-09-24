-- ============================================================
-- Us — schema. Paste into Supabase → SQL Editor → Run.
-- Safe to run once on a fresh project.
-- ============================================================

-- ---------- Members (the allowlist: exactly you two) ----------
create table public.members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null
);

-- security definer so RLS policies can call it without recursing into members' own RLS
create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;

-- ---------- Messages ----------
create table public.messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body         text check (body is null or length(body) <= 4000),
  image_path   text,
  thumb_path   text,
  image_width  int,
  image_height int,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  edited_at    timestamptz,
  deleted_at   timestamptz,  -- set by unsend_message(); an unsent row has no body or image
  constraint message_has_content
    check (
      deleted_at is not null
      or coalesce(length(trim(body)), 0) > 0
      or image_path is not null
    )
);

create index messages_created_at_idx on public.messages (created_at desc);
create index messages_images_idx on public.messages (created_at desc) where image_path is not null;
create index messages_unread_idx on public.messages (sender_id) where read_at is null;

-- ---------- Reactions (one per person per message) ----------
create table public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- ---------- Push subscriptions (one row per device/browser) ----------
create table public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- ---------- Row Level Security ----------
alter table public.members            enable row level security;
alter table public.messages           enable row level security;
alter table public.reactions          enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "members can see members"
  on public.members for select to authenticated
  using (public.is_member());

create policy "members can read messages"
  on public.messages for select to authenticated
  using (public.is_member());

create policy "members send as themselves"
  on public.messages for insert to authenticated
  with check (
    public.is_member()
    and sender_id = auth.uid()
    and read_at is null
    and edited_at is null
    and deleted_at is null
  );

-- No update policy on purpose: read receipts, edits and unsends go through
-- mark_read(), edit_message() and unsend_message() below, which check ownership.

create policy "members can read reactions"
  on public.reactions for select to authenticated
  using (public.is_member());

create policy "members react as themselves"
  on public.reactions for insert to authenticated
  with check (
    public.is_member()
    and user_id = auth.uid()
    and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null)
  );

create policy "members change own reaction"
  on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (
    public.is_member()
    and user_id = auth.uid()
    and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null)
  );

create policy "members remove own reaction"
  on public.reactions for delete to authenticated
  using (user_id = auth.uid());

create policy "manage own push subscriptions"
  on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_member());

-- ---------- Read receipts ----------
create or replace function public.mark_read()
returns void
language sql security definer
set search_path = public
as $$
  update public.messages
     set read_at = now()
   where read_at is null
     and sender_id <> auth.uid()
     and public.is_member();
$$;

revoke execute on function public.mark_read() from public, anon;
grant  execute on function public.mark_read() to authenticated;

-- ---------- Edit message ----------
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
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.reactions;

-- ---------- Storage: private photos bucket ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "members can view photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member());

-- each person uploads only into their own folder: photos/<user_id>/...
create policy "members upload to own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photos'
    and public.is_member()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- unsend removes the photo files through the Storage API, only from your own folder
create policy "members delete own photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos'
    and public.is_member()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- AFTER you create both users (Authentication → Users → Add user),
-- run this with your real emails and names:
-- ============================================================
-- insert into public.members (user_id, display_name)
-- select id, 'Adnan' from auth.users where email = 'you@example.com';
--
-- insert into public.members (user_id, display_name)
-- select id, 'WIFE_NAME' from auth.users where email = 'her@example.com';
