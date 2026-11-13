import { RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Tip } from './tip'
import type { Connection } from '../lib/runtime'

// 只有三种固定文案，不显示倒计时，避免文字跳动；失败原因放在悬停提示里
export function connectionText(c: Connection) {
  switch (c.state) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'unconfigured':
      return '未配置'
    default:
      return '未连接'
  }
}

const dot: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-amber-500 animate-pulse',
  unconfigured: 'bg-muted-foreground',
  waiting: 'bg-destructive',
}

export function ConnectionStatus(props: { connection: Connection; onReconnect: () => void }) {
  const { connection } = props
  const status = (
    <span className='flex items-center gap-2 text-muted-foreground'>
      <span className={`size-2 shrink-0 rounded-full ${dot[connection.state] ?? dot.waiting}`} />
      {connectionText(connection)}
    </span>
  )
  return (
    <div className='flex items-center gap-1'>
      {connection.state === 'waiting' && connection.error ? <Tip content={`${connection.error}，会自动重试`}>{status}</Tip> : status}
      {connection.state === 'waiting' && (
        <Tip content='立即重连'>
          <Button variant='ghost' size='icon-sm' aria-label='立即重连' onClick={props.onReconnect}>
            <RefreshCw />
          </Button>
        </Tip>
      )}
    </div>
  )
}
