/** Hard refresh for installed PWAs (Android has no browser refresh). */
export async function hardRefreshApp() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  } catch {
    /* ignore */
  }

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((reg) => reg.unregister()))
    }
  } catch {
    /* ignore */
  }

  const url = new URL(window.location.href)
  url.searchParams.set('_reload', String(Date.now()))
  window.location.replace(url.toString())
}
