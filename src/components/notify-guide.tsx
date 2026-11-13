import { Bell, BellOff } from 'lucide-react'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'
import { api, type NotificationStatus } from '../lib/runtime'

/**
 * 通知权限引导：首次打开还没决定时，点确认或直接关掉都会触发系统的「是否允许」；
 * 已经拒绝过时，点确认或关掉都打开系统设置里 FoxNudge 的通知页（系统不会再问第二次）
 */
export function NotifyGuide(props: {
  status: NotificationStatus
  onDone: (status: NotificationStatus) => void
}) {
  const denied = props.status === 'denied'
  async function finish() {
    if (denied) {
      await api.openNotificationSettings().catch(() => {})
      props.onDone(props.status)
    } else {
      props.onDone(await api.requestNotifications().catch(() => props.status))
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && void finish()}>
      <DialogContent className='gap-0' showCloseButton>
        <div className='flex flex-col items-center gap-3 pt-4 pb-5 text-center'>
          <div className='flex size-12 items-center justify-center rounded-full bg-secondary text-primary'>
            {denied ? (
              <BellOff className='size-6' />
            ) : (
              <Bell className='size-6' />
            )}
          </div>
          <DialogTitle>{denied ? '通知已关闭' : '允许通知'}</DialogTitle>
          <DialogDescription>
            {denied
              ? '在系统设置里打开 FoxNudge 的通知'
              : '收到消息时用系统通知提醒你'}
          </DialogDescription>
        </div>
        <Button onClick={() => void finish()}>
          {denied ? '打开系统设置' : '好的'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
