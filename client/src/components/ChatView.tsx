import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Attachment, Message, Profile } from '../lib/types'
import { useAuth } from '../contexts/AuthContext'
import { Composer } from './Composer'

type Props = {
  conversationId: string
  roomCode?: string | null
  onBack: () => void
  onActivity: () => void
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function isAudio(mime: string) {
  return mime.startsWith('audio/')
}

function isImage(mime: string) {
  return mime.startsWith('image/')
}

export function ChatView({ conversationId, roomCode, onBack, onActivity }: Props) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [other, setOther] = useState<Profile | null>(null)
  const [peerCount, setPeerCount] = useState(1)
  const [peerTyping, setPeerTyping] = useState(false)
  const [peerOnline, setPeerOnline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)

  const waitingForPeer = peerCount < 2

  const title = useMemo(() => {
    if (other?.display_name) return other.display_name
    if (waitingForPeer) return 'Waiting for peer…'
    if (roomCode) return `Code ${roomCode}`
    return 'Chat'
  }, [other, roomCode, waitingForPeer])

  const shareText = useMemo(() => {
    const code = roomCode ?? ''
    const link = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code)}`
    return `Join my Pulse chat with code ${code}\n${link}`
  }, [roomCode])

  const refreshParticipants = useCallback(async () => {
    if (!user) return
    const { data: parts } = await supabase
      .from('participants')
      .select('user_id, profiles(id, username, display_name, avatar_url, last_seen)')
      .eq('conversation_id', conversationId)

    const rows = parts ?? []
    setPeerCount(rows.length)
    const otherRow = rows.find((p) => p.user_id !== user.id)
    setOther((otherRow?.profiles as unknown as Profile | undefined) ?? null)
  }, [conversationId, user])

  const attachSignedUrls = useCallback(async (rows: Message[]) => {
    const withFiles: Message[] = []
    for (const msg of rows) {
      const { data: files } = await supabase
        .from('attachments')
        .select('id, message_id, storage_path, mime_type, size_bytes, file_name')
        .eq('message_id', msg.id)

      const attachments: Attachment[] = []
      for (const f of files ?? []) {
        const { data: signed } = await supabase.storage
          .from('chat-files')
          .createSignedUrl(f.storage_path, 3600)
        attachments.push({ ...f, signed_url: signed?.signedUrl })
      }
      withFiles.push({ ...msg, attachments })
    }
    return withFiles
  }, [])

  const markRead = useCallback(async () => {
    if (!user) return
    await supabase
      .from('participants')
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
    onActivity()
  }, [conversationId, onActivity, user])

  const markDelivered = useCallback(
    async (msg: Message) => {
      if (!user || msg.sender_id === user.id || msg.delivered_at) return
      await supabase
        .from('messages')
        .update({ delivered_at: new Date().toISOString() })
        .eq('id', msg.id)
        .is('delivered_at', null)
    },
    [user],
  )

  async function copyCode() {
    if (!roomCode) return
    try {
      await navigator.clipboard.writeText(roomCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      window.prompt('Copy this code', roomCode)
    }
  }

  async function shareCode() {
    if (!roomCode) return
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Pulse chat',
          text: shareText,
        })
        return
      } catch {
        // fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      window.prompt('Share this', shareText)
    }
  }

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function bootstrap() {
      setLoading(true)
      setError(null)
      await refreshParticipants()

      const { data: rows, error: err } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_id, body, created_at, delivered_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(200)

      if (err) {
        if (!cancelled) {
          setError(err.message)
          setLoading(false)
        }
        return
      }

      const enriched = await attachSignedUrls((rows as Message[]) ?? [])
      if (!cancelled) {
        setMessages(enriched)
        setLoading(false)
      }

      for (const m of enriched) void markDelivered(m)
      await markRead()
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [attachSignedUrls, conversationId, markDelivered, markRead, refreshParticipants, user])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, peerTyping, waitingForPeer])

  useEffect(() => {
    if (!user) return

    const channel = supabase.channel(`room:${conversationId}`, {
      config: { presence: { key: user.id } },
    })

    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const msg = payload.new as Message
          void (async () => {
            let enriched = (await attachSignedUrls([msg]))[0]
            if (!enriched.attachments?.length) {
              await new Promise((r) => window.setTimeout(r, 450))
              enriched = (await attachSignedUrls([msg]))[0]
            }
            setMessages((prev) => {
              if (prev.some((m) => m.id === enriched.id)) return prev
              return [...prev, enriched]
            })
            void markDelivered(enriched)
            if (enriched.sender_id !== user.id) void markRead()
            onActivity()
          })()
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const msg = payload.new as Message
          setMessages((prev) =>
            prev.map((m) => (m.id === msg.id ? { ...m, delivered_at: msg.delivered_at } : m)),
          )
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'participants',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          void refreshParticipants()
        },
      )
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<{ typing?: boolean }>()
        const others = Object.entries(state).filter(([key]) => key !== user.id)
        setPeerOnline(others.length > 0)
        setPeerTyping(others.some(([, metas]) => metas.some((m) => m.typing)))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ typing: false, online_at: new Date().toISOString() })
        }
      })

    channelRef.current = channel
    return () => {
      void supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [attachSignedUrls, conversationId, markDelivered, markRead, onActivity, refreshParticipants, user])

  async function sendMessage(body: string, file: File | null) {
    if (!user) return
    setError(null)

    const { data: inserted, error: insertErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: body || (file ? file.name : null),
      })
      .select('id, conversation_id, sender_id, body, created_at, delivered_at')
      .single()

    if (insertErr || !inserted) {
      setError(insertErr?.message ?? 'Failed to send')
      return
    }

    if (file) {
      const safeName = file.name.replace(/[^\w.\-]+/g, '_')
      const path = `${conversationId}/${inserted.id}/${safeName}`
      const { error: upErr } = await supabase.storage.from('chat-files').upload(path, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      })
      if (upErr) {
        setError(upErr.message)
      } else {
        await supabase.from('attachments').insert({
          message_id: inserted.id,
          storage_path: path,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
          file_name: file.name,
        })
      }
    }

    const [enriched] = await attachSignedUrls([inserted as Message])
    setMessages((prev) => {
      if (prev.some((m) => m.id === enriched.id)) return prev
      return [...prev, enriched]
    })
    onActivity()
  }

  async function setTyping(typing: boolean) {
    const channel = channelRef.current
    if (!channel) return
    await channel.track({ typing, online_at: new Date().toISOString() })
  }

  return (
    <section className="chat-view">
      <header className="chat-header">
        <button type="button" className="btn ghost back" onClick={onBack} title="Leave room">
          Leave
        </button>
        <div className="chat-header-main">
          <strong>{title}</strong>
          <p className="muted status-line">
            {waitingForPeer
              ? 'Only you are here'
              : peerTyping
                ? 'typing…'
                : peerOnline
                  ? 'online'
                  : other
                    ? 'last seen recently'
                    : ' '}
          </p>
        </div>
        {roomCode && (
          <div className="header-actions">
            <button type="button" className="btn ghost icon-btn" onClick={() => void copyCode()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn ghost icon-btn" onClick={() => void shareCode()}>
              Share
            </button>
          </div>
        )}
      </header>

      <div className="message-scroller">
        {loading && <p className="muted pad">Loading messages…</p>}
        {error && <p className="error pad">{error}</p>}

        {!loading && waitingForPeer && (
          <div className="waiting-card">
            <p className="brand-sm">Pulse</p>
            <h2>Waiting for the other person</h2>
            <p className="muted">
              Share this code so they can join from any device. Chat unlocks when they enter it.
            </p>
            <p className="waiting-code">{roomCode}</p>
            <div className="waiting-actions">
              <button type="button" className="btn primary" onClick={() => void copyCode()}>
                {copied ? 'Copied!' : 'Copy code'}
              </button>
              <button type="button" className="btn ghost" onClick={() => void shareCode()}>
                Share
              </button>
            </div>
          </div>
        )}

        {!loading &&
          messages.map((m) => {
            const mine = m.sender_id === user?.id
            const audio = m.attachments?.find((a) => isAudio(a.mime_type))
            const showBody =
              m.body &&
              !(audio && (m.body === 'Voice note' || m.body === audio.file_name))

            return (
              <div key={m.id} className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
                <div className={`bubble ${mine ? 'mine' : 'theirs'}`}>
                  {showBody && <p>{m.body}</p>}
                  {m.attachments?.map((a) => (
                    <div key={a.id} className="attachment">
                      {isImage(a.mime_type) && a.signed_url ? (
                        <a href={a.signed_url} target="_blank" rel="noreferrer">
                          <img src={a.signed_url} alt={a.file_name} />
                        </a>
                      ) : isAudio(a.mime_type) && a.signed_url ? (
                        <audio className="voice-player" controls preload="metadata" src={a.signed_url} />
                      ) : (
                        <a href={a.signed_url} target="_blank" rel="noreferrer" className="file-link">
                          {a.file_name} ({formatBytes(a.size_bytes)})
                        </a>
                      )}
                    </div>
                  ))}
                  <footer>
                    <time>{formatTime(m.created_at)}</time>
                    {mine && <span className="ticks">{m.delivered_at ? '✓✓' : '✓'}</span>}
                  </footer>
                </div>
              </div>
            )
          })}
        <div ref={bottomRef} />
      </div>

      <Composer
        onSend={sendMessage}
        onTyping={(t) => {
          void setTyping(t)
        }}
      />
    </section>
  )
}
