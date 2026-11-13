import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Tip } from './tip'
import type { Template } from '../lib/runtime'

type Draft = { id: string; title: string; body: string }

export function Templates(props: {
  templates: Template[]
  save: (templates: Template[]) => Promise<boolean>
  disabled: boolean
}) {
  const [editing, setEditing] = useState<Draft | null>(null)
  const list = props.templates
  function move(index: number, offset: number) {
    const next = [...list]
    const [item] = next.splice(index, 1)
    next.splice(index + offset, 0, item)
    void props.save(next)
  }
  async function submit() {
    if (!editing) return
    const next = editing.id
      ? list.map((t) => (t.id === editing.id ? { ...editing } : t))
      : [...list, { ...editing, id: '' }]
    if (await props.save(next)) setEditing(null)
  }
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='flex shrink-0 items-center justify-between'>
        <h2 className='font-medium'>模板</h2>
        <Button
          variant='outline'
          size='sm'
          disabled={props.disabled || list.length >= 30}
          onClick={() => setEditing({ id: '', title: '', body: '' })}
        >
          <Plus />
          新建模板
        </Button>
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable]'>
        {list.length === 0 ? (
          <p className='text-muted-foreground'>暂无</p>
        ) : (
          <ul className='divide-y'>
            {list.map((t, index) => (
              <li key={t.id} className='group flex items-center gap-3 py-2'>
                <div className='min-w-0 flex-1'>
                  <div className='font-medium'>{t.title}</div>
                  <div className='truncate text-muted-foreground'>{t.body}</div>
                </div>
                <div className='flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'>
                  <Tip content='上移'>
                    <Button variant='ghost' size='icon-sm' aria-label='上移' disabled={props.disabled || index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp />
                    </Button>
                  </Tip>
                  <Tip content='下移'>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label='下移'
                      disabled={props.disabled || index === list.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </Button>
                  </Tip>
                  <Tip content='编辑'>
                    <Button variant='ghost' size='icon-sm' aria-label='编辑' disabled={props.disabled} onClick={() => setEditing({ ...t })}>
                      <Pencil />
                    </Button>
                  </Tip>
                  <Tip content='删除'>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label='删除'
                      disabled={props.disabled}
                      onClick={() => void props.save(list.filter((x) => x.id !== t.id))}
                    >
                      <Trash2 />
                    </Button>
                  </Tip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? '编辑模板' : '新建模板'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <form
              className='space-y-3'
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <Input
                autoFocus
                maxLength={20}
                placeholder='名称，例如：来一下'
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
              <Textarea
                rows={3}
                maxLength={500}
                placeholder='发送的内容'
                value={editing.body}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              />
              <DialogFooter>
                <Button type='button' variant='outline' onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button type='submit' disabled={props.disabled || !editing.title.trim() || !editing.body.trim()}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
