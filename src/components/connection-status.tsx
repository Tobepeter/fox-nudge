import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Tip } from './tip'
import type { Connection } from '../lib/runtime'

export function connectionText(c: Connection, now = Date.now()) {
  switch (c.state) {
    case 'connected':
      return c.mode === 'poll' ? '已连接（轮询）' : '已连接'
    case 'connecting':
      return '正在连接…'
    case 'unconfigured':
      return '未配置服务器'
    default: {
      const seconds = c.retryAt ? Math.max(0, Math.ceil((c.retryAt - now) / 1000)) : 0
      return seconds > 0 ? `未连接，${seconds} 秒后重试` : '未连接'
    }
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
  const [now, setNow] = useState(Date.now())
  // 只在等待重试时走秒，其他状态不起定时器
  useEffect(() => {
    if (connection.state !== 'waiting' || !connection.retryAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [connection.state, connection.retryAt])
  const text = connectionText(connection, now)
  const status = (
    <span className='flex min-w-0 items-center gap-2 text-muted-foreground'>
      <span className={`size-2 shrink-0 rounded-full ${dot[connection.state] ?? dot.waiting}`} />
      <span className='truncate'>{text}</span>
    </span>
  )
  return (
    <div className='flex min-w-0 items-center gap-1'>
      {connection.error ? <Tip content={connection.error}>{status}</Tip> : status}
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
