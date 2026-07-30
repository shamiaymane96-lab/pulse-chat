import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anon) {
  console.warn(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy client/.env.example to client/.env',
  )
}

export const supabase = createClient(url ?? '', anon ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 20,
    },
  },
  global: {
    headers: {
      'x-client-info': 'pulse-chat',
    },
  },
})

export const isSupabaseConfigured = Boolean(url && anon)

let lastRealtimeAuthToken: string | null = null

async function syncRealtimeAuth(token: string | null | undefined) {
  const next = token ?? null
  if (next === lastRealtimeAuthToken) return
  lastRealtimeAuthToken = next
  await supabase.realtime.setAuth(next)
}

// Keep Realtime JWT in sync — expired tokens silently stop send/receive filters
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
    void syncRealtimeAuth(session?.access_token)
  }
  if (event === 'SIGNED_OUT') {
    void syncRealtimeAuth(anon ?? null)
  }
})

export async function ensureFreshSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const session = data.session
  if (!session) return null

  const expiresAt = session.expires_at ?? 0
  const soon = expiresAt * 1000 - Date.now() < 60_000
  if (soon) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
    if (refreshErr) throw refreshErr
    await syncRealtimeAuth(refreshed.session?.access_token)
    return refreshed.session
  }

  // Only push auth to realtime when the token actually changed.
  // Calling setAuth on every poll tears down channels and causes Reconnecting flicker.
  await syncRealtimeAuth(session.access_token)
  return session
}
