const DANGEROUS_MIME =
  /^(text\/html|text\/javascript|application\/javascript|application\/x-javascript|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml|application\/x-msdownload|application\/x-executable|application\/x-sh|application\/x-bat|application\/wasm)(;|$)/i

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/avif',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
])

const BLOCKED_EXT =
  /\.(svg|html?|xhtml|js|mjs|cjs|jsx|ts|tsx|exe|bat|cmd|com|scr|msi|dll|sh|bash|zsh|ps1|vbs|wsf|jar|apk|ipa|wasm)$/i

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
}

export function normalizeMime(mime: string | null | undefined) {
  return (mime ?? '').split(';')[0].trim().toLowerCase()
}

function mimeFromName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_MIME[ext] ?? ''
}

export function isAllowedChatFile(file: File): { ok: true; mime: string } | { ok: false; reason: string } {
  if (file.size > 50 * 1024 * 1024) {
    return { ok: false, reason: 'File must be 50MB or smaller' }
  }
  if (BLOCKED_EXT.test(file.name)) {
    return { ok: false, reason: 'This file type is not allowed' }
  }
  let mime = normalizeMime(file.type)
  if (!mime) mime = mimeFromName(file.name)
  if (!mime) {
    return { ok: false, reason: 'Unknown file type — pick an image, audio, video, PDF, or document' }
  }
  if (DANGEROUS_MIME.test(mime) || !ALLOWED_MIME.has(mime)) {
    return { ok: false, reason: 'This file type is not allowed' }
  }
  return { ok: true, mime }
}

export function isSafeImageMime(mime: string) {
  const m = normalizeMime(mime)
  return m.startsWith('image/') && m !== 'image/svg+xml' && ALLOWED_MIME.has(m)
}
