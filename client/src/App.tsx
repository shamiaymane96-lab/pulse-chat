import { useCallback, useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { JoinScreen } from './components/JoinScreen'
import { ChatView } from './components/ChatView'
import { registerPushSubscription } from './lib/push'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import './styles/app.css'

function Shell() {
  const { user, loading, activeRoomId, activeCode, leave } = useAuth()
  const [roomReady, setRoomReady] = useState(Boolean(activeRoomId))

  useEffect(() => {
    setRoomReady(Boolean(activeRoomId))
  }, [activeRoomId])

  useEffect(() => {
    if (!user) return
    void registerPushSubscription(user.id, async (payload) => {
      await supabase.from('push_subscriptions').upsert(
        {
          user_id: user.id,
          endpoint: payload.endpoint,
          p256dh: payload.p256dh,
          auth: payload.auth,
        },
        { onConflict: 'endpoint' },
      )
    })
  }, [user])

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
