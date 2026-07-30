export function codeFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return (params.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function roomLink(code: string) {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (normalized) url.searchParams.set('code', normalized)
  return url.toString()
}

/** Keep ?code= in the address bar so the room can be bookmarked. */
export function syncCodeInUrl(code: string | null | undefined) {
  const url = new URL(window.location.href)
  const normalized = (code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const current = (url.searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (normalized) {
    if (current === normalized && !url.searchParams.has('_reload')) return
    url.searchParams.set('code', normalized)
  } else {
    url.searchParams.delete('code')
  }
  url.searchParams.delete('_reload')
  const next = url.pathname + url.search + url.hash
  const now = window.location.pathname + window.location.search + window.location.hash
  if (next !== now) window.history.replaceState({}, '', next)
}
