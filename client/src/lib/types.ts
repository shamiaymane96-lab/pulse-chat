export type Profile = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  last_seen: string | null
}

export type Attachment = {
  id: string
  message_id: string
  storage_path: string
  mime_type: string
  size_bytes: number
  file_name: string
  signed_url?: string
}

export type Reaction = {
  message_id: string
  user_id: string
  emoji: string
}

export type Message = {
  id: string
  conversation_id: string
  sender_id: string
  body: string | null
  created_at: string
  delivered_at: string | null
  seen_at?: string | null
  reply_to_id?: string | null
  attachments?: Attachment[]
  reactions?: Reaction[]
  reply_preview?: { id: string; body: string | null; sender_id: string } | null
  localStatus?: 'pending' | 'uploading' | 'failed' | 'sent'
  localProgress?: number
  clientId?: string
}

export type ConversationPreview = {
  id: string
  is_group: boolean
  title: string | null
  other?: Profile
  last_message?: Message | null
  unread: number
}

export type OutboxItem = {
  clientId: string
  conversationId: string
  body: string
  replyToId: string | null
  fileName?: string
  fileType?: string
  fileBase64?: string
  createdAt: string
}
