import { Avatar } from './avatar'
import { HelpTip } from './help-tip'
import { OverflowText } from './overflow-text'
import type { Identity, Peer } from '../lib/runtime'

function seen(lastSeen: number) {
  const minutes = Math.floor((Date.now() / 1000 - lastSeen) / 60)
  if (minutes < 1) return '刚刚在线'
  if (minutes < 60) return `${minutes} 分钟前在线`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前在线`
  return `${Math.floor(minutes / 60 / 24)} 天前在线`
}

function Row(props: {
  id: string
  name: string
  avatar: string
  online: boolean
  sub: string
}) {
  return (
    <li className='flex items-center gap-3 px-3 py-2.5'>
      <span
        className={`relative inline-flex shrink-0 ${props.online ? '' : 'opacity-50'}`}
      >
        <Avatar id={props.id} name={props.name} avatar={props.avatar} size={32} />
        {/* 头像右下角的在线灯：绿色在线，灰色离线 */}
        <span
          className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card ${props.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
        />
      </span>
      <div className='flex min-w-0 flex-1 flex-col'>
        <OverflowText text={props.name} className='font-medium' />
        <span className='text-muted-foreground'>{props.sub}</span>
      </div>
    </li>
  )
}

/** 在线页：本机排第一，其余在线的在前；这次运行里见过、已经离线的变灰 */
export function Peers(props: {
  peers: Peer[]
  identity: Identity
  avatarStyle: string
  paused: boolean
  connected: boolean
  /** 心跳被服务器限流，别人看到的状态可能过时；只在这里显示，不弹通知 */
  limited: boolean
}) {
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='flex shrink-0 items-center gap-0.5'>
        <h2 className='font-medium'>在线</h2>
        <HelpTip label='在线状态说明'>
          每台电脑大约每 10 分钟报一次平安，25 分钟没消息就算离线，所以睡眠、断网要过一阵才显示离线；正常退出会马上显示。只在这次运行里记，不存盘
        </HelpTip>
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable]'>
        <ul className='divide-y rounded-lg border bg-card'>
          <Row
            id={props.identity.id}
            name={props.identity.name}
            avatar={props.avatarStyle}
            online={props.connected}
            sub={
              !props.connected
                ? '本机 · 没连上服务器'
                : props.limited
                  ? '本机 · 服务器限流，别人看到的状态可能过时'
                  : props.paused
                  ? '本机 · 暂停提醒中'
                  : '本机'
            }
          />
          {props.peers.map((p) => (
            <Row
              key={p.id}
              id={p.id}
              name={p.name}
              avatar={p.avatar}
              online={p.online}
              sub={
                !p.online
                  ? seen(p.lastSeen)
                  : p.paused
                    ? '在线 · 暂停提醒中，发过去不会响'
                    : '在线'
              }
            />
          ))}
        </ul>
        {props.peers.length === 0 && (
          <p className='mt-3 text-muted-foreground'>暂时没有其他设备在线</p>
        )}
      </div>
    </section>
  )
}
