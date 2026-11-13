import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { GripVertical, Pencil, Plus, SendHorizontal, Trash2 } from 'lucide-react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { AutoTextarea } from './auto-textarea'
import { ConfirmAction } from './confirm-action'
import { ConnectionStatus } from './connection-status'
import { Tip } from './tip'
import { UndoNotice, type PendingUndo } from './undo-notice'
import type { Snapshot, Template } from '../lib/runtime'

const LIMIT = 10
const TEXT_LIMIT = 100
const UNDO_MS = 5000
// 只允许上下拖
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 })

// 编辑态的文案输入框：和按钮同高，失焦或回车保存，Esc 还原
function TextField(props: { value: string; onSave: (value: string) => void; autoFocus?: boolean; placeholder?: string; onCancel?: () => void }) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  return (
    <Input
      autoFocus={props.autoFocus}
      value={value}
      maxLength={TEXT_LIMIT}
      placeholder={props.placeholder}
      className='h-9 min-w-0 flex-1'
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const next = value.trim()
        if (next && next !== props.value) props.onSave(next)
        else if (!next) props.onCancel?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setValue(props.value)
          props.onCancel?.()
        }
      }}
    />
  )
}

// 一行：左侧把手、中间按钮或输入框、右侧固定一格（编辑时是垃圾桶），两种状态位置和高度一致
function Row(props: {
  item: Template
  editing: boolean
  disabled: boolean
  send: (text: string) => void
  update: (text: string) => void
  remove: () => void
}) {
  const sortable = useSortable({ id: props.item.id })
  return (
    <li
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      className={`group flex items-center gap-1 ${sortable.isDragging ? 'relative z-10' : ''}`}
    >
      <button
        aria-label='拖动排序'
        className='flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/50 group-hover:text-muted-foreground hover:bg-muted active:cursor-grabbing'
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical className='size-4' />
      </button>
      {props.editing ? (
        <TextField value={props.item.text} onSave={props.update} />
      ) : (
        <Button
          variant='outline'
          className={`h-9 min-w-0 flex-1 justify-start ${sortable.isDragging ? 'shadow-md' : ''}`}
          disabled={props.disabled}
          onClick={() => props.send(props.item.text)}
        >
          <span className='truncate'>{props.item.text}</span>
        </Button>
      )}
      <span className='flex size-9 shrink-0 items-center justify-center'>
        {props.editing && (
          <Tip content='删除'>
            <Button variant='ghost' size='icon' aria-label='删除' onClick={props.remove}>
              <Trash2 />
            </Button>
          </Tip>
        )}
      </span>
    </li>
  )
}

export function Compose(props: {
  snapshot: Snapshot
  draft: string
  setDraft: (value: string) => void
  sending: boolean
  send: (body: string) => Promise<boolean>
  saveTemplates: (templates: Template[]) => Promise<boolean>
  resetTemplates: () => Promise<boolean>
  editing: boolean
  setEditing: (value: boolean) => void
  reconnect: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}) {
  const { snapshot, editing } = props
  const busy = props.disabled || props.sending
  // 排序和编辑立即生效，保存失败时跟随快照还原
  const [items, setItems] = useState(snapshot.templates)
  useEffect(() => setItems(snapshot.templates), [snapshot.templates])
  const latest = useRef(items)
  latest.current = items
  const [adding, setAdding] = useState(false)
  const [undo, setUndo] = useState<PendingUndo | null>(null)
  const clearUndo = useCallback(() => setUndo(null), [])
  useEffect(() => {
    if (!editing) setAdding(false)
  }, [editing])
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  function save(next: Template[]) {
    setItems(next)
    void props.saveTemplates(next).then((ok) => !ok && setItems(snapshot.templates))
  }
  // 删除立即生效，5 秒内可撤销，插回原位置；再删一条会顶掉上一次的撤销
  function remove(item: Template) {
    const index = items.findIndex((t) => t.id === item.id)
    save(items.filter((t) => t.id !== item.id))
    setUndo({
      key: `${item.id}-${Date.now()}`,
      label: `已删除「${item.text}」`,
      expiresAt: Date.now() + UNDO_MS,
      undo: () => {
        const current = latest.current
        if (current.some((t) => t.id === item.id) || current.length >= LIMIT) return
        const next = [...current]
        next.splice(Math.min(index, next.length), 0, item)
        save(next)
      },
    })
  }
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    save(arrayMove(items, items.findIndex((t) => t.id === active.id), items.findIndex((t) => t.id === over.id)))
  }
  async function submit() {
    if (await props.send(props.draft)) props.setDraft('')
  }
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-4'>
      <UndoNotice pending={undo} onExpire={clearUndo} />
      <div className='flex h-8 shrink-0 items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-3'>
          <h2 className='font-medium'>发送</h2>
          <ConnectionStatus connection={snapshot.connection} onReconnect={props.reconnect} />
        </div>
        {editing ? (
          <Button size='sm' onClick={() => props.setEditing(false)}>
            完成
          </Button>
        ) : (
          <Tip content='编辑文案'>
            <Button variant='ghost' size='icon-sm' aria-label='编辑文案' disabled={props.disabled} onClick={() => props.setEditing(true)}>
              <Pencil />
            </Button>
          </Tip>
        )}
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4'>
        <div className='max-w-md'>
          {items.length === 0 && !editing && <p className='text-muted-foreground'>暂无文案</p>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[vertical]} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <ul className='space-y-1.5'>
                {items.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    editing={editing}
                    disabled={busy}
                    send={(text) => void props.send(text)}
                    update={(text) => save(items.map((t) => (t.id === item.id ? { ...t, text } : t)))}
                    remove={() => remove(item)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {editing && (
            <div className='space-y-1.5 pt-1.5'>
              {adding && (
                <div className='flex items-center gap-1 pr-10 pl-9'>
                  <TextField
                    value=''
                    autoFocus
                    placeholder='新文案'
                    onCancel={() => setAdding(false)}
                    onSave={(text) => {
                      setAdding(false)
                      save([...items, { id: '', text }])
                    }}
                  />
                </div>
              )}
              <div className='flex items-center justify-between pr-10 pl-9'>
                {items.length < LIMIT && !adding ? (
                  <Button variant='ghost' size='sm' onClick={() => setAdding(true)}>
                    <Plus />
                    添加
                  </Button>
                ) : (
                  <span />
                )}
                <ConfirmAction
                  label='恢复默认'
                  description='恢复默认文案？当前文案会被替换'
                  success='已恢复默认文案'
                  trigger={
                    <Button variant='ghost' size='sm' className='text-muted-foreground'>
                      恢复默认
                    </Button>
                  }
                  onConfirm={props.resetTemplates}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      <div className='flex shrink-0 items-end gap-2'>
        <AutoTextarea
          ref={props.inputRef}
          value={props.draft}
          disabled={props.disabled}
          maxRows={6}
          maxLength={500}
          placeholder='自定义消息'
          onChange={(e) => props.setDraft(e.target.value)}
          onSubmit={() => void submit()}
        />
        <Button size='icon' className='size-9 shrink-0' aria-label='发送' disabled={busy || !props.draft.trim()} onClick={() => void submit()}>
          <SendHorizontal />
        </Button>
      </div>
    </section>
  )
}
