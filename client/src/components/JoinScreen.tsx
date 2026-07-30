import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isSupabaseConfigured } from '../lib/supabase'

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

function codeFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return (params.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function JoinScreen() {
  const { joinWithCode } = useAuth()
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('pulse_display_name') ?? '')
  const [code, setCode] = useState(() => codeFromUrl())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const fromUrl = codeFromUrl()
    if (fromUrl) setCode(fromUrl)
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!isSupabaseConfigured) {
      setError('Supabase is not configured')
      return
    }
    const trimmedName = displayName.trim() || 'Guest'
    const trimmedCode = code.trim()
    if (trimmedCode.length < 4) {
      setError('Enter a code with at least 4 characters')
      return
    }
    setBusy(true)
    try {
      localStorage.setItem('pulse_display_name', trimmedName)
      const err = await joinWithCode(trimmedCode, trimmedName)
      if (err) setError(err)
      else {
        const url = new URL(window.location.href)
        url.searchParams.delete('code')
        window.history.replaceState({}, '', url.pathname + url.search)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <p className="brand">Pulse</p>
        <h1>Enter the same code</h1>
        <p className="muted">Both devices type one shared code to meet in a private chat.</p>

        <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
          <label>
            Your name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alex"
              maxLength={32}
              autoComplete="nickname"
            />
          </label>
          <label>
            Room code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. BLUE42"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
              minLength={4}
              maxLength={12}
            />
          </label>

          {error && <p className="error">{error}</p>}

          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Joining…' : 'Join chat'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setCode(randomCode())}
          >
            Generate a new code
          </button>
        </form>
      </div>
    </div>
  )
}
