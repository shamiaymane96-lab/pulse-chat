import type { Message } from '../lib/types'

type Props = {
  message: Message
  mine: boolean
  isPinned: boolean
  onClose: () => void
  onReply: () => void
  onReact: (emoji: string) => void
  onCopy: () => void
  onEdit?: () => void
  onDelete?: () => void
  onPin: () => void
  onUnpin: () => void
}

const REACTIONS = ['👍', '❤️', '😂', '🔥', '😮']

export function MessageActionSheet({
  message,
  mine,
  isPinned,
  onClose,
  onReply,
  onReact,
  onCopy,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
}: Props) {
  const deleted = Boolean(message.deleted_at)
  const canCopy = Boolean(message.body) && !deleted
  const canEdit = mine && !deleted && Boolean(message.body) && !(message.attachments && message.attachments.length)

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="action-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className="sheet-title">Message</p>
        {!deleted && (
          <div className="sheet-reactions">
            {REACTIONS.map((emoji) => (
              <button key={emoji} type="button" onClick={() => onReact(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}
        <div className="sheet-actions">
          {!deleted && (
            <button type="button" onClick={onReply}>
              Reply
            </button>
          )}
          {canCopy && (
            <button type="button" onClick={onCopy}>
              Copy
            </button>
          )}
          {canEdit && onEdit && (
            <button type="button" onClick={onEdit}>
              Edit
            </button>
          )}
          {!deleted && (
            <button type="button" onClick={isPinned ? onUnpin : onPin}>
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {mine && !deleted && onDelete && (
            <button type="button" className="danger" onClick={onDelete}>
              Delete for everyone
            </button>
          )}
          <button type="button" className="muted-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
