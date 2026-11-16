import { Trash2 } from 'lucide-react'
import { ConfirmAction } from './confirm-action'
import { HelpTip } from './help-tip'
import { Avatar } from './avatar'
import { OverflowText } from './overflow-text'
import { groupHistory } from '../lib/history-groups'
import type { Identity, Message } from '../lib/runtime'

function time(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function History(props: {
  messages: Message[]
  identity: Identity
  avatarStyle: string
  clear: () => Promise<boolean>
  disabled: boolean
}) {
  // 按天分组，组内最新的在上
  const groups = groupHistory(props.messages)
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='flex shrink-0 items-center justify-between'>
        <div className='flex items-center gap-0.5'>
          <h2 className='font-medium'>历史</h2>
          <HelpTip label='历史保留规则'>
            只保留 30 天内、最近 300 条，更早的自动清掉；只存在这台电脑上
          </HelpTip>
        </div>
        {props.messages.length > 0 && (
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
        {groups.length === 0 ? (
          <p className='text-muted-foreground'>暂无</p>
        ) : (
          <div className='space-y-3'>
            {groups.map((group) => (
              <section key={group.key}>
                <h3 className='py-1 text-muted-foreground'>{group.title}</h3>
                <ul className='divide-y'>
                  {group.messages.map((m) => {
                    const text =
                      m.status === 'undecryptable'
                        ? '无法解密'
                        : [m.title, m.body].filter(Boolean).join(' · ')
                    return (
                      <li
                        key={m.id}
                        data-message-id={m.id}
                        className='flex items-baseline gap-3 py-1.5'
                      >
                        <span className='w-12 shrink-0 text-muted-foreground tabular-nums'>
                          {time(m.time)}
                        </span>
                        <span className='flex w-28 shrink-0 items-center gap-2 self-center text-muted-foreground'>
                          <Avatar
                            id={m.mine ? props.identity.id : m.senderId}
                            name={m.mine ? props.identity.name : m.senderName}
                            avatar={m.mine ? props.avatarStyle : m.senderAvatar}
                            size={24}
                          />
                          <OverflowText text={m.toSelf ? '仅自己' : m.mine ? '我' : m.senderName || '—'} />
                        </span>
                        <OverflowText
                          text={text}
                          className={`flex-1 ${m.status === 'undecryptable' ? 'text-muted-foreground' : ''}`}
                        />
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
