// DEBUG：开发版调试页，只留常用的几项。模拟消息只写本机历史，「清除模拟消息」可随时还原
// 一次性看效果用的 mock 不放这里，临时写死在代码里，看完就删
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { api, type InjectMessage, type Snapshot } from '../lib/runtime'
import type { DebugGuide } from '../app'

const tabs = [
  { value: 'mock', label: '模拟' },
  { value: 'state', label: '状态' },
]
const pressed =
  'px-3 data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground'

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

type GuideStatus = 'real' | 'notDetermined' | 'denied' | 'authorized'
const guideStatuses: [GuideStatus, string][] = [
  ['real', '真实权限'],
  ['notDetermined', '未决定'],
  ['denied', '已拒绝'],
  ['authorized', '已允许'],
]

function MockTab() {
  // 引导弹窗用的模拟通知权限：dev 查不了真实权限（总是 unsupported），选一个看对应的样子
  const [status, setStatus] = useState<GuideStatus>('notDetermined')
  const showGuide = (mode: DebugGuide['mode']) =>
    window.dispatchEvent(
      new CustomEvent<DebugGuide>('fox-nudge:guide', {
        detail: { mode, status: status === 'real' ? undefined : status },
      }),
    )
  const [sender, setSender] = useState('小明')
  const [body, setBody] = useState('在吗，来一下')
  // 不同名字用不同 ID，头像才会不同
  const inject = (extra: Partial<InjectMessage> = {}) =>
    run(() =>
      api.debugInject({
        senderName: sender,
        senderId: `debug-${sender}`,
        body,
        ...extra,
      }),
    )
  return (
    <div className='space-y-5'>
      <Group title='收到一条消息'>
        <div className='flex max-w-md gap-2'>
          <Input
            className='w-28'
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            placeholder='发送者'
          />
          <Input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder='内容'
          />
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' onClick={() => void inject()}>
            明文
          </Button>
          <Button
            variant='outline'
            onClick={() => void inject({ encrypted: true })}
          >
            加密
          </Button>
          <Button
            variant='outline'
            onClick={() => void inject({ wrongKey: true })}
          >
            密钥不一致
          </Button>
        </div>
      </Group>
      <Group title='连接'>
        <div className='flex flex-wrap gap-2'>
          <Button
            variant='outline'
            onClick={() => void run(api.debugDisconnect)}
          >
            模拟断线
          </Button>
          <Button variant='outline' onClick={() => void run(api.reconnect)}>
            重新连接
          </Button>
        </div>
      </Group>
      <Group title='引导'>
        <div className='flex flex-wrap items-center gap-2'>
          <ToggleGroup
            value={[status]}
            onValueChange={([next]) => next && setStatus(next as GuideStatus)}
            variant='outline'
            spacing={0}
            aria-label='模拟通知权限'
          >
            {guideStatuses.map(([value, label]) => (
              <ToggleGroupItem key={value} value={value} className={pressed}>
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button variant='outline' onClick={() => showGuide('welcome')}>
            欢迎页
          </Button>
          <Button variant='outline' onClick={() => showGuide('notify')}>
            通知引导
          </Button>
        </div>
      </Group>
      <Group title='还原'>
        <Button
          variant='outline'
          onClick={() =>
            void run(async () =>
              toast.success(`已清除 ${await api.debugClearMock()} 条模拟消息`, {
                id: 'debug',
              }),
            )
          }
        >
          清除模拟消息
        </Button>
      </Group>
    </div>
  )
}

function StateTab({ snapshot }: { snapshot: Snapshot }) {
  const [state, setState] = useState<unknown>(null)
  useEffect(() => {
    const refresh = () =>
      setState(
        window.__DEBUG__?.nudge?.app
          ? (
              window.__DEBUG__.nudge.app as { snapshot: () => unknown }
            ).snapshot()
          : null,
      )
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className='space-y-3'>
      <pre className='rounded-lg bg-muted p-3'>
        {JSON.stringify(snapshot.connection, null, 2)}
      </pre>
      <pre className='rounded-lg bg-muted p-3'>
        {JSON.stringify(state, null, 2)}
      </pre>
    </div>
  )
}

export function DebugPage(props: { snapshot: Snapshot }) {
  const [tab, setTab] = useState('mock')
  const { snapshot } = props
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-4'>
      <div className='flex shrink-0 items-center justify-between'>
        <h2 className='font-medium text-amber-600 dark:text-amber-400'>调试</h2>
        <ToggleGroup
          value={[tab]}
          onValueChange={([next]) => next && setTab(next)}
          variant='outline'
          size='sm'
          spacing={0}
          aria-label='调试分类'
        >
          {tabs.map((t) => (
            <ToggleGroupItem key={t.value} value={t.value} className={pressed}>
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4'>
        {tab === 'mock' ? <MockTab /> : <StateTab snapshot={snapshot} />}
      </div>
    </section>
  )
}
