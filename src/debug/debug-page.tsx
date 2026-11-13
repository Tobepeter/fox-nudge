// DEBUG：开发版调试页。上：分页；中：滚动区；下：固定状态栏。模拟消息和断线走与真实订阅相同的处理路径
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { connectionText } from '../components/connection-status'
import { api, type InjectMessage, type Snapshot } from '../lib/runtime'

const tabs = [
  { value: 'message', label: '模拟消息' },
  { value: 'connection', label: '连接' },
  { value: 'state', label: '状态' },
]
const pressed = 'px-3 data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground'

async function run(work: () => Promise<unknown>, done?: string) {
  try {
    await work()
    if (done) toast.success(done, { id: 'debug', duration: 1500 })
  } catch (e) {
    toast.error(String(e), { id: 'debug' })
  }
}

function Group(props: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-2'>
      <h3 className='text-muted-foreground'>{props.title}</h3>
      {props.children}
    </section>
  )
}

function MessageTab() {
  const [sender, setSender] = useState('小明')
  const [body, setBody] = useState('在吗，来一下')
  const inject = (extra: Partial<InjectMessage> = {}) => run(() => api.debugInject({ senderName: sender, body, ...extra }))
  return (
    <div className='space-y-5'>
      <Group title='内容'>
        <div className='flex max-w-md gap-2'>
          <Input className='w-28' value={sender} onChange={(e) => setSender(e.target.value)} placeholder='发送者' />
          <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder='内容' />
        </div>
      </Group>
      <Group title='收到一条'>
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' onClick={() => void inject()}>
            明文
          </Button>
          <Button variant='outline' onClick={() => void inject({ encrypted: true })}>
            加密
          </Button>
          <Button variant='outline' onClick={() => void inject({ wrongKey: true })}>
            密钥不一致
          </Button>
        </div>
      </Group>
      <Group title='离线补收'>
        <Button
          variant='outline'
          onClick={() =>
            void run(async () => {
              for (let i = 1; i <= 3; i++) await api.debugInject({ senderName: sender, body: `离线消息 ${i}`, backlog: true })
            })
          }
        >
          补收 3 条，合并成一条提醒
        </Button>
      </Group>
    </div>
  )
}

function ConnectionTab({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap gap-2'>
        <Button variant='outline' onClick={() => void run(api.debugDisconnect)}>
          模拟断线
        </Button>
        <Button variant='outline' onClick={() => void run(api.reconnect)}>
          重新连接
        </Button>
      </div>
      <pre className='rounded-lg bg-muted p-3'>{JSON.stringify(snapshot.connection, null, 2)}</pre>
    </div>
  )
}

function StateTab() {
  const [state, setState] = useState<unknown>(null)
  const refresh = () => setState(window.__DEBUG__?.nudge?.app ? (window.__DEBUG__.nudge.app as { snapshot: () => unknown }).snapshot() : null)
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => clearInterval(timer)
  }, [])
  return <pre className='rounded-lg bg-muted p-3'>{JSON.stringify(state, null, 2)}</pre>
}

export function DebugPage(props: { snapshot: Snapshot }) {
  const [tab, setTab] = useState('message')
  const { snapshot } = props
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-4'>
      <div className='flex shrink-0 items-center justify-between'>
        <h2 className='font-medium text-amber-600 dark:text-amber-400'>调试</h2>
        <ToggleGroup value={[tab]} onValueChange={([next]) => next && setTab(next)} variant='outline' size='sm' spacing={0} aria-label='调试分类'>
          {tabs.map((t) => (
            <ToggleGroupItem key={t.value} value={t.value} className={pressed}>
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4'>
        {tab === 'message' && <MessageTab />}
        {tab === 'connection' && <ConnectionTab snapshot={snapshot} />}
        {tab === 'state' && <StateTab />}
      </div>
      <div className='flex shrink-0 items-center justify-between gap-3 border-t pt-3 text-muted-foreground'>
        <span>
          {connectionText(snapshot.connection)} · {snapshot.messages.length} 条消息
        </span>
        <code>__DEBUG__.nudge.app</code>
      </div>
    </section>
  )
}
