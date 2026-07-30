import { useEffect } from 'react'

type Props = {
  src: string
  alt?: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className="lightbox-backdrop" onClick={onClose} role="presentation">
      <div className="lightbox" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="lightbox-header">
          <strong>{alt || 'Photo'}</strong>
          <div className="waiting-actions">
            <a className="btn ghost" href={src} download={alt || 'photo'} target="_blank" rel="noreferrer">
              Download
            </a>
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        <img src={src} alt={alt || 'Photo'} />
      </div>
    </div>
  )
}
