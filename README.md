# Pulse Chat

Live: **https://shamiaymane96-lab.github.io/pulse-chat/**

Code-based chat PWA: **GitHub Pages** + **Supabase** (anonymous auth, Postgres, Realtime, Storage).

## Features

- Shared room code (bookmark `?code=ROOM` to reopen)
- Choose max people (2–20) when creating a room
- Realtime text, images, files, voice notes
- Reply, reactions, delivery/seen receipts
- Offline send queue, in-app Refresh for mobile PWAs

## Setup

1. Create a Supabase project and enable **Anonymous** auth
2. Apply SQL under `supabase/migrations/` (in order) via SQL editor or CLI
3. Copy Project URL + anon key into `client/.env`:

```bash
cd client
copy .env.example .env
npm install
npm run dev
```

4. Deploy: build `client`, copy `dist/` → `docs/`, push `main` (Pages from `/docs`)

Add your Pages URL under Supabase **Authentication → URL configuration**.

## Layout

```
client/                 React + Vite PWA
docs/                   GitHub Pages static build
supabase/migrations/    Schema + RLS
```

## Notes

- Never put the **service role** key in the client
- Room codes are the access secret — treat them like invite links
- Free-tier Supabase limits apply
