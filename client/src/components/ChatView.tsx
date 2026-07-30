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
import { MessageActionSheet } from './MessageActionSheet'
import { hardRefreshApp } from '../lib/hardRefresh'
import { roomLink, syncCodeInUrl } from '../lib/roomLink'
import { isAllowedChatFile, isSafeImageMime } from '../lib/fileAllowlist'
import { signedUrlsFor } from '../lib/signedUrls'

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
  return isSafeImageMime(mime)
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
  const serverClientIds = new Set(server.map((m) => m.clientId).filter(Boolean) as string[])
  const kept = locals.filter((m) => {
    const id = m.clientId ?? m.id
    if (!m.localStatus || m.localStatus === 'sent') return false
    if (serverIds.has(m.id) || serverIds.has(id)) return false
    if (m.clientId && serverClientIds.has(m.clientId)) return false
    return true
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

const MESSAGE_SELECT =
  'id, conversation_id, sender_id, body, created_at, delivered_at, seen_at, reply_to_id, client_id, edited_at, deleted_at'

type PresencePayload = { typing?: boolean; recording?: boolean; online_at?: string }

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightText(text: string, query: string) {
  if (!query.trim()) return text
  const parts = text.split(new RegExp(`(${escapeRegex(query)})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : part,
  )
}

export function ChatView({ conversationId, roomCode, onBack, onActivity }: Props) {
  const { user, setRoomCode } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [other, setOther] = useState<Profile | null>(null)
  const [others, setOthers] = useState<Profile[]>([])
  const [peerCount, setPeerCount] = useState(1)
  const [maxParticipants, setMaxParticipants] = useState(2)
  const [peerTyping, setPeerTyping] = useState(false)
  const [peerRecording, setPeerRecording] = useState(false)
  const [peerOnline, setPeerOnline] = useState(false)
  const [presenceByUser, setPresenceByUser] = useState<Map<string, PresencePayload>>(new Map())
  const [peerLastRead, setPeerLastRead] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editing, setEditing] = useState<Message | null>(null)
  const [actionSheetMessage, setActionSheetMessage] = useState<Message | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [peersPanelOpen, setPeersPanelOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [stuckToBottom, setStuckToBottom] = useState(true)
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(null)
  const [unreadDividerId, setUnreadDividerId] = useState<string | null>(null)
  const [hiddenUnread, setHiddenUnread] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const [rtEpoch, setRtEpoch] = useState(0)
  // Value is unread since the header sync indicator was removed; the setter is
  // still driven by the channel lifecycle below. Restore the binding if the
  // indicator comes back.
  const [, setSyncState] = useState<'live' | 'reconnecting' | 'polling'>('reconnecting')
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
  const lastReconnectAt = useRef(0)
  const presenceRef = useRef<PresencePayload>({ typing: false, recording: false })
  const lastHiddenAt = useRef<string | null>(null)
  const lastSeenMessageId = useRef<string | null>(null)
  const longPressTimer = useRef<number | null>(null)
  const longPressMessageId = useRef<string | null>(null)
  const unreadDividerTimer = useRef<number | null>(null)
  // messages no longer emits usable DELETE events (see migration 010) — the room
  // signals a wipe by bumping conversations.messages_cleared_at instead.
  const clearedAtRef = useRef<string | null>(null)

  useEffect(() => {
    messagesRef.current = messages
    messageIdsRef.current = messages.map((m) => m.id).filter((id) => id.length > 20)
  }, [messages])

  useEffect(() => {
    return () => {
      revokeBlobUrlsFromMessages(messagesRef.current)
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
      if (unreadDividerTimer.current) window.clearTimeout(unreadDividerTimer.current)
      clearLongPress()
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
    const link = roomLink(code)
    return `Join my Pulse chat with code ${code}\n${link}`
  }, [roomCode])

  const pinnedMessage = useMemo(
    () => (pinnedMessageId ? messages.find((m) => m.id === pinnedMessageId) ?? null : null),
    [messages, pinnedMessageId],
  )

  const normalizedSearch = searchQuery.trim().toLowerCase()

  useEffect(() => {
    if (roomCode) syncCodeInUrl(roomCode)
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
    const signedByPath = await signedUrlsFor((files ?? []).map((f) => f.storage_path))
    for (const f of files ?? []) {
      const list = filesByMsg.get(f.message_id) ?? []
      list.push({ ...f, signed_url: signedByPath.get(f.storage_path) })
      filesByMsg.set(f.message_id, list)
    }

    const reactionsByMsg = new Map<string, Reaction[]>()
    for (const r of reactions ?? []) {
      const list = reactionsByMsg.get(r.message_id) ?? []
      list.push(r)
      reactionsByMsg.set(r.message_id, list)
    }

    const replyMap = new Map((replies ?? []).map((r) => [r.id, r]))

    return rows.map((msg) => {
      const raw = msg as Message & { client_id?: string | null }
      const clientId = raw.clientId ?? raw.client_id ?? undefined
      return {
        ...msg,
        clientId,
        attachments: filesByMsg.get(msg.id) ?? [],
        reactions: reactionsByMsg.get(msg.id) ?? [],
        reply_preview: msg.reply_to_id ? replyMap.get(msg.reply_to_id) ?? null : null,
        localStatus: 'sent' as const,
      } satisfies Message
    })
  }, [])

  const refreshParticipants = useCallback(async () => {
    if (!user) return
    const [{ data: parts }, { data: conv }] = await Promise.all([
      supabase
        .from('participants')
        .select('user_id, last_read_at, profiles(id, username, display_name, avatar_url, last_seen)')
        .eq('conversation_id', conversationId),
      supabase
        .from('conversations')
        .select('max_participants, pinned_message_id, messages_cleared_at')
        .eq('id', conversationId)
        .maybeSingle(),
    ])

    const rows = parts ?? []
    setPeerCount(rows.length)
    if (conv?.max_participants) setMaxParticipants(conv.max_participants)
    setPinnedMessageId(conv?.pinned_message_id ?? null)
    clearedAtRef.current = conv?.messages_cleared_at ?? null

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
    const msgs = messagesRef.current
    const last = msgs[msgs.length - 1]
    if (last?.id && last.id.length > 20) lastSeenMessageId.current = last.id
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

      let uploadMime: string | null = null
      if (file) {
        const check = isAllowedChatFile(file)
        if (!check.ok) throw new Error(check.reason)
        uploadMime = check.mime
      }

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
        .select(MESSAGE_SELECT)
        .single()

      if (insertErr || !created) {
        // Idempotent retry after partial success / multi-tab race
        const { data: existing } = await supabase
          .from('messages')
          .select(MESSAGE_SELECT)
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
            contentType: uploadMime || file.type || 'application/octet-stream',
            upsert: true,
          })
          if (upErr) {
            await supabase.from('messages').delete().eq('id', inserted.id)
            throw new Error(upErr.message)
          }
          const { error: attErr } = await supabase.from('attachments').insert({
            message_id: inserted.id,
            storage_path: path,
            mime_type: uploadMime || file.type || 'application/octet-stream',
            size_bytes: file.size,
            file_name: file.name,
          })
        if (attErr) {
          await supabase.from('messages').delete().eq('id', inserted.id)
          await supabase.storage.from('chat-files').remove([path])
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
        try {
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
        } catch (queueErr) {
          setMessages((prev) =>
            prev.map((m) => (m.clientId === clientId ? { ...m, localStatus: 'failed', localProgress: 0 } : m)),
          )
          setError(queueErr instanceof Error ? queueErr.message : 'Could not queue message')
          return
        }
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
        .select(MESSAGE_SELECT)
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
        .select(MESSAGE_SELECT)
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

      const { data: conv } = await supabase
        .from('conversations')
        .select('pinned_message_id')
        .eq('id', conversationId)
        .maybeSingle()
      if (!cancelled) setPinnedMessageId(conv?.pinned_message_id ?? null)

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
  }, [messages.length, peerTyping, peerRecording, waitingForPeer])

  useEffect(() => {
    if (!normalizedSearch) return
    const match = messagesRef.current.find(
      (m) => m.body && m.body.toLowerCase().includes(normalizedSearch) && !m.deleted_at,
    )
    if (match) scrollToMessage(match.id)
  }, [normalizedSearch])

  function onScrollerScroll() {
    const el = scrollerRef.current
    if (!el) return
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    stickToBottomRef.current = stuck
    setStuckToBottom(stuck)
    if (stuck) setUnreadDividerId(null)
  }

  function scrollToBottom() {
    stickToBottomRef.current = true
    setStuckToBottom(true)
    setUnreadDividerId(null)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function scrollToMessage(id: string) {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function clearLongPress() {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    longPressMessageId.current = null
  }

  function startLongPress(message: Message) {
    if (!message.id || message.id.length < 20) return
    clearLongPress()
    longPressMessageId.current = message.id
    longPressTimer.current = window.setTimeout(() => {
      setMenuFor(null)
      setActionSheetMessage(message)
      clearLongPress()
    }, 400)
  }

  async function copyMessageBody(body: string | null) {
    if (!body) return
    try {
      await navigator.clipboard.writeText(body)
    } catch {
      window.prompt('Copy message', body)
    }
    setActionSheetMessage(null)
  }

  async function deleteMessageForEveryone(messageId: string) {
    const { error: err } = await supabase.rpc('delete_message', { p_message_id: messageId })
    if (err) setError(err.message)
    setActionSheetMessage(null)
  }

  async function editMessage(body: string) {
    if (!editing) return
    const { error: err } = await supabase.rpc('edit_message', {
      p_message_id: editing.id,
      p_body: body,
    })
    if (err) {
      setError(err.message)
      return
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === editing.id ? { ...m, body, edited_at: new Date().toISOString() } : m,
      ),
    )
    setEditing(null)
  }

  async function pinMessage(messageId: string) {
    const { error: err } = await supabase.rpc('pin_message', {
      p_conversation_id: conversationId,
      p_message_id: messageId,
    })
    if (err) setError(err.message)
    else setPinnedMessageId(messageId)
    setActionSheetMessage(null)
  }

  async function unpinMessage() {
    const { error: err } = await supabase.rpc('pin_message', {
      p_conversation_id: conversationId,
      p_message_id: null,
    })
    if (err) setError(err.message)
    else setPinnedMessageId(null)
    setActionSheetMessage(null)
  }

  const handleComposerSend = useCallback(
    async (body: string, file: File | null, replyToId: string | null) => {
      if (editing) {
        if (!file) await editMessage(body)
        return
      }
      await queueOrSend(body, file, replyToId)
    },
    [editing, queueOrSend],
  )

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
      if (document.visibilityState === 'hidden') {
        lastHiddenAt.current = new Date().toISOString()
        return
      }
      if (document.visibilityState === 'visible') {
        const msgs = messagesRef.current
        const afterId = lastSeenMessageId.current
        let dividerId: string | null = null
        if (afterId) {
          const afterIdx = msgs.findIndex((m) => m.id === afterId)
          for (let i = afterIdx + 1; i < msgs.length; i++) {
            const m = msgs[i]
            if (m.sender_id !== user!.id && !m.deleted_at) {
              dividerId = m.id
              break
            }
          }
        } else if (lastHiddenAt.current) {
          for (const m of msgs) {
            if (
              m.sender_id !== user!.id &&
              !m.deleted_at &&
              m.created_at > lastHiddenAt.current
            ) {
              dividerId = m.id
              break
            }
          }
        }
        if (dividerId) {
          setUnreadDividerId(dividerId)
          if (unreadDividerTimer.current) window.clearTimeout(unreadDividerTimer.current)
          unreadDividerTimer.current = window.setTimeout(() => setUnreadDividerId(null), 30_000)
        }
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
      if (!syncAliveRef.current) {
        setSyncState((s) => (s === 'live' ? 'polling' : s))
        void reloadFromServer().then((ok) => {
          if (ok) {
            void flushOutbox()
            if (Date.now() - lastReconnectAt.current > 8_000) {
              lastReconnectAt.current = Date.now()
              setRtEpoch((n) => n + 1)
            }
          }
        })
      } else if (stale || tick % 3 === 0) {
        // Catch-up without flipping UI to "Syncing…" while the socket is healthy
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

  // Keep volatile callbacks out of the channel effect deps — recreating the
  // channel on every callback identity change causes Reconnecting flicker.
  const enrichMessagesRef = useRef(enrichMessages)
  const flushOutboxRef = useRef(flushOutbox)
  const markSeenRef = useRef(markSeen)
  const onActivityRef = useRef(onActivity)
  const refreshParticipantsRef = useRef(refreshParticipants)
  const reloadFromServerRef = useRef(reloadFromServer)
  const upsertMessageRef = useRef(upsertMessage)
  enrichMessagesRef.current = enrichMessages
  flushOutboxRef.current = flushOutbox
  markSeenRef.current = markSeen
  onActivityRef.current = onActivity
  refreshParticipantsRef.current = refreshParticipants
  reloadFromServerRef.current = reloadFromServer
  upsertMessageRef.current = upsertMessage

  useEffect(() => {
    if (!user) return
    let cancelled = false
    const topic = `room:${conversationId}:${rtEpoch}`
    const userId = user.id

    setSyncState('reconnecting')
    syncAliveRef.current = false
    lastReconnectAt.current = Date.now()

    const channel = supabase.channel(topic, {
      config: { presence: { key: userId } },
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
            const clientId = msg.client_id ?? undefined
            // Don't clobber an in-flight local upload with a bare server row
            const local = messagesRef.current.find(
              (m) => (clientId && m.clientId === clientId) || m.id === msg.id || m.id === clientId,
            )
            if (
              msg.sender_id === userId &&
              local &&
              (local.localStatus === 'uploading' || local.localStatus === 'pending')
            ) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.clientId === clientId || m.id === msg.id || m.id === clientId
                    ? { ...m, id: msg.id, clientId: clientId ?? m.clientId }
                    : m,
                ),
              )
              return
            }
            if (msg.sender_id === userId && clientId) {
              setMessages((prev) => {
                const hasLocal = prev.some((m) => m.clientId === clientId || m.id === msg.id)
                if (hasLocal) {
                  return prev.map((m) =>
                    m.clientId === clientId || m.id === msg.id
                      ? {
                          ...m,
                          id: msg.id,
                          clientId: clientId ?? m.clientId,
                          localStatus: m.localStatus === 'sent' ? 'sent' : m.localStatus,
                        }
                      : m,
                  )
                }
                return prev
              })
            }
            const [enriched] = await enrichMessagesRef.current([msg])
            upsertMessageRef.current({ ...enriched, clientId })
            if (msg.sender_id === userId) return
            await supabase.rpc('mark_message_delivered', { p_message_id: msg.id })
            if (document.visibilityState === 'hidden') setHiddenUnread((n) => n + 1)
            else void markSeenRef.current()
            onActivityRef.current()
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
            prev.map((m) => {
              if (m.id !== msg.id) return m
              const deleted = Boolean(msg.deleted_at)
              return {
                ...m,
                delivered_at: msg.delivered_at,
                seen_at: msg.seen_at,
                body: msg.body,
                edited_at: msg.edited_at,
                deleted_at: msg.deleted_at,
                ...(deleted ? { attachments: [], reactions: [] } : {}),
              }
            }),
          )
          if (msg.deleted_at) {
            setPinnedMessageId((prev) => (prev === msg.id ? null : prev))
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `id=eq.${conversationId}` },
        (payload) => {
          noteEvent()
          const row = payload.new as {
            pinned_message_id?: string | null
            messages_cleared_at?: string | null
          }
          setPinnedMessageId(row.pinned_message_id ?? null)

          const cleared = row.messages_cleared_at ?? null
          if (cleared && cleared !== clearedAtRef.current) {
            clearedAtRef.current = cleared
            clearOutboxForConversation(conversationId)
            setMessages((prev) => {
              revokeBlobUrlsFromMessages(prev)
              return []
            })
            void reloadFromServerRef.current()
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'participants', filter: `conversation_id=eq.${conversationId}` },
        () => {
          noteEvent()
          void refreshParticipantsRef.current()
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
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
      // No DELETE subscription: migration 010 reverted messages to REPLICA
      // IDENTITY DEFAULT so deleted bodies stop being broadcast to every
      // authenticated client. Wipes arrive via conversations.messages_cleared_at
      // above; one-off deletes are soft (an UPDATE) and land in that handler.
      .on('presence', { event: 'sync' }, () => {
        noteEvent()
        const state = channel.presenceState<PresencePayload>()
        const byUser = new Map<string, PresencePayload>()
        for (const [key, metas] of Object.entries(state)) {
          if (key === userId) continue
          const merged: PresencePayload = {}
          for (const m of metas) {
            if (m.typing) merged.typing = true
            if (m.recording) merged.recording = true
            if (m.online_at) merged.online_at = m.online_at
          }
          byUser.set(key, merged)
        }
        setPresenceByUser(byUser)
        const othersPresent = [...byUser.keys()]
        setPeerOnline(othersPresent.length > 0)
        setPeerTyping([...byUser.values()].some((m) => m.typing))
        setPeerRecording([...byUser.values()].some((m) => m.recording))
      })
      .subscribe(async (status) => {
        if (cancelled) return
        if (status === 'SUBSCRIBED') {
          reconnectAttempt.current = 0
          syncAliveRef.current = true
          lastEventAt.current = Date.now()
          setSyncState('live')
          try {
            await channel.track({
              typing: presenceRef.current.typing ?? false,
              recording: presenceRef.current.recording ?? false,
              online_at: new Date().toISOString(),
            })
          } catch {
            /* ignore */
          }
          void reloadFromServerRef.current().then((ok) => {
            if (ok) {
              void markSeenRef.current()
              void flushOutboxRef.current()
            }
          })
          return
        }
        // CLOSED fires on intentional removeChannel and brief auth rotations —
        // don't tear down / flip UI for that or we flicker Reconnecting every second.
        if (status === 'CLOSED') {
          syncAliveRef.current = false
          return
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          syncAliveRef.current = false
          setSyncState('reconnecting')
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
  }, [conversationId, rtEpoch, user?.id])

  async function trackPresence(partial: Partial<PresencePayload>) {
    const channel = channelRef.current
    if (!channel) return
    presenceRef.current = { ...presenceRef.current, ...partial }
    await channel.track({
      typing: presenceRef.current.typing ?? false,
      recording: presenceRef.current.recording ?? false,
      online_at: new Date().toISOString(),
    })
  }

  async function setTyping(typing: boolean) {
    await trackPresence({ typing })
  }

  async function setRecording(recording: boolean) {
    await trackPresence({ recording })
  }

  async function toggleReaction(messageId: string, emoji: string) {
    await supabase.rpc('toggle_reaction', { p_message_id: messageId, p_emoji: emoji })
    setMenuFor(null)
    setActionSheetMessage(null)
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
        <button
          type="button"
          className="chat-header-main chat-header-tap"
          onClick={() => setPeersPanelOpen((o) => !o)}
          title="Who's online"
        >
          <strong>{title}</strong>
          <p className="muted status-line">
            {waitingForPeer
              ? `Only you · ${peerCount}/${maxParticipants}`
              : peerRecording
                ? 'Recording…'
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
        </button>
        <div className="header-actions">
          <button
            type="button"
            className="btn ghost icon-btn"
            title="Refresh app"
            onClick={() => void hardRefreshApp()}
          >
            Refresh
          </button>
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
                      setSearchOpen((o) => !o)
                      if (searchOpen) setSearchQuery('')
                    }}
                  >
                    {searchOpen ? 'Close search' : 'Search'}
                  </button>
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

      {searchOpen && (
        <div className="chat-search-bar">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages"
            autoFocus
          />
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setSearchOpen(false)
              setSearchQuery('')
            }}
          >
            Close
          </button>
        </div>
      )}

      {peersPanelOpen && (
        <>
          <button
            type="button"
            className="header-menu-backdrop"
            aria-label="Close peers panel"
            onClick={() => setPeersPanelOpen(false)}
          />
          <div className="peers-panel" role="dialog" aria-label="Participants">
            <p className="sheet-title">In this room</p>
            <ul>
              {others.map((p) => (
                <li key={p.id}>
                  <span>{p.display_name}</span>
                  <span className={presenceByUser.has(p.id) ? 'peer-online' : 'peer-offline'}>
                    {presenceByUser.has(p.id) ? 'online' : 'offline'}
                  </span>
                </li>
              ))}
              {others.length === 0 && other && (
                <li>
                  <span>{other.display_name}</span>
                  <span className={presenceByUser.has(other.id) ? 'peer-online' : 'peer-offline'}>
                    {presenceByUser.has(other.id) ? 'online' : 'offline'}
                  </span>
                </li>
              )}
              {others.length === 0 && !other && <li className="muted">No peers yet</li>}
            </ul>
          </div>
        </>
      )}

      <div className="message-scroller" ref={scrollerRef} onScroll={onScrollerScroll}>
        {pinnedMessage && (
          <button
            type="button"
            className="pin-banner"
            onClick={() => scrollToMessage(pinnedMessage.id)}
          >
            <span className="pin-banner-text">
              Pinned ·{' '}
              {pinnedMessage.deleted_at
                ? 'Deleted message'
                : (pinnedMessage.body || 'Attachment').slice(0, 80)}
            </span>
            <span
              className="pin-banner-close"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                void unpinMessage()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  void unpinMessage()
                }
              }}
            >
              ×
            </span>
          </button>
        )}
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
            const deleted = Boolean(m.deleted_at)
            const audio = m.attachments?.find((a) => isAudio(a.mime_type))
            const showBody =
              !deleted &&
              m.body &&
              !(audio && (m.body === 'Voice note' || m.body === audio.file_name))
            const grouped = new Map<string, number>()
            for (const r of m.reactions ?? []) grouped.set(r.emoji, (grouped.get(r.emoji) ?? 0) + 1)
            const canAct =
              !deleted &&
              m.localStatus !== 'pending' &&
              m.localStatus !== 'uploading' &&
              m.localStatus !== 'failed' &&
              !(m.clientId && m.id === m.clientId)
            const status = receiptLabel(m)
            const matchesSearch =
              !normalizedSearch || (m.body?.toLowerCase().includes(normalizedSearch) ?? false)
            const dimmed = Boolean(normalizedSearch) && !matchesSearch

            return (
              <div key={m.clientId ?? m.id}>
                {unreadDividerId === m.id && (
                  <div className="unread-divider">
                    <span>New messages</span>
                  </div>
                )}
                <div
                  id={`msg-${m.id}`}
                  className={`bubble-row ${mine ? 'mine' : 'theirs'}${dimmed ? ' search-dimmed' : ''}`}
                >
                  <div
                    className={`bubble ${mine ? 'mine' : 'theirs'} ${m.localStatus === 'failed' ? 'failed' : ''}`}
                    onPointerDown={() => canAct && startLongPress(m)}
                    onPointerUp={clearLongPress}
                    onPointerCancel={clearLongPress}
                    onPointerLeave={clearLongPress}
                  >
                    {!mine && isGroup && (
                      <p className="sender-name">{nameById.get(m.sender_id) ?? 'Member'}</p>
                    )}
                    {m.reply_preview && !deleted && (
                      <div className="reply-quote">{(m.reply_preview.body || 'Attachment').slice(0, 80)}</div>
                    )}
                    {deleted ? (
                      <p className="deleted-msg">
                        <em>This message was deleted</em>
                      </p>
                    ) : (
                      showBody && (
                        <p>
                          {normalizedSearch && m.body
                            ? highlightText(m.body, searchQuery.trim())
                            : m.body}
                        </p>
                      )
                    )}
                    {!deleted &&
                      m.attachments?.map((a) => (
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
                    {!deleted && grouped.size > 0 && (
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
                      {m.edited_at && !deleted && <span className="edited-label">edited</span>}
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
              </div>
            )
          })}
        <div ref={bottomRef} />
      </div>

      {!stuckToBottom && (
        <button type="button" className="jump-fab" onClick={scrollToBottom} title="Jump to latest">
          ↓
        </button>
      )}

      <Composer
        replyTo={replyTo}
        editing={editing}
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditing(null)}
        onSend={handleComposerSend}
        onTyping={(t) => {
          void setTyping(t)
        }}
        onRecording={(r) => {
          void setRecording(r)
        }}
      />

      {actionSheetMessage && (
        <MessageActionSheet
          message={actionSheetMessage}
          mine={actionSheetMessage.sender_id === user?.id}
          isPinned={pinnedMessageId === actionSheetMessage.id}
          onClose={() => setActionSheetMessage(null)}
          onReply={() => {
            setReplyTo(actionSheetMessage)
            setActionSheetMessage(null)
          }}
          onReact={(emoji) => void toggleReaction(actionSheetMessage.id, emoji)}
          onCopy={() => void copyMessageBody(actionSheetMessage.body)}
          onEdit={() => {
            setEditing(actionSheetMessage)
            setReplyTo(null)
            setActionSheetMessage(null)
          }}
          onDelete={() => void deleteMessageForEveryone(actionSheetMessage.id)}
          onPin={() => void pinMessage(actionSheetMessage.id)}
          onUnpin={() => void unpinMessage()}
        />
      )}

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </section>
  )
}
