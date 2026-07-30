import { useCallback, useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { JoinScreen } from './components/JoinScreen'
import { ChatView } from './components/ChatView'
import { isSupabaseConfigured } from './lib/supabase'
import './styles/app.css'

function Shell() {
  const { user, loading, activeRoomId, activeCode, leave } = useAuth()
  const [roomReady, setRoomReady] = useState(Boolean(activeRoomId))

  useEffect(() => {
    setRoomReady(Boolean(activeRoomId))
  }, [activeRoomId])

  useEffect(() => {
    const root = document.documentElement
    const vv = window.visualViewport
    const apply = () => {
      const h = vv?.height ?? window.innerHeight
      root.style.setProperty('--app-height', `${Math.round(h)}px`)
    }
    apply()
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
    }
  }, [])

  const onActivity = useCallback(() => {
    // reserved for future unread sync
  }, [])

  if (!isSupabaseConfigured) {
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <p className="brand">Pulse</p>
          <h1>Configure Supabase</h1>
          <p className="muted">Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in client/.env</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Loading…</p>
      </div>
    )
  }

  if (!user || !roomReady || !activeRoomId) {
    return <JoinScreen />
  }

  return (
    <div className="app-shell single-chat">
      <ChatView
        conversationId={activeRoomId}
        roomCode={activeCode}
        onBack={() => void leave()}
        onActivity={onActivity}
      />
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
