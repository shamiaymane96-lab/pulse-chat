import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

type AuthContextValue = {
  session: Session | null
  user: User | null
  profile: Profile | null
  loading: boolean
  activeRoomId: string | null
  activeCode: string | null
  joinWithCode: (code: string, displayName: string) => Promise<string | null>
  leave: () => Promise<void>
  setRoomCode: (code: string) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const ROOM_KEY = 'pulse_active_room'
const CODE_KEY = 'pulse_active_code'

async function ensureGuestSession() {
  const { data: existing } = await supabase.auth.getSession()
  if (existing.session) return existing.session

  const { data, error } = await supabase.auth.signInAnonymously()
  if (error || !data.session) {
    throw new Error(
      'Anonymous sign-in is off. In Supabase → Authentication → Sign In / Providers, enable Anonymous, then try again.',
    )
  }
  return data.session
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(() => localStorage.getItem(ROOM_KEY))
  const [activeCode, setActiveCode] = useState<string | null>(() => localStorage.getItem(CODE_KEY))

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, last_seen')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      console.error(error)
      setProfile(null)
      return
    }
    setProfile(data)
  }, [])

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      if (data.session?.user) {
        void loadProfile(data.session.user.id).finally(() => {
          if (mounted) setLoading(false)
        })
      } else {
        setLoading(false)
      }
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      if (next?.user) void loadProfile(next.user.id)
      else setProfile(null)
    })

    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [loadProfile])

  useEffect(() => {
    if (!session?.user?.id) return
    const tick = () => {
      void supabase
        .from('profiles')
        .update({ last_seen: new Date().toISOString() })
        .eq('id', session.user.id)
    }
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [session?.user?.id])

  const joinWithCode = useCallback(async (code: string, displayName: string) => {
    try {
      const nextSession = await ensureGuestSession()
      setSession(nextSession)

      const { data, error } = await supabase.rpc('join_room_by_code', {
        p_code: code,
        p_display_name: displayName,
      })
      if (error) return error.message

      const roomId = data as string
      const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
      localStorage.setItem(ROOM_KEY, roomId)
      localStorage.setItem(CODE_KEY, normalized)
      setActiveRoomId(roomId)
      setActiveCode(normalized)
      await loadProfile(nextSession.user.id)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'Failed to join'
    }
  }, [loadProfile])

  const leave = useCallback(async () => {
    localStorage.removeItem(ROOM_KEY)
    localStorage.removeItem(CODE_KEY)
    setActiveRoomId(null)
    setActiveCode(null)
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  const setRoomCode = useCallback((code: string) => {
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    localStorage.setItem(CODE_KEY, normalized)
    setActiveCode(normalized)
  }, [])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      activeRoomId,
      activeCode,
      joinWithCode,
      leave,
      setRoomCode,
    }),
    [session, profile, loading, activeRoomId, activeCode, joinWithCode, leave, setRoomCode],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
