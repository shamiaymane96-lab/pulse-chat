import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isSupabaseConfigured } from '../lib/supabase'
import { hardRefreshApp } from '../lib/hardRefresh'
import { codeFromUrl, syncCodeInUrl } from '../lib/roomLink'

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
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
  const autoTried = useRef(false)

  useEffect(() => {
    const fromUrl = codeFromUrl()
    if (fromUrl) {
      setCode(fromUrl)
      syncCodeInUrl(fromUrl)
    }
  }, [])

  async function join(trimmedName: string, trimmedCode: string) {
    setError(null)
    if (!isSupabaseConfigured) {
      setError('Supabase is not configured')
      return
    }
    if (trimmedCode.length < 4) {
      setError('Enter a code with at least 4 characters')
      return
    }
    setBusy(true)
    try {
      localStorage.setItem('pulse_display_name', trimmedName)
      localStorage.setItem('pulse_max_people', String(maxPeople))
      const err = await joinWithCode(trimmedCode, trimmedName, maxPeople)
      if (err) {
        if (/invalid api key/i.test(err)) {
          setError('App cache is stale. Close all Pulse tabs, reopen the site, then try again.')
        } else {
          setError(err)
        }
        return
      }
      syncCodeInUrl(trimmedCode)
    } finally {
      setBusy(false)
    }
  }

  // Bookmark / shared link: open ?code=… and rejoin automatically when a name is saved
  useEffect(() => {
    if (autoTried.current || busy) return
    const fromUrl = codeFromUrl()
    if (!fromUrl || fromUrl.length < 4) return
    const savedName = (localStorage.getItem('pulse_display_name') ?? '').trim()
    if (!savedName) return
    autoTried.current = true
    void join(savedName, fromUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot auto join from bookmark
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    await join(displayName.trim() || 'Guest', code.trim())
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <p className="brand">Pulse</p>
        <h1>Enter the same code</h1>
        <p className="muted">
          Share one code. After you join, bookmark the page — the code stays in the link so you can reopen the room.
        </p>

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
              onChange={(e) => {
                const next = e.target.value.toUpperCase()
                setCode(next)
                syncCodeInUrl(next)
              }}
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
          {busy && codeFromUrl() && <p className="muted">Opening room…</p>}

          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Joining…' : 'Join chat'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              const next = randomCode()
              setCode(next)
              syncCodeInUrl(next)
            }}
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
