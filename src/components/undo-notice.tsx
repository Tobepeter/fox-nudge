import { useEffect } from 'react'
import { toast } from 'sonner'

export type PendingUndo = {
  /** 每次删除唯一，新的删除顶掉旧的 */
  key: string
  label: string
  expiresAt: number
  undo: () => void
}

const toastId = 'undo-delete'

// 照 TalkMore：同一个通知位，倒计时撤销；新的删除会替换旧的，多次撤销之间互斥
export function UndoNotice(props: { pending: PendingUndo | null; onExpire: () => void }) {
  const { pending, onExpire } = props
  useEffect(() => {
    if (!pending) {
      toast.dismiss(toastId)
      return
    }
    let previous = -1
    let dismissed = false
    function update() {
      if (dismissed || !pending) return
      const seconds = Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000))
      if (seconds === previous) return
      previous = seconds
      if (!seconds) {
        toast.dismiss(toastId)
        onExpire()
        return
      }
      toast(pending.label, {
        id: toastId,
        duration: Infinity,
        onDismiss: () => {
          dismissed = true
          onExpire()
        },
        action: {
          label: `撤销 ${seconds}s`,
          onClick: (event) => {
            event.preventDefault()
            dismissed = true
            toast.dismiss(toastId)
            pending.undo()
            onExpire()
          },
        },
      })
    }
    update()
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [pending, onExpire])
  useEffect(() => () => void toast.dismiss(toastId), [])
  return null
}
