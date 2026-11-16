import { useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'
import { AvatarPicker } from './avatar-picker'
import { ClearableInput } from './clearable-input'
import { cleanName, hasName, NAME_LIMIT } from '../lib/avatar-text'
import { api, type NotificationStatus, type Snapshot } from '../lib/runtime'

/**
 * 引导弹窗，一屏完成，不分步：
 * - welcome：首次启动、清除数据后（或调试页触发），设昵称和头像；点「开始使用」或关掉都算看过，通知还没决定时接着弹系统询问
 * - 只有通知：应用里开着通知、系统还没允许时弹。还没决定时，点确认或直接关掉都触发系统的「是否允许」；
 *   已经拒绝过时打开系统设置里 FoxNudge 的通知页（系统不会再问第二次）
 */
export function NotifyGuide(props: {
  snapshot: Snapshot
  status: NotificationStatus
  welcome: boolean
  onAvatar: (avatarStyle: string) => void
  onDone: (status: NotificationStatus) => void
}) {
  const { snapshot, status } = props
  const denied = status === 'denied'
  const ask =
    snapshot.settings.notify && (status === 'notDetermined' || denied)
  const [name, setName] = useState(snapshot.identity.name)
  const [done, setDone] = useState(false)

  async function finish() {
    if (done) return
    setDone(true)
    if (props.welcome) {
      const next = cleanName(name)
      if ((next || snapshot.defaultName) !== snapshot.identity.name)
        await api.saveIdentity(next).catch(() => {})
      await api.finishWelcome().catch(() => {})
    }
    if (!ask) return props.onDone(status)
    if (denied) {
      // 欢迎页里只是顺带提一句，不替用户跳去系统设置
      if (!props.welcome) await api.openNotificationSettings().catch(() => {})
      return props.onDone(status)
    }
    props.onDone(await api.requestNotifications().catch(() => status))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && void finish()}>
      <DialogContent
        className={props.welcome ? 'gap-0 sm:max-w-xs' : 'gap-0'}
        showCloseButton
      >
        {props.welcome ? (
          <div className='flex flex-col items-center gap-3 pt-6 pb-6 text-center'>
            <AvatarPicker
              size={72}
              id={snapshot.identity.id}
              name={cleanName(name) || snapshot.defaultName}
              value={snapshot.settings.avatarStyle}
              named={hasName(cleanName(name) || snapshot.defaultName)}
              onChange={props.onAvatar}
            />
            <DialogTitle>欢迎使用 FoxNudge</DialogTitle>
            <ClearableInput
              className='mt-2 w-64'
              value={name}
              placeholder={snapshot.defaultName}
              maxLength={NAME_LIMIT}
              aria-label='昵称'
              onChange={(e) => setName(e.target.value)}
              onClear={() => setName('')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                  void finish()
              }}
            />
            {/* 还没决定时不用说明，点「开始使用」直接弹系统询问；已拒绝的系统不会再问，提一句 */}
            {ask && denied && (
              <p className='flex items-center gap-1.5 text-muted-foreground [&_svg]:size-4'>
                <BellOff />
                通知已关闭，可以在系统设置里打开
              </p>
            )}
          </div>
        ) : (
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
        )}
        <Button disabled={done} onClick={() => void finish()}>
          {props.welcome ? '开始使用' : denied ? '打开系统设置' : '好的'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
