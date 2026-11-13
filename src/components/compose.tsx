import { useEffect, useState, type RefObject } from 'react'
import { GripVertical, Pencil, Plus, SendHorizontal, X } from 'lucide-react'
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
import type { Snapshot, Template } from '../lib/runtime'

const LIMIT = 10
// 编辑列表只允许上下拖
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 })
const TEXT_LIMIT = 100

// 失焦或回车保存，Esc 还原
function TextField(props: { value: string; onSave: (value: string) => void; autoFocus?: boolean; placeholder?: string }) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  return (
    <Input
      autoFocus={props.autoFocus}
      value={value}
      maxLength={TEXT_LIMIT}
      placeholder={props.placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value.trim() !== props.value && props.onSave(value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setValue(props.value)
      }}
    />
  )
}

function Row(props: { item: Template; update: (text: string) => void; remove: () => void }) {
  const sortable = useSortable({ id: props.item.id })
  return (
    <li
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      className={`flex items-center gap-1 bg-background py-1 ${sortable.isDragging ? 'relative z-10 rounded-lg shadow-md' : ''}`}
    >
      <button
        aria-label='拖动排序'
        className='flex size-8 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing'
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical className='size-4' />
      </button>
      <TextField value={props.item.text} onSave={props.update} />
      <Tip content='删除'>
        <Button variant='ghost' size='icon' aria-label='删除' onClick={props.remove}>
          <X />
        </Button>
      </Tip>
    </li>
  )
}

// 编辑模式：一行一条，拖动左侧把手排序
function Editor(props: { items: Template[]; save: (next: Template[]) => void; reset: () => Promise<boolean> }) {
  const { items, save } = props
  const [adding, setAdding] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    save(arrayMove(items, items.findIndex((t) => t.id === active.id), items.findIndex((t) => t.id === over.id)))
  }
  return (
    <div className='max-w-md'>
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[vertical]} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul>
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                update={(text) => save(items.map((t) => (t.id === item.id ? { ...t, text } : t)))}
                remove={() => save(items.filter((t) => t.id !== item.id))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {adding && (
        <div className='flex items-center gap-1 py-1 pl-9'>
          <TextField
            value=''
            autoFocus
            placeholder='新文案'
            onSave={(text) => {
              setAdding(false)
              save([...items, { id: '', text }])
            }}
          />
          <Button variant='ghost' size='icon' aria-label='取消' onClick={() => setAdding(false)}>
            <X />
          </Button>
        </div>
      )}
      <div className='flex items-center justify-between pt-2 pl-9'>
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
          onConfirm={props.reset}
        />
      </div>
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
  function save(next: Template[]) {
    setItems(next)
    void props.saveTemplates(next).then((ok) => !ok && setItems(snapshot.templates))
  }
  async function submit() {
    if (await props.send(props.draft)) props.setDraft('')
  }
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-4'>
      <div className='flex shrink-0 items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-3'>
          <h2 className='font-medium'>{editing ? '编辑文案' : '发送'}</h2>
          {!editing && <ConnectionStatus connection={snapshot.connection} onReconnect={props.reconnect} />}
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
        {editing ? (
          <Editor items={items} save={save} reset={props.resetTemplates} />
        ) : items.length === 0 ? (
          <p className='text-muted-foreground'>暂无文案</p>
        ) : (
          <div className='flex flex-wrap gap-2.5'>
            {items.map((item) => (
              <Button key={item.id} variant='outline' className='h-9 max-w-56 px-3.5' disabled={busy} onClick={() => void props.send(item.text)}>
                <span className='truncate'>{item.text}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
      {!editing && (
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
      )}
    </section>
  )
}
