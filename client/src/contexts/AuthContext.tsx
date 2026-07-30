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
import { ensureFreshSession, supabase } from '../lib/supabase'
import { clearOutboxForConversation } from '../lib/outbox'
import { codeFromUrl, syncCodeInUrl } from '../lib/roomLink'
import type { Profile } from '../lib/types'

type AuthContextValue = {
  session: Session | null
  user: User | null
  profile: Profile | null
  loading: boolean
  activeRoomId: string | null
  activeCode: string | null
  joinWithCode: (code: string, displayName: string, maxParticipants?: number) => Promise<string | null>
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

    async function boot() {
      const { data } = await supabase.auth.getSession()
      if (!mounted) return
      setSession(data.session)

      const urlCode = codeFromUrl()
      const savedCode = localStorage.getItem(CODE_KEY)
      const roomId = localStorage.getItem(ROOM_KEY)

      // Bookmarked ?code= wins over a different saved room
      if (urlCode && savedCode && urlCode !== savedCode && roomId) {
        try {
          await supabase.rpc('leave_room', { p_conversation_id: roomId })
        } catch {
          /* ignore */
        }
        clearOutboxForConversation(roomId)
        localStorage.removeItem(ROOM_KEY)
        localStorage.removeItem(CODE_KEY)
        setActiveRoomId(null)
        setActiveCode(null)
      } else if (data.session?.user && roomId) {
        const { data: membership } = await supabase
          .from('participants')
          .select('user_id')
          .eq('conversation_id', roomId)
          .eq('user_id', data.session.user.id)
          .maybeSingle()
        if (!membership) {
          localStorage.removeItem(ROOM_KEY)
          localStorage.removeItem(CODE_KEY)
          setActiveRoomId(null)
          setActiveCode(null)
        } else if (savedCode) {
          syncCodeInUrl(savedCode)
        }
      } else if (urlCode) {
        syncCodeInUrl(urlCode)
      }

      if (data.session?.user) {
        await loadProfile(data.session.user.id)
      }
      if (mounted) setLoading(false)
    }

    void boot()

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
    const id = window.setInterval(tick, 30_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void ensureFreshSession().catch(() => undefined)
        tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [session?.user?.id])

  const joinWithCode = useCallback(async (code: string, displayName: string, maxParticipants?: number) => {
    try {
      const nextSession = await ensureGuestSession()
      setSession(nextSession)

      const payload: {
        p_code: string
        p_display_name: string
        p_max_participants?: number
      } = {
        p_code: code,
        p_display_name: displayName,
      }
      if (typeof maxParticipants === 'number' && Number.isFinite(maxParticipants)) {
        payload.p_max_participants = Math.min(20, Math.max(2, Math.round(maxParticipants)))
      }

      const { data, error } = await supabase.rpc('join_room_by_code', payload)
      if (error) return error.message

      const roomId = data as string
      const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
      localStorage.setItem(ROOM_KEY, roomId)
      localStorage.setItem(CODE_KEY, normalized)
      setActiveRoomId(roomId)
      setActiveCode(normalized)
      syncCodeInUrl(normalized)
      await loadProfile(nextSession.user.id)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'Failed to join'
    }
  }, [loadProfile])

  const leave = useCallback(async () => {
    const roomId = localStorage.getItem(ROOM_KEY)
    if (roomId) {
      const { error } = await supabase.rpc('leave_room', { p_conversation_id: roomId })
      if (error) {
        console.error('leave_room failed', error.message)
      }
      clearOutboxForConversation(roomId)
    }
    localStorage.removeItem(ROOM_KEY)
    localStorage.removeItem(CODE_KEY)
    setActiveRoomId(null)
    setActiveCode(null)
    // Clear ?code= so Leave does not instantly auto-rejoin via JoinScreen
    syncCodeInUrl(null)
    // Keep anonymous session so rejoining later does not create a 3rd identity
  }, [])

  const setRoomCode = useCallback((code: string) => {
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    localStorage.setItem(CODE_KEY, normalized)
    setActiveCode(normalized)
    syncCodeInUrl(normalized)
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
