-- ============================================================
-- A ♥ A — migration 003: live view.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
-- Run this BEFORE deploying the new app build (the app now uses private Realtime channels).
-- Nothing about live sessions is stored; only her standing permission lives here.
-- ============================================================

-- ---------- Her standing permission (only she can write her own row) ----------
create table if not exists public.live_consent (
  sharer_id  uuid primary key references auth.users(id) on delete cascade,
  allowed    boolean not null default false,
  updated_at timestamptz default now()
);

alter table public.live_consent enable row level security;

drop policy if exists "members can read live consent" on public.live_consent;
create policy "members can read live consent"
  on public.live_consent for select to authenticated
  using (public.is_member());

drop policy if exists "sharer creates own consent" on public.live_consent;
create policy "sharer creates own consent"
  on public.live_consent for insert to authenticated
  with check (public.is_member() and sharer_id = auth.uid());

drop policy if exists "sharer changes own consent" on public.live_consent;
create policy "sharer changes own consent"
  on public.live_consent for update to authenticated
  using (sharer_id = auth.uid())
  with check (public.is_member() and sharer_id = auth.uid());

-- No delete policy: the row can only be switched off, not removed.

-- ---------- Realtime Authorization: private channels for members only ----------
-- live           live-view signaling (request / accept / offer / answer / ICE / end)
-- room           typing indicator
-- messages-feed  chat postgres_changes (table RLS still decides which rows arrive)
drop policy if exists "members read private channels" on realtime.messages;
create policy "members read private channels"
  on realtime.messages for select to authenticated
  using (
    public.is_member()
    and (select realtime.topic()) in ('live', 'room', 'messages-feed')
  );

drop policy if exists "members send on private channels" on realtime.messages;
create policy "members send on private channels"
  on realtime.messages for insert to authenticated
  with check (
    public.is_member()
    and (select realtime.topic()) in ('live', 'room')
  );
