import { useEffect, useRef, useState, type FormEvent, type ChangeEvent, type PointerEvent } from 'react'
import type { Message } from '../lib/types'
import { isAllowedChatFile } from '../lib/fileAllowlist'

type Props = {
  disabled?: boolean
  replyTo?: Message | null
  editing?: Message | null
  onCancelReply?: () => void
  onCancelEdit?: () => void
  onSend: (body: string, file: File | null, replyToId: string | null) => Promise<void>
  onTyping: (typing: boolean) => void
  onRecording?: (recording: boolean) => void
}

function pickRecorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

export function Composer({
  disabled,
  replyTo,
  editing,
  onCancelReply,
  onCancelEdit,
  onSend,
  onTyping,
  onRecording,
}: Props) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)

  const typingTimer = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const recordTimerRef = useRef<number | null>(null)
  const recordStartedAt = useRef(0)
  const cancelRecordRef = useRef(false)
  const holdActiveRef = useRef(false)
  const replyToIdRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    replyToIdRef.current = replyTo?.id ?? null
  }, [replyTo])

  useEffect(() => {
    if (editing) {
      setText(editing.body ?? '')
      setFile(null)
      onCancelReply?.()
      window.setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [editing, onCancelReply])

  useEffect(() => {
    return () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current)
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      onRecording?.(false)
    }
  }, [onRecording])

  function handleChange(value: string) {
    setText(value)
    if (!editing) {
      onTyping(true)
      if (typingTimer.current) window.clearTimeout(typingTimer.current)
      typingTimer.current = window.setTimeout(() => onTyping(false), 1200)
    }
  }

  function takeFile(next: File | null, input?: HTMLInputElement | null) {
    if (editing) return
    if (next) {
      const check = isAllowedChatFile(next)
      if (!check.ok) {
        alert(check.reason)
        if (input) input.value = ''
        return
      }
    }
    setFile(next)
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    takeFile(e.target.files?.[0] ?? null, e.target)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body && !file) return
    if (editing && !body) return
    setBusy(true)
    try {
      await onSend(body, editing ? null : file, editing ? null : replyTo?.id ?? null)
      setText('')
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      if (galleryRef.current) galleryRef.current.value = ''
      if (cameraRef.current) cameraRef.current.value = ''
      onTyping(false)
      onCancelReply?.()
      onCancelEdit?.()
    } finally {
      setBusy(false)
    }
  }

  async function startRecording(e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault()
    if (disabled || busy || recording || editing) return
    setMicError(null)
    cancelRecordRef.current = false
    holdActiveRef.current = true

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!holdActiveRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      streamRef.current = stream
      const mimeType = pickRecorderMime()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current)
          recordTimerRef.current = null
        }
        setRecording(false)
        onRecording?.(false)

        if (cancelRecordRef.current) {
          chunksRef.current = []
          return
        }

        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type })
        chunksRef.current = []
        if (blob.size < 800) return

        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
        const voice = new File([blob], `voice-${Date.now()}.${ext}`, { type })
        const replyId = replyToIdRef.current
        void (async () => {
          setBusy(true)
          try {
            await onSend('Voice note', voice, replyId)
            onTyping(false)
            onCancelReply?.()
          } finally {
            setBusy(false)
          }
        })()
      }

      recorder.start(200)
      recordStartedAt.current = Date.now()
      setRecordSecs(0)
      setRecording(true)
      onRecording?.(true)
      recordTimerRef.current = window.setInterval(() => {
        setRecordSecs(Math.floor((Date.now() - recordStartedAt.current) / 1000))
      }, 250)
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    } catch {
      holdActiveRef.current = false
      setMicError('Microphone permission is required for voice notes')
    }
  }

  function stopRecording(e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault()
    holdActiveRef.current = false
    if (!recorderRef.current) return
    const elapsed = Date.now() - recordStartedAt.current
    if (elapsed < 350) cancelRecordRef.current = true
    recorderRef.current.stop()
    recorderRef.current = null
  }

  function cancelRecording() {
    cancelRecordRef.current = true
    holdActiveRef.current = false
    recorderRef.current?.stop()
    recorderRef.current = null
    onRecording?.(false)
  }

  const toolsDisabled = disabled || busy || recording || Boolean(editing)

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <input ref={fileRef} type="file" className="file-input" onChange={onFile} disabled={toolsDisabled} />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*,video/*"
        className="file-input"
        onChange={onFile}
        disabled={toolsDisabled}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="file-input"
        onChange={onFile}
        disabled={toolsDisabled}
      />

      <div className="composer-tools">
        <button type="button" className="btn ghost icon-btn" disabled={toolsDisabled} onClick={() => cameraRef.current?.click()}>
          Cam
        </button>
        <button type="button" className="btn ghost icon-btn" disabled={toolsDisabled} onClick={() => galleryRef.current?.click()}>
          Pic
        </button>
        <button type="button" className="btn ghost icon-btn" disabled={toolsDisabled} onClick={() => fileRef.current?.click()}>
          File
        </button>
      </div>

      <div className="composer-main">
        {editing && (
          <div className="reply-chip edit-chip">
            <span>Editing message</span>
            <button type="button" onClick={onCancelEdit} aria-label="Cancel edit">
              ×
            </button>
          </div>
        )}
        {replyTo && !editing && (
          <div className="reply-chip">
            <span>Replying: {(replyTo.body || 'Attachment').slice(0, 60)}</span>
            <button type="button" onClick={onCancelReply} aria-label="Cancel reply">
              ×
            </button>
          </div>
        )}
        {recording ? (
          <div className="recording-bar">
            <span className="rec-dot" />
            Recording {recordSecs}s — release to send
            <button type="button" className="linkish" onClick={cancelRecording}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            {file && (
              <div className="file-chip" title={file.name}>
                <span>{file.name}</span>
                <button type="button" onClick={() => setFile(null)} aria-label="Remove file">
                  ×
                </button>
              </div>
            )}
            {micError && <p className="error composer-error">{micError}</p>}
            <input
              ref={inputRef}
              className="composer-input"
              placeholder={editing ? 'Edit message' : 'Message'}
              value={text}
              onChange={(e) => handleChange(e.target.value)}
              disabled={disabled || busy}
            />
          </>
        )}
      </div>

      {!text.trim() && !file && !editing ? (
        <button
          type="button"
          className={`btn primary mic-btn ${recording ? 'recording' : ''}`}
          disabled={disabled || busy}
          onPointerDown={(e) => void startRecording(e)}
          onPointerUp={stopRecording}
          onPointerCancel={stopRecording}
          onContextMenu={(e) => e.preventDefault()}
          title="Hold to record voice note"
        >
          {recording ? '…' : 'Mic'}
        </button>
      ) : (
        <button
          type="submit"
          className="btn primary"
          disabled={disabled || busy || recording || (Boolean(editing) && !text.trim())}
        >
          {editing ? 'Save' : 'Send'}
        </button>
      )}
    </form>
  )
}
