import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Attachment, Message, Profile, Reaction } from '../lib/types'
import {
  base64ToFile,
  clearOutboxForConversation,
  enqueueOutbox,
  fileToBase64,
  listOutbox,
  removeOutbox,
} from '../lib/outbox'
import { useAuth } from '../contexts/AuthContext'
import { Composer } from './Composer'
import { ImageLightbox } from './ImageLightbox'

type Props = {
  conversationId: string
  roomCode?: string | null
  onBack: () => void
  onActivity: () => void
}

const REACTION_SET = ['👍', '❤️', '😂', '🔥', '😮']

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

function ticksFor(m: Message) {
  if (m.localStatus === 'pending' || m.localStatus === 'uploading') return '…'
  if (m.localStatus === 'failed') return '!'
  if (m.seen_at) return '✓✓'
  if (m.delivered_at) return '✓✓'
  return '✓'
}

function outboxToLocalMessages(conversationId: string, senderId: string): Message[] {
  return listOutbox(conversationId).map((item) => {
    const file =
      item.fileBase64 && item.fileName
        ? base64ToFile(item.fileBase64, item.fileName, item.fileType || 'application/octet-stream')
        : null
    return {
      id: item.clientId,
      clientId: item.clientId,
      conversation_id: conversationId,
      sender_id: senderId,
      body: item.body || item.fileName || null,
      created_at: item.createdAt,
      delivered_at: null,
      seen_at: null,
      reply_to_id: item.replyToId,
      attachments: file
        ? [
            {
              id: `${item.clientId}-file`,
              message_id: item.clientId,
              storage_path: '',
              mime_type: file.type,
              size_bytes: file.size,
              file_name: file.name,
              signed_url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
            },
          ]
        : [],
      localStatus: 'pending' as const,
    } satisfies Message
  })
}

