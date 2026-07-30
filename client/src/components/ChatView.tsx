import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, ensureFreshSession } from '../lib/supabase'
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

function revokeBlobUrlsFromMessages(msgs: Message[]) {
  for (const m of msgs) {
    for (const a of m.attachments ?? []) {
      if (a.signed_url?.startsWith('blob:')) URL.revokeObjectURL(a.signed_url)
    }
  }
}

export function ChatView({ conversationId, roomCode, onBack, onActivity }: Props) {
  const { user, setRoomCode } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [other, setOther] = useState<Profile | null>(null)
  const [others, setOthers] = useState<Profile[]>([])
  const [peerCount, setPeerCount] = useState(1)
  const [maxParticipants, setMaxParticipants] = useState(2)
  const [peerTyping, setPeerTyping] = useState(false)
  const [peerOnline, setPeerOnline] = useState(false)
  const [peerLastRead, setPeerLastRead] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [hiddenUnread, setHiddenUnread] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const [rtEpoch, setRtEpoch] = useState(0)
  const [syncState, setSyncState] = useState<'live' | 'reconnecting' | 'polling'>('reconnecting')
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const messagesRef = useRef<Message[]>([])
  const baseTitle = useRef(document.title)
  const flushing = useRef(false)
  const messageIdsRef = useRef<string[]>([])
  const reconnectTimer = useRef<number | null>(null)
  const reconnectAttempt = useRef(0)
  const syncAliveRef = useRef(false)
  const lastEventAt = useRef(Date.now())

  useEffect(() => {
    messagesRef.current = messages
    messageIdsRef.current = messages.map((m) => m.id).filter((id) => id.length > 20)
  }, [messages])

  useEffect(() => {
    return () => {
      revokeBlobUrlsFromMessages(messagesRef.current)
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
    }
  }, [])

  const waitingForPeer = peerCount < 2
  const isGroup = maxParticipants > 2

  const title = useMemo(() => {
    if (waitingForPeer) return 'Waiting for peers…'
    if (isGroup) {
      if (others.length === 0) return `Room · ${peerCount}/${maxParticipants}`
      const names = others.map((p) => p.display_name).filter(Boolean)
      if (names.length <= 2) return `${names.join(', ')} · ${peerCount}/${maxParticipants}`
      return `${names[0]} +${names.length - 1} · ${peerCount}/${maxParticipants}`
    }
    if (other?.display_name) return other.display_name
    if (roomCode) return `Code ${roomCode}`
    return 'Chat'
  }, [isGroup, maxParticipants, other, others, peerCount, roomCode, waitingForPeer])

  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of others) map.set(p.id, p.display_name)
    if (other) map.set(other.id, other.display_name)
    return map
  }, [other, others])

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
    const [{ data: parts }, { data: conv }] = await Promise.all([
      supabase
        .from('participants')
        .select('user_id, last_read_at, profiles(id, username, display_name, avatar_url, last_seen)')
        .eq('conversation_id', conversationId),
      supabase.from('conversations').select('max_participants').eq('id', conversationId).maybeSingle(),
    ])

    const rows = parts ?? []
    setPeerCount(rows.length)
    if (conv?.max_participants) setMaxParticipants(conv.max_participants)

    const peerRows = rows.filter((p) => p.user_id !== user.id)
    const peerProfiles = peerRows
      .map((p) => p.profiles as unknown as Profile | null)
      .filter((p): p is Profile => Boolean(p))
    setOthers(peerProfiles)
    setOther(peerProfiles[0] ?? null)

    // Receipts: require every peer to have a real last_read_at (null = never opened chat)
    const peerRowsAll = peerRows
    const reads = peerRowsAll.map((p) => p.last_read_at as string | null)
    if (reads.length === 0 || reads.some((r) => !r)) {
      setPeerLastRead(null)
    } else {
      setPeerLastRead([...reads].sort()[0] as string)
    }
  }, [conversationId, user])

  const markSeen = useCallback(async () => {
    if (!user || document.visibilityState !== 'visible') return
    await supabase.rpc('mark_messages_seen', { p_conversation_id: conversationId })
    onActivity()
  }, [conversationId, onActivity, user])

  const upsertMessage = useCallback((incoming: Message) => {
    setMessages((prev) => {
      const withoutDup = prev.filter((m) => {
        if (m.id === incoming.id) return false
        if (incoming.clientId && (m.clientId === incoming.clientId || m.id === incoming.clientId)) return false
        if (m.clientId && m.clientId === incoming.id) return false
        return true
      })
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

      try {
        await ensureFreshSession()
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : 'Session expired — reopen the app')
      }

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

      let inserted: Message | null = null
      const { data: created, error: insertErr } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: body || (file ? file.name : null),
          reply_to_id: replyToId,
          client_id: clientId,
        })
        .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id, client_id')
        .single()

      if (insertErr || !created) {
        // Idempotent retry after partial success / multi-tab race
        const { data: existing } = await supabase
          .from('messages')
          .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id, client_id')
          .eq('conversation_id', conversationId)
          .eq('client_id', clientId)
          .maybeSingle()
        if (!existing) throw new Error(insertErr?.message ?? 'Failed to send')
        inserted = existing as Message
      } else {
        inserted = created as Message
      }

      if (file) {
        setMessages((prev) =>
          prev.map((m) => (m.clientId === clientId ? { ...m, localProgress: 55, localStatus: 'uploading' } : m)),
        )
        const safeName = file.name.replace(/[^\w.\-]+/g, '_')
        const path = `${conversationId}/${inserted.id}/${safeName}`
        const { data: existingAtt } = await supabase
          .from('attachments')
          .select('id')
          .eq('message_id', inserted.id)
          .maybeSingle()
        if (!existingAtt) {
          const { error: upErr } = await supabase.storage.from('chat-files').upload(path, file, {
            contentType: file.type || 'application/octet-stream',
            upsert: true,
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
      }

      const [enriched] = await enrichMessages([inserted])
      removeOutbox(clientId)
      setMessages((prev) => {
        const old = prev.find((m) => m.clientId === clientId)
        if (old) revokeBlobUrlsFromMessages([old])
        const withoutLocal = prev.filter((m) => m.clientId !== clientId && m.id !== enriched.id)
        const next: Message = { ...enriched, clientId, localStatus: 'sent', localProgress: 100 }
        return [...withoutLocal, next].sort((a, b) => a.created_at.localeCompare(b.created_at))
      })
      stickToBottomRef.current = true
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
      stickToBottomRef.current = true

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

  const reloadFromServer = useCallback(async () => {
    if (!user) return false
    try {
      await ensureFreshSession()
      const { data: member } = await supabase
        .from('participants')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (!member) {
        setError('You were removed from this room (connection timed out). Leave and rejoin with the code.')
        return false
      }

      const { data: rows, error: err } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id, client_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(300)
      if (err) {
        setError(err.message)
        return false
      }
      const enriched = await enrichMessages((rows as Message[]) ?? [])
      setMessages((prev) => {
        const locals = prev.filter(
          (m) => m.localStatus === 'pending' || m.localStatus === 'failed' || m.localStatus === 'uploading',
        )
        return mergeServerWithLocals(enriched, locals)
      })
      await refreshParticipants()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
      return false
    }
  }, [conversationId, enrichMessages, refreshParticipants, user])

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function bootstrap() {
      setLoading(true)
      setError(null)
      try {
        await ensureFreshSession()
      } catch {
        /* continue */
      }
      await refreshParticipants()

      const { data: rows, error: err } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id, client_id')
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
        await markSeen()
        void flushOutbox()
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [conversationId, enrichMessages, flushOutbox, markSeen, refreshParticipants, user])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, peerTyping, waitingForPeer])

  function onScrollerScroll() {
    const el = scrollerRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }

  useEffect(() => {
    if (!user) return

    const recover = async (forceReconnect: boolean) => {
      setOnline(navigator.onLine)
      if (!navigator.onLine) return
      try {
        await ensureFreshSession()
      } catch {
        /* ignore */
      }
      const ok = await reloadFromServer()
      if (ok) {
        setError(null)
        void markSeen()
        void flushOutbox()
      }
      if (forceReconnect || !syncAliveRef.current) {
        setSyncState('reconnecting')
        setRtEpoch((n) => n + 1)
      }
    }

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        setHiddenUnread(0)
        document.title = baseTitle.current
        void recover(true)
      }
    }
    const onOnline = () => {
      void recover(true)
    }
    const onOffline = () => {
      setOnline(false)
      setSyncState('polling')
      syncAliveRef.current = false
    }

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    let tick = 0
    const pollId = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      tick += 1
      const stale = Date.now() - lastEventAt.current > 25_000
      if (!syncAliveRef.current || stale) {
        setSyncState((s) => (s === 'live' ? 'polling' : s))
        void reloadFromServer().then((ok) => {
          if (ok) {
            void flushOutbox()
            if (!syncAliveRef.current) setRtEpoch((n) => n + 1)
          }
        })
      } else if (tick % 3 === 0) {
        // Gentle catch-up while realtime looks healthy (~15s)
        void reloadFromServer()
      }
    }, 5000)

    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.clearInterval(pollId)
    }
  }, [flushOutbox, markSeen, reloadFromServer, user])

  useEffect(() => {
    if (hiddenUnread > 0 && document.visibilityState === 'hidden') {
      document.title = `(${hiddenUnread}) Pulse`
    } else {
      document.title = baseTitle.current
    }
  }, [hiddenUnread])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    const topic = `room:${conversationId}:${rtEpoch}`

    setSyncState('reconnecting')
    syncAliveRef.current = false

    const channel = supabase.channel(topic, {
      config: { presence: { key: user.id } },
    })

    const noteEvent = () => {
      lastEventAt.current = Date.now()
    }

    channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          noteEvent()
          const msg = payload.new as Message & { client_id?: string | null }
          void (async () => {
            await new Promise((r) => window.setTimeout(r, 200))
            if (msg.sender_id === user.id && msg.client_id) {
              setMessages((prev) => {
                const hasLocal = prev.some((m) => m.clientId === msg.client_id || m.id === msg.id)
                if (hasLocal) {
                  return prev.map((m) =>
                    m.clientId === msg.client_id || m.id === msg.id
                      ? {
                          ...m,
                          id: msg.id,
                          clientId: msg.client_id ?? m.clientId,
                          localStatus: m.localStatus === 'sent' ? 'sent' : m.localStatus,
                        }
                      : m,
                  )
                }
                return prev
              })
            }
            const [enriched] = await enrichMessages([msg])
            upsertMessage({ ...enriched, clientId: msg.client_id ?? undefined })
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
          noteEvent()
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
          noteEvent()
          void refreshParticipants()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions' },
        () => {
          noteEvent()
          void (async () => {
            const ids = messageIdsRef.current
            if (!ids.length) return
            const { data, error } = await supabase
              .from('reactions')
              .select('message_id, user_id, emoji')
              .in('message_id', ids)
            if (error || !data) return
            const byMsg = new Map<string, Reaction[]>()
            for (const r of data) {
              const list = byMsg.get(r.message_id) ?? []
              list.push(r)
              byMsg.set(r.message_id, list)
            }
            setMessages((prev) => prev.map((m) => ({ ...m, reactions: byMsg.get(m.id) ?? [] })))
          })()
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        () => {
          noteEvent()
          void (async () => {
            const { data: rows } = await supabase
              .from('messages')
              .select('id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id, client_id')
              .eq('conversation_id', conversationId)
              .order('created_at', { ascending: true })
            const enriched = await enrichMessages((rows as Message[]) ?? [])
            setMessages((prev) => {
              const hadServer = prev.some((m) => !m.localStatus || m.localStatus === 'sent')
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
        noteEvent()
        const state = channel.presenceState<{ typing?: boolean }>()
        const othersPresent = Object.entries(state).filter(([key]) => key !== user.id)
        setPeerOnline(othersPresent.length > 0)
        setPeerTyping(othersPresent.some(([, metas]) => metas.some((m) => m.typing)))
      })
      .subscribe(async (status) => {
        if (cancelled) return
        if (status === 'SUBSCRIBED') {
          reconnectAttempt.current = 0
          syncAliveRef.current = true
          lastEventAt.current = Date.now()
          setSyncState('live')
          try {
            await channel.track({ typing: false, online_at: new Date().toISOString() })
          } catch {
            /* ignore */
          }
          void reloadFromServer().then((ok) => {
            if (ok) {
              void markSeen()
              void flushOutbox()
            }
          })
          return
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          syncAliveRef.current = false
          setSyncState('reconnecting')
          if (cancelled) return
          if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
          const attempt = reconnectAttempt.current
          reconnectAttempt.current = attempt + 1
          const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4))
          reconnectTimer.current = window.setTimeout(() => {
            if (!cancelled) setRtEpoch((n) => n + 1)
          }, delay)
        }
      })

    channelRef.current = channel
    return () => {
      cancelled = true
      syncAliveRef.current = false
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
      void supabase.removeChannel(channel)
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [
    conversationId,
    enrichMessages,
    flushOutbox,
    markSeen,
    onActivity,
    refreshParticipants,
    reloadFromServer,
    rtEpoch,
    upsertMessage,
    user,
  ])

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
    setMessages((prev) => {
      revokeBlobUrlsFromMessages(prev)
      return []
    })
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
    // Prefer peer last_read (accurate for groups); seen_at is only set when all peers have read
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
            {!online
              ? 'Offline · queued sends'
              : syncState === 'reconnecting'
                ? 'Reconnecting…'
                : syncState === 'polling'
                  ? 'Syncing…'
                  : waitingForPeer
                    ? `Only you · ${peerCount}/${maxParticipants}`
                    : peerTyping
                      ? 'typing…'
                      : peerOnline
                        ? isGroup
                          ? `online · ${peerCount}/${maxParticipants}`
                          : 'online'
                        : other
                          ? 'last seen recently'
                          : isGroup
                            ? `${peerCount}/${maxParticipants}`
                            : ' '}
          </p>
        </div>
        <div className="header-actions">
          {roomCode && (
            <button type="button" className="btn ghost icon-btn header-primary-action" onClick={() => void shareCode()}>
              Share
            </button>
          )}
          <div className="header-menu-wrap">
            <button
              type="button"
              className="btn ghost icon-btn"
              aria-expanded={headerMenuOpen}
              aria-haspopup="menu"
              onClick={() => setHeaderMenuOpen((o) => !o)}
              title="More"
            >
              More
            </button>
            {headerMenuOpen && (
              <>
                <button type="button" className="header-menu-backdrop" aria-label="Close menu" onClick={() => setHeaderMenuOpen(false)} />
                <div className="header-menu" role="menu">
                  {roomCode && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setHeaderMenuOpen(false)
                        void copyCode()
                      }}
                    >
                      {copied ? 'Copied' : 'Copy code'}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      void clearChat()
                    }}
                  >
                    Clear chat
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      void regenerateCode()
                    }}
                  >
                    New code
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="message-scroller" ref={scrollerRef} onScroll={onScrollerScroll}>
        {loading && <p className="muted pad">Loading messages…</p>}
        {error && <p className="error pad">{error}</p>}

        {!loading && waitingForPeer && (
          <div className="waiting-card">
            <p className="brand-sm">Pulse</p>
            <h2>{maxParticipants > 2 ? 'Waiting for others' : 'Waiting for the other person'}</h2>
            <p className="muted">
              Share this code so they can join from any device.
              {maxParticipants > 2 ? ` Room holds up to ${maxParticipants} people.` : ''}
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
              m.body && !(audio && (m.body === 'Voice note' || m.body === audio.file_name))
            const grouped = new Map<string, number>()
            for (const r of m.reactions ?? []) grouped.set(r.emoji, (grouped.get(r.emoji) ?? 0) + 1)
            const canAct =
              m.localStatus !== 'pending' &&
              m.localStatus !== 'uploading' &&
              m.localStatus !== 'failed' &&
              !(m.clientId && m.id === m.clientId)
            const status = receiptLabel(m)

            return (
              <div key={m.clientId ?? m.id} className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
                <div className={`bubble ${mine ? 'mine' : 'theirs'} ${m.localStatus === 'failed' ? 'failed' : ''}`}>
                  {!mine && isGroup && (
                    <p className="sender-name">{nameById.get(m.sender_id) ?? 'Member'}</p>
                  )}
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
