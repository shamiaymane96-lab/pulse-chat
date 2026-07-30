type Props = {
  src: string
  alt?: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, onClose }: Props) {
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
