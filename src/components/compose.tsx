import { useEffect, useRef, useState, type RefObject } from 'react'
import { Plus, SendHorizontal, X } from 'lucide-react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { AutoTextarea } from './auto-textarea'
import { ConnectionStatus } from './connection-status'
import type { Snapshot, Template } from '../lib/runtime'

const LIMIT = 10
const TEXT_LIMIT = 100

// 就地编辑：Enter 或失焦保存，Esc 放弃
function InlineInput(props: { initial: string; onDone: (value: string | null) => void; placeholder?: string }) {
  const [value, setValue] = useState(props.initial)
  const done = useRef(false)
  const finish = (next: string | null) => {
    if (done.current) return
    done.current = true
    props.onDone(next)
  }
  return (
    <Input
      autoFocus
      value={value}
      maxLength={TEXT_LIMIT}
      placeholder={props.placeholder}
      className='h-9 w-40'
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(value)
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

function Preset(props: {
  item: Template
  disabled: boolean
  dragging: RefObject<boolean>
  send: (text: string) => void
  update: (text: string) => void
  remove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const sortable = useSortable({ id: props.item.id, disabled: editing || props.disabled })
  const style = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    zIndex: sortable.isDragging ? 10 : undefined,
  }
  if (editing)
    return (
      <div ref={sortable.setNodeRef} style={style}>
        <InlineInput
          initial={props.item.text}
          onDone={(value) => {
            setEditing(false)
            if (value !== null && value.trim() && value.trim() !== props.item.text) props.update(value.trim())
          }}
        />
      </div>
    )
  return (
    <div ref={sortable.setNodeRef} style={style} className='group relative' {...sortable.attributes} {...sortable.listeners}>
      <Button
        variant='outline'
        className={`h-9 max-w-56 px-3.5 ${sortable.isDragging ? 'shadow-md' : ''}`}
        title='点击广播，双击编辑，拖动排序'
        disabled={props.disabled}
        onClick={() => !props.dragging.current && props.send(props.item.text)}
        onDoubleClick={() => setEditing(true)}
      >
        <span className='truncate'>{props.item.text}</span>
      </Button>
      <button
        aria-label='删除'
        className='absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-muted-foreground/70 text-background group-hover:flex hover:bg-destructive'
        onPointerDown={(e) => e.stopPropagation()}
        onClick={props.remove}
      >
        <X className='size-3' />
      </button>
    </div>
  )
}

export function Compose(props: {
  snapshot: Snapshot
  draft: string
  setDraft: (value: string) => void
  sending: boolean
  send: (body: string) => Promise<boolean>
  saveTemplates: (templates: Template[]) => Promise<boolean>
  reconnect: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}) {
  const { snapshot } = props
  const busy = props.disabled || props.sending
  // 拖动后立即生效，保存失败时跟随快照还原
  const [items, setItems] = useState(snapshot.templates)
  useEffect(() => setItems(snapshot.templates), [snapshot.templates])
  const [adding, setAdding] = useState(false)
  const dragging = useRef(false)
  const sensors = useSensors(
    // 移动 6px 才算拖动，单击仍然是广播
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  function save(next: Template[]) {
    setItems(next)
    void props.saveTemplates(next).then((ok) => !ok && setItems(snapshot.templates))
  }
  function onDragEnd(event: DragEndEvent) {
    setTimeout(() => (dragging.current = false), 0)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = items.findIndex((t) => t.id === active.id)
    const to = items.findIndex((t) => t.id === over.id)
    save(arrayMove(items, from, to))
  }
  async function submit() {
    if (await props.send(props.draft)) props.setDraft('')
  }
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-4'>
      <div className='flex shrink-0 items-center gap-3'>
        <h2 className='font-medium'>发送</h2>
        <ConnectionStatus connection={snapshot.connection} onReconnect={props.reconnect} />
      </div>
      <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4 pt-1.5'>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => (dragging.current = true)}
          onDragCancel={() => (dragging.current = false)}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={items.map((t) => t.id)} strategy={rectSortingStrategy}>
            <div className='flex flex-wrap gap-2.5'>
              {items.map((item) => (
                <Preset
                  key={item.id}
                  item={item}
                  disabled={busy}
                  dragging={dragging}
                  send={(text) => void props.send(text)}
                  update={(text) => save(items.map((t) => (t.id === item.id ? { ...t, text } : t)))}
                  remove={() => save(items.filter((t) => t.id !== item.id))}
                />
              ))}
              {adding ? (
                <InlineInput
                  initial=''
                  placeholder='新文案'
                  onDone={(value) => {
                    setAdding(false)
                    if (value?.trim()) save([...items, { id: '', text: value.trim() }])
                  }}
                />
              ) : (
                items.length < LIMIT && (
                  <Button variant='ghost' className='h-9 border border-dashed px-3 text-muted-foreground' aria-label='添加文案' disabled={props.disabled} onClick={() => setAdding(true)}>
                    <Plus />
                  </Button>
                )
              )}
            </div>
          </SortableContext>
        </DndContext>
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
