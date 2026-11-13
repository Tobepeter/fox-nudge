import type { RefObject } from 'react'
import { SendHorizontal } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { ConnectionStatus } from './connection-status'
import type { Snapshot } from '../lib/runtime'

export function Compose(props: {
  snapshot: Snapshot
  draft: string
  setDraft: (value: string) => void
  sending: boolean
  send: (body: string) => Promise<boolean>
  reconnect: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}) {
  const { snapshot } = props
  const busy = props.disabled || props.sending
  async function submit() {
    if (await props.send(props.draft)) props.setDraft('')
  }
  return (
    <section className='flex flex-col gap-3'>
      <div className='flex items-center gap-3'>
        <h2 className='font-medium'>发送</h2>
        <ConnectionStatus connection={snapshot.connection} onReconnect={props.reconnect} />
      </div>
      <Textarea
        ref={props.inputRef}
        autoFocus
        value={props.draft}
        disabled={props.disabled}
        onChange={(e) => props.setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        rows={4}
        maxLength={500}
        placeholder='Enter 发送，Shift+Enter 换行'
        className='resize-none'
      />
      <div className='flex items-start justify-between gap-3'>
        <div className='flex flex-wrap gap-1.5'>
          {snapshot.templates.map((t) => (
            <Button key={t.id} variant='outline' size='sm' title={t.body} disabled={busy} onClick={() => void props.send(t.body)}>
              {t.title}
            </Button>
          ))}
        </div>
        <Button disabled={busy || !props.draft.trim()} onClick={() => void submit()}>
          <SendHorizontal />
          发送
        </Button>
      </div>
    </section>
  )
}
