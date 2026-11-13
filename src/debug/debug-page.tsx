// DEBUG：开发版调试页，模拟收消息、断线和离线补收，走和真实订阅相同的处理路径
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { api, type Snapshot } from '../lib/runtime'

export function DebugPage(props: { snapshot: Snapshot }) {
  const [sender, setSender] = useState('小明')
  const [body, setBody] = useState('在吗，来一下')
  async function run(work: () => Promise<unknown>, done?: string) {
    try {
      await work()
      if (done) toast.success(done, { id: 'debug' })
    } catch (e) {
      toast.error(String(e), { id: 'debug' })
    }
  }
  const inject = (extra: Parameters<typeof api.debugInject>[0] = { body }) =>
    run(() => api.debugInject({ senderName: sender, ...extra }))
  return (
    <div className='max-w-2xl space-y-6 pb-4'>
      <h2 className='font-medium text-amber-600 dark:text-amber-400'>调试</h2>
      <section className='space-y-2'>
        <h3 className='text-muted-foreground'>模拟收到消息</h3>
        <div className='flex gap-2'>
          <Input className='w-32' value={sender} onChange={(e) => setSender(e.target.value)} placeholder='发送者' />
          <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder='内容' />
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' onClick={() => void inject({ body })}>
            明文消息
          </Button>
          <Button variant='outline' onClick={() => void inject({ body, encrypted: true })}>
            加密消息
          </Button>
          <Button variant='outline' onClick={() => void inject({ body, wrongKey: true })}>
            密钥不一致
          </Button>
          <Button
            variant='outline'
            onClick={() =>
              void run(async () => {
                for (let i = 1; i <= 3; i++) await api.debugInject({ senderName: sender, body: `离线消息 ${i}`, backlog: true })
              })
            }
          >
            离线补收 3 条
          </Button>
        </div>
      </section>
      <section className='space-y-2'>
        <h3 className='text-muted-foreground'>连接</h3>
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' onClick={() => void run(api.debugDisconnect)}>
            模拟断线
          </Button>
          <Button variant='outline' onClick={() => void run(api.reconnect)}>
            重新连接
          </Button>
        </div>
        <pre className='app-scroll overflow-auto rounded-lg bg-muted p-3'>{JSON.stringify(props.snapshot.connection, null, 2)}</pre>
      </section>
      <section className='space-y-1 text-muted-foreground'>
        <p>探针：window.__DEBUG__.nudge.app，桌面开发版可用 pnpm probe -- snapshot</p>
      </section>
    </div>
  )
}
