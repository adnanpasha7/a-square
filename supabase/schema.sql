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
  constraint message_has_content
    check (coalesce(length(trim(body)), 0) > 0 or image_path is not null)
);

create index messages_created_at_idx on public.messages (created_at desc);
create index messages_images_idx on public.messages (created_at desc) where image_path is not null;
create index messages_unread_idx on public.messages (sender_id) where read_at is null;

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
alter table public.push_subscriptions enable row level security;

create policy "members can see members"
  on public.members for select to authenticated
  using (public.is_member());

create policy "members can read messages"
  on public.messages for select to authenticated
  using (public.is_member());

create policy "members send as themselves"
  on public.messages for insert to authenticated
  with check (public.is_member() and sender_id = auth.uid() and read_at is null);

-- No update policy on purpose: read receipts go through mark_read() below,
-- so nobody can edit message bodies after sending.

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

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.messages;

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

-- ============================================================
-- AFTER you create both users (Authentication → Users → Add user),
-- run this with your real emails and names:
-- ============================================================
-- insert into public.members (user_id, display_name)
-- select id, 'Adnan' from auth.users where email = 'you@example.com';
--
-- insert into public.members (user_id, display_name)
-- select id, 'WIFE_NAME' from auth.users where email = 'her@example.com';
