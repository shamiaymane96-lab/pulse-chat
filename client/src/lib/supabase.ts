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

// Keep Realtime JWT in sync — expired tokens silently stop send/receive filters
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
    if (session?.access_token) {
      void supabase.realtime.setAuth(session.access_token)
    }
  }
  if (event === 'SIGNED_OUT') {
    void supabase.realtime.setAuth(anon ?? null)
  }
})

export const isSupabaseConfigured = Boolean(url && anon)

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
    if (refreshed.session?.access_token) {
      await supabase.realtime.setAuth(refreshed.session.access_token)
    }
    return refreshed.session
  }

  if (session.access_token) {
    await supabase.realtime.setAuth(session.access_token)
  }
  return session
}
