import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isSupabaseConfigured } from '../lib/supabase'
import { hardRefreshApp } from '../lib/hardRefresh'

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

const MAX_OPTIONS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20]

export function JoinScreen() {
  const { joinWithCode } = useAuth()
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('pulse_display_name') ?? '')
  const [code, setCode] = useState(() => codeFromUrl())
  const [maxPeople, setMaxPeople] = useState(() => {
    const saved = Number(localStorage.getItem('pulse_max_people') || '2')
    return MAX_OPTIONS.includes(saved) ? saved : 2
  })
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
      localStorage.setItem('pulse_max_people', String(maxPeople))
      // Capacity is applied only when this code creates (or reclaims) a room
      const err = await joinWithCode(trimmedCode, trimmedName, maxPeople)
      if (err) {
        if (/invalid api key/i.test(err)) {
          setError('App cache is stale. Close all Pulse tabs, reopen the site, then try again.')
        } else {
          setError(err)
        }
      } else {
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
        <p className="muted">Share one code. The first person to join sets how many people can enter.</p>

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
          <label>
            Max people
            <select
              value={maxPeople}
              onChange={(e) => setMaxPeople(Number(e.target.value))}
              aria-describedby="max-people-hint"
            >
              {MAX_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 2 ? '(1-to-1)' : 'people'}
                </option>
              ))}
            </select>
          </label>
          <p id="max-people-hint" className="field-hint">
            Used only when this code creates a new room. Existing rooms keep their limit.
          </p>

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
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => void hardRefreshApp()}
          >
            Refresh app
          </button>
        </form>
      </div>
    </div>
  )
}
