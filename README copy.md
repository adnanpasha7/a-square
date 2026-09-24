# A ♥ A

A private chat and photo app for exactly two people. Next.js PWA + Supabase.
It installs to the home screen on iPhone and Android, with push notifications on both.

## What's in here

```
supabase/schema.sql              tables, RLS, storage bucket, realtime, read receipts
supabase/functions/notify/       edge function that sends push notifications
lib/                             supabase client, image compression, push, signed URLs
components/                      Login, Home (tabs), Chat, Gallery, Lightbox, Settings
public/sw.js                     service worker (push + notification taps)
public/manifest.webmanifest      PWA manifest
```

## Setup (about 30 minutes)

### 1. Supabase project
1. Create a project at supabase.com. Pick the Mumbai region (`ap-south-1`) for low latency.
2. **SQL Editor** → paste all of `supabase/schema.sql` → Run.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up".
   Nobody can create an account, even if they find your URL.
4. **Authentication → Users → Add user → Create new user** for both of you
   (tick "Auto Confirm User").
5. Back in the SQL Editor, run the two `insert into public.members` lines from the bottom of
   `schema.sql` with your real emails and names.

### 2. Push notification keys
```bash
npx web-push generate-vapid-keys
```
Keep both keys. The public one goes in the app's env, and the private one only in Supabase secrets.

### 3. Deploy the notify function
```bash
npm i -g supabase          # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF

supabase secrets set \
  VAPID_PUBLIC_KEY=... \
  VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:you@example.com \
  WEBHOOK_SECRET=$(openssl rand -hex 32)

supabase functions deploy notify --no-verify-jwt
```
Note the `WEBHOOK_SECRET` value; you need it in the next step.

### 4. Trigger it on new messages
**Database → Webhooks → Create a new hook** (in newer dashboards it's under **Integrations → Database Webhooks**):
- Table: `messages`, Events: **Insert**
- Type: **HTTP Request**, Method: **POST**
- URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/notify`
- HTTP header: `x-webhook-secret` = your `WEBHOOK_SECRET`

### 5. Run locally
```bash
cp .env.local.example .env.local   # fill in the three values
npm install
npm run dev
```
Push notifications need HTTPS, so test those after deploying.

### 6. Deploy
Push the repo to GitHub → import into Vercel → add the three `NEXT_PUBLIC_*` env vars → deploy.
Any static-capable host works; the app is fully client-side.

### 7. Install on the phones
- **iPhone (iOS 16.4+):** open the URL in **Safari** → Share → **Add to Home Screen**.
  Open it **from the home screen icon**, sign in, then **⋯ → Turn on notifications**.
  Push does not work in a regular Safari tab; iOS only allows it for home-screen apps.
- **Android:** open in **Chrome** → menu → **Install app** (or accept the install banner).
  Open it, sign in, then **⋯ → Turn on notifications**.
  If notifications arrive late, set Chrome's battery usage to "Unrestricted" in Android settings.

## How it works

- **Security:** Row Level Security plus a `members` allowlist. Every table and the photo bucket
  check `is_member()`, so even a valid Supabase account that isn't one of you two sees nothing.
  Messages can't be edited after sending; read receipts go through the `mark_read()` function.
- **Photos:** resized on the phone to 2048px JPEG (~300–600 KB) plus a 480px thumbnail, and
  uploaded to a private bucket under `photos/<user_id>/`. They're displayed through signed URLs
  that expire after 12 hours. HEIC from iPhones gets converted to JPEG by the photo picker.
- **Realtime:** Supabase Realtime pushes inserts and read-receipt updates. Phones kill the socket
  when the app is backgrounded, so the app also refetches recent messages whenever it comes
  back into view.
- **Login:** email and password, deliberately. Magic links on iOS open in Safari, which doesn't share
  a session with the home-screen app.

## Things to know

- **Free tier storage is 1 GB**, roughly 2,000 photos at these settings. After that, move to Pro
  ($25/mo, 100 GB) or lower the quality in `lib/image.ts`.
- **Free projects pause after a week of no activity.** Daily use keeps it awake; if you both go
  on a trip without it, you'll need to restore it from the dashboard.
- **Backups:** the free tier has no automatic backups. Run something like this monthly:
  `supabase db dump --data-only -f backup.sql`, and download the bucket with the storage API or `rclone`.
- If the edge function logs errors about `web-push` crypto, pin a different version in the import
  or swap to a Deno-native Web Push library. The rest of the function stays the same.

## Ideas for v2

Typing indicator (Realtime presence), reactions (a `reactions` table), search (Postgres full-text
on `body`), "on this day" photos, voice notes (MediaRecorder → same bucket), captions on photos.
