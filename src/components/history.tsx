import { Trash2 } from 'lucide-react'
import { ConfirmAction } from './confirm-action'
import { HelpTip } from './help-tip'
import { Avatar } from './avatar'
import type { Identity, Message } from '../lib/runtime'

function when(seconds: number) {
  const date = new Date(seconds * 1000)
  const today = new Date().toDateString() === date.toDateString()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return today ? time : `${date.getMonth() + 1}-${date.getDate()} ${time}`
}

export function History(props: {
  messages: Message[]
  identity: Identity
  avatarStyle: string
  clear: () => Promise<boolean>
  disabled: boolean
}) {
  // 最新的在上面
  const messages = [...props.messages].reverse()
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='flex shrink-0 items-center justify-between'>
        <div className='flex items-center gap-0.5'>
          <h2 className='font-medium'>历史</h2>
          <HelpTip label='历史保留规则'>只保留最近 300 条，更早的自动清掉；只存在这台电脑上</HelpTip>
        </div>
        {messages.length > 0 && (
          <ConfirmAction
            label='清空历史'
            description='只清空这台电脑上的记录'
            icon={<Trash2 />}
            ghost
            disabled={props.disabled}
            onConfirm={props.clear}
          />
        )}
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable]'>
        {messages.length === 0 ? (
          <p className='text-muted-foreground'>暂无</p>
        ) : (
          <ul className='divide-y'>
            {messages.map((m) => {
              const text = m.status === 'undecryptable' ? '无法解密' : [m.title, m.body].filter(Boolean).join(' · ')
              return (
                <li key={m.id} data-message-id={m.id} className='flex items-baseline gap-3 py-1.5' title={text}>
                  <span className='w-20 shrink-0 text-muted-foreground tabular-nums'>{when(m.time)}</span>
                  <span className='flex w-28 shrink-0 items-center gap-2 self-center text-muted-foreground'>
                    <Avatar
                      id={m.mine ? props.identity.id : m.senderId}
                      name={m.mine ? props.identity.name : m.senderName}
                      avatar={m.mine ? props.avatarStyle : m.senderAvatar}
                      size={24}
                    />
                    <span className='truncate'>{m.mine ? '我' : m.senderName || '—'}</span>
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${m.status === 'undecryptable' ? 'text-muted-foreground' : ''}`}>{text}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
