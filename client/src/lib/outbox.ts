import type { OutboxItem } from './types'

const KEY = 'pulse_outbox_v1'

function read(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    return JSON.parse(raw) as OutboxItem[]
  } catch {
    return []
  }
}

function write(items: OutboxItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export function listOutbox(conversationId?: string) {
  const all = read()
  return conversationId ? all.filter((i) => i.conversationId === conversationId) : all
}

export function enqueueOutbox(item: OutboxItem) {
  const next = [...read().filter((i) => i.clientId !== item.clientId), item]
  write(next)
}

export function removeOutbox(clientId: string) {
  write(read().filter((i) => i.clientId !== clientId))
}

export function clearOutboxForConversation(conversationId: string) {
  write(read().filter((i) => i.conversationId !== conversationId))
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const base64 = result.includes(',') ? result.split(',')[1] : result
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function base64ToFile(base64: string, fileName: string, fileType: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], fileName, { type: fileType || 'application/octet-stream' })
}
