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

export type Message = {
  id: string
  conversation_id: string
  sender_id: string
  body: string | null
  created_at: string
  delivered_at: string | null
  attachments?: Attachment[]
}

export type ConversationPreview = {
  id: string
  is_group: boolean
  title: string | null
  other?: Profile
  last_message?: Message | null
  unread: number
}
