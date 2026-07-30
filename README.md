# Pulse Chat

WhatsApp-like messaging PWA: **GitHub Pages** (frontend) + **Supabase** (auth, Postgres, realtime, storage, push).

## Phase 1 features

- Shared room code (both devices enter the same code — no email/password)
- Real-time 1:1 text messages (max 2 people per code)
- File / image transfer (up to 50MB)
- Online + typing via Presence
- Delivery ticks
- Installable PWA shell
- Optional Web Push via Edge Function

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql)
3. In **Authentication → Providers**, enable **Anonymous** sign-ins (recommended)
4. Copy **Project URL** and **anon public** key from **Project Settings → API**
5. Both devices open the app, enter a name + the same room code, and chat

### 2. Local app

```bash
cd client
copy .env.example .env
# fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Open the printed localhost URL. Create two accounts in two browsers and start a chat with `+`.

### 3. GitHub Pages deploy

1. Push this repo to GitHub
2. Repo **Settings → Pages → Source**: GitHub Actions
3. Add Actions secrets:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_VAPID_PUBLIC_KEY` (optional until push is wired)
4. Push to `main` (or run the **Deploy Pulse Chat to GitHub Pages** workflow)

In Supabase **Authentication → URL configuration**, add your Pages URL to **Site URL** and **Redirect URLs**.

### 4. Web Push (optional)

1. Generate VAPID keys (`npx web-push generate-vapid-keys`)
2. Set client `VITE_VAPID_PUBLIC_KEY`
3. Deploy function:

```bash
supabase functions deploy push-notify
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
```

4. In Supabase Dashboard → **Database → Webhooks**, create a webhook on `messages` INSERT pointing to the `push-notify` function URL

## Project layout

```
client/                 React + Vite PWA
supabase/migrations/    Schema + RLS + storage policies
supabase/functions/     push-notify Edge Function
.github/workflows/      GitHub Pages deploy
```

## Notes

- Never expose the Supabase **service role** key in the client
- RLS keeps chats private to conversation participants
- Free-tier limits apply (DB size, storage, realtime)