function mergeServerWithLocals(server: Message[], locals: Message[]) {
  const serverIds = new Set(server.map((m) => m.id))
  const kept = locals.filter((m) => {
    const id = m.clientId ?? m.id
    return Boolean(m.localStatus) && m.localStatus !== 'sent' && !serverIds.has(id)
  })
  const unique = kept.filter(
    (m, i, arr) => arr.findIndex((x) => (x.clientId ?? x.id) === (m.clientId ?? m.id)) === i,
  )
  return [...server, ...unique].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export function ChatView({ conversationId, roomCode, onBack, onActivity }: Props) {
  const { user, setRoomCode } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [other, setOther] = useState<Profile | null>(null)
  const [peerCount, setPeerCount] = useState(1)
  const [peerTyping, setPeerTyping] = useState(false)
  const [peerOnline, setPeerOnline] = useState(false)
  const [peerLastRead, setPeerLastRead] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [hiddenUnread, setHiddenUnread] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const bottomRef = useRef<HTMLDivElement>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const baseTitle = useRef(document.title)
  const flushing = useRef(false)
  const messageIdsRef = useRef<string[]>([])

  useEffect(() => {
    messageIdsRef.current = messages.map((m) => m.id).filter((id) => id.length > 20)
  }, [messages])

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

  const enrichMessages = useCallback(async (rows: Message[]) => {
    const ids = rows.map((r) => r.id)
    const replyIds = rows.map((r) => r.reply_to_id).filter(Boolean) as string[]

    const [{ data: files }, { data: reactions }, { data: replies }] = await Promise.all([
      ids.length
        ? supabase
            .from('attachments')
            .select('id, message_id, storage_path, mime_type, size_bytes, file_name')
            .in('message_id', ids)
        : Promise.resolve({ data: [] as Attachment[] }),
      ids.length
        ? supabase.from('reactions').select('message_id, user_id, emoji').in('message_id', ids)
        : Promise.resolve({ data: [] as Reaction[] }),
      replyIds.length
        ? supabase.from('messages').select('id, body, sender_id').in('id', replyIds)
        : Promise.resolve({ data: [] as { id: string; body: string | null; sender_id: string }[] }),
    ])

    const filesByMsg = new Map<string, Attachment[]>()
    for (const f of files ?? []) {
      const { data: signed } = await supabase.storage.from('chat-files').createSignedUrl(f.storage_path, 3600)
      const list = filesByMsg.get(f.message_id) ?? []
      list.push({ ...f, signed_url: signed?.signedUrl })
      filesByMsg.set(f.message_id, list)
    }

    const reactionsByMsg = new Map<string, Reaction[]>()
    for (const r of reactions ?? []) {
      const list = reactionsByMsg.get(r.message_id) ?? []
      list.push(r)
      reactionsByMsg.set(r.message_id, list)
    }

    const replyMap = new Map((replies ?? []).map((r) => [r.id, r]))

    return rows.map((msg) => ({
      ...msg,
      attachments: filesByMsg.get(msg.id) ?? [],
      reactions: reactionsByMsg.get(msg.id) ?? [],
      reply_preview: msg.reply_to_id ? replyMap.get(msg.reply_to_id) ?? null : null,
      localStatus: 'sent' as const,
    })) as Message[]
  }, [])

  const refreshParticipants = useCallback(async () => {
    if (!user) return
    const { data: parts } = await supabase
      .from('participants')
      .select('user_id, last_read_at, profiles(id, username, display_name, avatar_url, last_seen)')
      .eq('conversation_id', conversationId)

    const rows = parts ?? []
    setPeerCount(rows.length)
    const otherRow = rows.find((p) => p.user_id !== user.id)
    setOther((otherRow?.profiles as unknown as Profile | undefined) ?? null)
    setPeerLastRead((otherRow?.last_read_at as string | null) ?? null)
  }, [conversationId, user])

  const markSeen = useCallback(async () => {
    if (!user || document.visibilityState !== 'visible') return
    await supabase.rpc('mark_messages_seen', { p_conversation_id: conversationId })
    onActivity()
  }, [conversationId, onActivity, user])

  const upsertMessage = useCallback((incoming: Message) => {
    setMessages((prev) => {
      const withoutDup = prev.filter((m) => m.id !== incoming.id && m.clientId !== incoming.clientId)
      return [...withoutDup, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at))
    })
  }, [])

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
        await navigator.share({ title: 'Pulse chat', text: shareText })
        return
      } catch {
        /* fallthrough */
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

  const sendNow = useCallback(
    async (body: string, file: File | null, replyToId: string | null, clientId: string) => {
      if (!user) return

      setMessages((prev) =>
        prev.map((m) =>
          m.clientId === clientId
            ? {
                ...m,
                localStatus: (file ? 'uploading' : 'pending') as Message['localStatus'],
                localProgress: file ? 15 : 40,
              }
            : m,
        ),
      )

      const { data: inserted, error: insertErr } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: body || (file ? file.name : null),
          reply_to_id: replyToId,
        })
        .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id')
        .single()

      if (insertErr || !inserted) throw new Error(insertErr?.message ?? 'Failed to send')

      if (file) {
        setMessages((prev) =>
          prev.map((m) => (m.clientId === clientId ? { ...m, localProgress: 55, localStatus: 'uploading' } : m)),
        )
        const safeName = file.name.replace(/[^\w.\-]+/g, '_')
        const path = `${conversationId}/${inserted.id}/${safeName}`
        const { error: upErr } = await supabase.storage.from('chat-files').upload(path, file, {
          contentType: file.type || 'application/octet-stream',
          upsert: false,
        })
        if (upErr) {
          await supabase.from('messages').delete().eq('id', inserted.id)
          throw new Error(upErr.message)
        }
        const { error: attErr } = await supabase.from('attachments').insert({
          message_id: inserted.id,
          storage_path: path,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
          file_name: file.name,
        })
        if (attErr) {
          await supabase.from('messages').delete().eq('id', inserted.id)
          throw new Error(attErr.message)
        }
      }

      const [enriched] = await enrichMessages([inserted as Message])
      removeOutbox(clientId)
      setMessages((prev) => {
        const withoutLocal = prev.filter((m) => m.clientId !== clientId && m.id !== enriched.id)
        const next: Message = { ...enriched, localStatus: 'sent', localProgress: 100 }
        return [...withoutLocal, next].sort((a, b) => a.created_at.localeCompare(b.created_at))
      })
      onActivity()
    },
    [conversationId, enrichMessages, onActivity, user],
  )

  const queueOrSend = useCallback(
    async (body: string, file: File | null, replyToId: string | null) => {
      if (!user) return
      const clientId = crypto.randomUUID()
      const optimistic: Message = {
        id: clientId,
        clientId,
        conversation_id: conversationId,
        sender_id: user.id,
        body: body || (file ? file.name : null),
        created_at: new Date().toISOString(),
        delivered_at: null,
        seen_at: null,
        reply_to_id: replyToId,
        attachments: file
          ? [
              {
                id: `${clientId}-file`,
                message_id: clientId,
                storage_path: '',
                mime_type: file.type || 'application/octet-stream',
                size_bytes: file.size,
                file_name: file.name,
                signed_url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
              },
            ]
          : [],
        localStatus: navigator.onLine ? (file ? 'uploading' : 'pending') : 'pending',
        localProgress: 5,
        reply_preview: replyToId
          ? messages.find((m) => m.id === replyToId)
            ? {
                id: replyToId,
                body: messages.find((m) => m.id === replyToId)?.body ?? null,
                sender_id: messages.find((m) => m.id === replyToId)?.sender_id ?? '',
              }
            : null
          : null,
      }
      upsertMessage(optimistic)

      if (!navigator.onLine) {
        enqueueOutbox({
          clientId,
          conversationId,
          body,
          replyToId,
          fileName: file?.name,
          fileType: file?.type,
          fileBase64: file ? await fileToBase64(file) : undefined,
          createdAt: optimistic.created_at,
        })
        return
      }

      try {
        await sendNow(body, file, replyToId, clientId)
      } catch (err) {
        enqueueOutbox({
          clientId,
          conversationId,
          body,
          replyToId,
          fileName: file?.name,
          fileType: file?.type,
          fileBase64: file ? await fileToBase64(file) : undefined,
          createdAt: optimistic.created_at,
        })
        setMessages((prev) =>
          prev.map((m) => (m.clientId === clientId ? { ...m, localStatus: 'failed', localProgress: 0 } : m)),
        )
        setError(err instanceof Error ? err.message : 'Send failed — will retry when online')
      }
    },
    [conversationId, messages, sendNow, upsertMessage, user],
  )

  const flushOutbox = useCallback(async () => {
    if (!user || flushing.current || !navigator.onLine) return
    flushing.current = true
    try {
      const items = listOutbox(conversationId)
      for (const item of items) {
        const file =
          item.fileBase64 && item.fileName
            ? base64ToFile(item.fileBase64, item.fileName, item.fileType || 'application/octet-stream')
            : null
        try {
          await sendNow(item.body, file, item.replyToId, item.clientId)
        } catch {
          setMessages((prev) =>
            prev.map((m) => (m.clientId === item.clientId ? { ...m, localStatus: 'failed' } : m)),
          )
        }
      }
    } finally {
      flushing.current = false
    }
  }, [conversationId, sendNow, user])

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function bootstrap() {
      setLoading(true)
      setError(null)
      await refreshParticipants()

      const { data: rows, error: err } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(300)

      if (err) {
        if (!cancelled) {
          setError(err.message)
          setLoading(false)
        }
        return
      }

      const enriched = await enrichMessages((rows as Message[]) ?? [])
      const pendingLocal = outboxToLocalMessages(conversationId, user!.id)

      if (!cancelled) {
        setMessages(mergeServerWithLocals(enriched, pendingLocal))
        setLoading(false)
      }
      await markSeen()
      void flushOutbox()
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [conversationId, enrichMessages, flushOutbox, markSeen, refreshParticipants, user])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, peerTyping, waitingForPeer])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        setHiddenUnread(0)
        document.title = baseTitle.current
        void markSeen()
      }
    }
    const onOnline = () => {
      setOnline(true)
      void flushOutbox()
    }
    const onOffline = () => setOnline(false)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [flushOutbox, markSeen])

  useEffect(() => {
    if (hiddenUnread > 0 && document.visibilityState === 'hidden') {
      document.title = `(${hiddenUnread}) Pulse`
    } else {
      document.title = baseTitle.current
    }
  }, [hiddenUnread])

  useEffect(() => {
    if (!user) return

    const channel = supabase.channel(`room:${conversationId}`, {
      config: { presence: { key: user.id } },
    })

    channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const msg = payload.new as Message
          void (async () => {
            // Own inserts still matter for multi-tab; skip receipt/unread for self
            await new Promise((r) => window.setTimeout(r, 350))
            const [enriched] = await enrichMessages([msg])
            upsertMessage(enriched)
            if (msg.sender_id === user.id) return
            await supabase.rpc('mark_message_delivered', { p_message_id: msg.id })
            if (document.visibilityState === 'hidden') setHiddenUnread((n) => n + 1)
            else void markSeen()
            onActivity()
          })()
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const msg = payload.new as Message
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.id
                ? { ...m, delivered_at: msg.delivered_at, seen_at: msg.seen_at, body: msg.body }
                : m,
            ),
          )
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'participants', filter: `conversation_id=eq.${conversationId}` },
        () => {
          void refreshParticipants()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions' },
        () => {
          void (async () => {
            const ids = messageIdsRef.current
            if (!ids.length) return
            const { data } = await supabase
              .from('reactions')
              .select('message_id, user_id, emoji')
              .in('message_id', ids)
            const byMsg = new Map<string, Reaction[]>()
            for (const r of data ?? []) {
              const list = byMsg.get(r.message_id) ?? []
              list.push(r)
              byMsg.set(r.message_id, list)
            }
            setMessages((prev) =>
              prev.map((m) => ({
                ...m,
                // Always replace from fetch so removed reactions clear for peers
                reactions: byMsg.get(m.id) ?? [],
              })),
            )
          })()
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        () => {
          // bulk clears arrive as deletes; reload and keep local outbox bubbles
          void (async () => {
            const { data: rows } = await supabase
              .from('messages')
              .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id')
              .eq('conversation_id', conversationId)
              .order('created_at', { ascending: true })
            const enriched = await enrichMessages((rows as Message[]) ?? [])
            setMessages((prev) => {
              const hadServer = prev.some((m) => !m.localStatus || m.localStatus === 'sent')
              // Peer/local clear wiped the room — drop queued sends so they don't resurrect
              if (hadServer && enriched.length === 0) {
                clearOutboxForConversation(conversationId)
                return []
              }
              const liveLocals = prev.filter(
                (m) => m.localStatus === 'pending' || m.localStatus === 'failed' || m.localStatus === 'uploading',
              )
              const fromOutbox = user ? outboxToLocalMessages(conversationId, user.id) : []
              return mergeServerWithLocals(enriched, [...liveLocals, ...fromOutbox])
            })
          })()
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
  }, [conversationId, enrichMessages, markSeen, onActivity, refreshParticipants, upsertMessage, user])

  async function setTyping(typing: boolean) {
    const channel = channelRef.current
    if (!channel) return
    await channel.track({ typing, online_at: new Date().toISOString() })
  }

  async function toggleReaction(messageId: string, emoji: string) {
    await supabase.rpc('toggle_reaction', { p_message_id: messageId, p_emoji: emoji })
    setMenuFor(null)
    const { data } = await supabase
      .from('reactions')
      .select('message_id, user_id, emoji')
      .eq('message_id', messageId)
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: data ?? [] } : m)))
  }

  async function clearChat() {
    if (!confirm('Clear all messages in this room?')) return
    const { error: err } = await supabase.rpc('clear_room_messages', { p_conversation_id: conversationId })
    if (err) {
      setError(err.message)
      return
    }
    clearOutboxForConversation(conversationId)
    setMessages([])
  }

  async function regenerateCode() {
    if (!confirm('Generate a new room code? The old code will stop working.')) return
    const { data, error: err } = await supabase.rpc('regenerate_room_code', {
      p_conversation_id: conversationId,
    })
    if (err) {
      setError(err.message)
      return
    }
    setRoomCode(String(data))
  }

  function receiptLabel(m: Message) {
    if (!user || m.sender_id !== user.id) return null
    if (m.localStatus === 'failed') return 'Failed — will retry'
    if (m.localStatus === 'uploading') return `Uploading ${m.localProgress ?? 0}%`
    if (m.localStatus === 'pending') return online ? 'Sending…' : 'Waiting for network'
    if (m.seen_at || (peerLastRead && peerLastRead >= m.created_at)) return 'Seen'
    if (m.delivered_at) return 'Delivered'
    return 'Sent'
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
            {!online ? 'Offline · queued sends' : ''}
            {online && waitingForPeer
              ? 'Only you are here'
              : online && peerTyping
                ? 'typing…'
                : online && peerOnline
                  ? 'online'
                  : online && other
                    ? 'last seen recently'
                    : online
                      ? ' '
                      : ''}
          </p>
        </div>
        <div className="header-actions">
          {roomCode && (
            <>
              <button type="button" className="btn ghost icon-btn" onClick={() => void copyCode()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn ghost icon-btn" onClick={() => void shareCode()}>
                Share
              </button>
            </>
          )}
          <button type="button" className="btn ghost icon-btn" onClick={() => void clearChat()} title="Clear chat">
            Clear
          </button>
          <button type="button" className="btn ghost icon-btn" onClick={() => void regenerateCode()} title="New code">
            New
          </button>
        </div>
      </header>

      <div className="message-scroller">
        {loading && <p className="muted pad">Loading messages…</p>}
        {error && <p className="error pad">{error}</p>}

        {!loading && waitingForPeer && (
          <div className="waiting-card">
            <p className="brand-sm">Pulse</p>
            <h2>Waiting for the other person</h2>
            <p className="muted">Share this code so they can join from any device.</p>
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
              m.body && !(audio && (m.body === 'Voice note' || m.body === audio.file_name))
            const grouped = new Map<string, number>()
            for (const r of m.reactions ?? []) grouped.set(r.emoji, (grouped.get(r.emoji) ?? 0) + 1)
            const canAct = !m.clientId && m.localStatus !== 'pending' && m.localStatus !== 'uploading' && m.localStatus !== 'failed'
            const status = receiptLabel(m)

            return (
              <div key={m.clientId ?? m.id} className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
                <div className={`bubble ${mine ? 'mine' : 'theirs'} ${m.localStatus === 'failed' ? 'failed' : ''}`}>
                  {m.reply_preview && (
                    <div className="reply-quote">{(m.reply_preview.body || 'Attachment').slice(0, 80)}</div>
                  )}
                  {showBody && <p>{m.body}</p>}
                  {m.attachments?.map((a) => (
                    <div key={a.id} className="attachment">
                      {isImage(a.mime_type) && a.signed_url ? (
                        <button
                          type="button"
                          className="image-thumb-btn"
                          onClick={() => setLightbox({ src: a.signed_url!, alt: a.file_name })}
                        >
                          <img src={a.signed_url} alt={a.file_name} />
                        </button>
                      ) : isAudio(a.mime_type) && a.signed_url ? (
                        <audio className="voice-player" controls preload="metadata" src={a.signed_url} />
                      ) : a.signed_url ? (
                        <a href={a.signed_url} target="_blank" rel="noreferrer" className="file-link">
                          {a.file_name} ({formatBytes(a.size_bytes)})
                        </a>
                      ) : (
                        <span className="muted">{a.file_name}</span>
                      )}
                    </div>
                  ))}
                  {(m.localStatus === 'uploading' || m.localStatus === 'pending') && (
                    <div className="upload-bar">
                      <span style={{ width: `${m.localProgress ?? 20}%` }} />
                    </div>
                  )}
                  {grouped.size > 0 && (
                    <div className="reaction-row">
                      {[...grouped.entries()].map(([emoji, count]) => (
                        <button
                          key={emoji}
                          type="button"
                          className="reaction-pill"
                          disabled={!canAct}
                          onClick={() => void toggleReaction(m.id, emoji)}
                        >
                          {emoji} {count > 1 ? count : ''}
                        </button>
                      ))}
                    </div>
                  )}
                  <footer>
                    {canAct && (
                      <>
                        <button type="button" className="msg-action" onClick={() => setReplyTo(m)}>
                          Reply
                        </button>
                        <button
                          type="button"
                          className="msg-action"
                          onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}
                        >
                          React
                        </button>
                      </>
                    )}
                    <time>{formatTime(m.created_at)}</time>
                    {mine && (
                      <span className={`ticks ${m.seen_at || (peerLastRead && peerLastRead >= m.created_at) ? 'seen' : ''}`}>
                        {ticksFor(m)}
                      </span>
                    )}
                  </footer>
                  {status && <p className="receipt-label">{status}</p>}
                  {menuFor === m.id && canAct && (
                    <div className="react-menu">
                      {REACTION_SET.map((emoji) => (
                        <button key={emoji} type="button" onClick={() => void toggleReaction(m.id, emoji)}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        <div ref={bottomRef} />
      </div>

      <Composer
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={(body, file, replyId) => queueOrSend(body, file, replyId)}
        onTyping={(t) => {
          void setTyping(t)
        }}
      />

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </section>
  )
}
