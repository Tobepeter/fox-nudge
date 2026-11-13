import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Check,
  GripVertical,
  Loader2,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  SendHorizontal,
  Trash2,
} from 'lucide-react'
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
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { AutoTextarea } from './auto-textarea'
import { ConfirmAction } from './confirm-action'
import { ConnectionStatus } from './connection-status'
import { Tip } from './tip'
import { UndoNotice, type PendingUndo } from './undo-notice'
import { recentSent } from '../lib/recent'
import type { Snapshot, Template } from '../lib/runtime'

const LIMIT = 10
const TEXT_LIMIT = 100
const UNDO_MS = 5000
// 通知里的文案太长时截短
const short = (text: string) =>
  [...text].length > 12 ? `${[...text].slice(0, 12).join('')}…` : text
const SENT_MS = 1200
// 只允许上下拖
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 })
// 行内按钮和输入框共用的尺寸与字重，切换编辑时文字位置、大小完全一致
const FIELD = 'h-8 min-w-0 flex-1 px-3 font-normal'

/** 发送反馈：正在发的那条转圈，发完短暂打勾；不禁用其他行，避免整列闪动 */
type Feedback = { id: string; state: 'sending' | 'sent' } | null

// 编辑态输入框：失焦或回车提交，Esc 放弃
function TextField(props: {
  value: string
  onSubmit: (value: string) => void
  onCancel?: () => void
  autoFocus?: boolean
  placeholder?: string
  keepOpen?: boolean
}) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  return (
    <Input
      autoFocus={props.autoFocus}
      value={value}
      maxLength={TEXT_LIMIT}
      placeholder={props.placeholder}
      className={FIELD}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const next = value.trim()
        if (next && next !== props.value) props.onSubmit(next)
        else props.onCancel?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          const next = value.trim()
          if (props.keepOpen) {
            // 连续添加：回车提交后清空，继续输下一条
            if (next) props.onSubmit(next)
            setValue('')
          } else (e.target as HTMLInputElement).blur()
        }
        if (e.key === 'Escape') {
          setValue(props.value)
          props.onCancel?.()
        }
      }}
    />
  )
}

// 一行三段：左侧把手、中间按钮或输入框、右侧固定一格（发送状态或垃圾桶）
function Line(props: {
  handle?: ReactNode
  children: ReactNode
  side?: ReactNode
  dragging?: boolean
}) {
  return (
    <div
      className={`flex items-center gap-1 ${props.dragging ? 'relative z-10' : ''}`}
    >
      <span className='flex size-7 shrink-0 items-center justify-center'>
        {props.handle}
      </span>
      {props.children}
      <span className='flex size-7 shrink-0 items-center justify-center'>
        {props.side}
      </span>
    </div>
  )
}

function Row(props: {
  item: Template
  editing: boolean
  feedback: Feedback
  send: () => void
  update: (text: string) => void
  remove: () => void
}) {
  const sortable = useSortable({ id: props.item.id })
  const status =
    props.feedback?.id === props.item.id ? props.feedback.state : null
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className='group'
    >
      <Line
        dragging={sortable.isDragging}
        handle={
          <button
            aria-label='拖动排序'
            className='flex size-7 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/40 group-hover:text-muted-foreground hover:bg-muted active:cursor-grabbing'
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className='size-4' />
          </button>
        }
        side={
          props.editing ? (
            <Tip content='删除'>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='删除'
                className='text-muted-foreground hover:text-destructive'
                onClick={props.remove}
              >
                <Trash2 />
              </Button>
            </Tip>
          ) : (
            <SendStatus status={status} />
          )
        }
      >
        {props.editing ? (
          <TextField value={props.item.text} onSubmit={props.update} />
        ) : (
          <Button
            variant='outline'
            className={`${FIELD} justify-start ${sortable.isDragging ? 'shadow-md' : ''}`}
            onClick={props.send}
          >
            <span className='truncate'>{props.item.text}</span>
          </Button>
        )}
      </Line>
    </li>
  )
}

// 卡片：标题行放这块内容自己的操作（图标），内容是一列行
function Card(props: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className='rounded-xl border p-1.5'>
      <div className='flex h-7 items-center justify-between pr-0.5 pl-2'>
        <h3 className='text-muted-foreground'>{props.title}</h3>
        <div className='flex items-center'>{props.action}</div>
      </div>
      <div className='space-y-1 pt-1'>{props.children}</div>
    </section>
  )
}

function SendStatus({ status }: { status: 'sending' | 'sent' | null }) {
  if (status === 'sending')
    return (
      <Loader2
        className='size-4 animate-spin text-muted-foreground'
        aria-label='发送中'
      />
    )
  if (status === 'sent')
    return <Check className='size-4 text-success' aria-label='已发送' />
  return null
}

export function Compose(props: {
  snapshot: Snapshot
  draft: string
  setDraft: (value: string) => void
  sending: boolean
  send: (body: string) => Promise<boolean>
  saveTemplates: (templates: Template[]) => Promise<boolean>
  resetTemplates: () => Promise<boolean>
  setRecentCleared: (at: number) => Promise<boolean>
  editing: boolean
  setEditing: (value: boolean) => void
  reconnect: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}) {
  const { snapshot, editing } = props
  // 排序、编辑、添加立即生效；保存排队进行，期间不被快照覆盖，失败时还原成快照
  const [items, setItems] = useState(snapshot.templates)
  const latest = useRef(items)
  latest.current = items
  const saved = useRef(snapshot.templates)
  saved.current = snapshot.templates
  const saving = useRef(false)
  const queued = useRef<Template[] | null>(null)
  useEffect(() => {
    if (!saving.current) setItems(snapshot.templates)
  }, [snapshot.templates])
  const [adding, setAdding] = useState(false)
  const [undo, setUndo] = useState<PendingUndo | null>(null)
  const clearUndo = useCallback(() => setUndo(null), [])
  const [feedback, setFeedback] = useState<Feedback>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(feedbackTimer.current), [])
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  function save(next: Template[]) {
    latest.current = next
    setItems(next)
    if (saving.current) {
      queued.current = next
      return
    }
    saving.current = true
    void (async () => {
      let target: Template[] | null = next
      let ok = true
      while (target) {
        ok = await props.saveTemplates(target)
        target = queued.current
        queued.current = null
      }
      saving.current = false
      if (!ok) setItems(saved.current)
    })()
  }
  // 发送中只在这一行右侧转圈，发完打勾；正在发的时候再点直接忽略
  async function send(id: string, text: string) {
    if (feedback?.state === 'sending') return false
    clearTimeout(feedbackTimer.current)
    setFeedback({ id, state: 'sending' })
    const ok = await props.send(text)
    setFeedback(ok ? { id, state: 'sent' } : null)
    if (ok) feedbackTimer.current = setTimeout(() => setFeedback(null), SENT_MS)
    return ok
  }
  // 删除立即生效，5 秒内可撤销，插回原位置；再删一条会顶掉上一次的撤销
  function remove(item: Template) {
    const index = items.findIndex((t) => t.id === item.id)
    save(items.filter((t) => t.id !== item.id))
    setUndo({
      key: `${item.id}-${Date.now()}`,
      label: `已删除「${short(item.text)}」`,
      expiresAt: Date.now() + UNDO_MS,
      undo: () => {
        const current = latest.current
        if (current.some((t) => t.id === item.id) || current.length >= LIMIT)
          return
        const next = [...current]
        next.splice(Math.min(index, next.length), 0, item)
        save(next)
      },
    })
  }
  function add(text: string) {
    const current = latest.current
    if (current.length >= LIMIT) return
    const next = [...current, { id: crypto.randomUUID(), text }]
    save(next)
    if (next.length >= LIMIT) setAdding(false)
  }
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    save(
      arrayMove(
        items,
        items.findIndex((t) => t.id === active.id),
        items.findIndex((t) => t.id === over.id),
      ),
    )
  }
  async function submit() {
    if (await send('draft', props.draft)) props.setDraft('')
  }
  const draftStatus = feedback?.id === 'draft' ? feedback.state : null
  const recent = recentSent(snapshot, items)
  // 固定：加到文案末尾；已满 10 条时顶掉最后一条。撤销恢复固定前的整份文案快照
  function pin(text: string) {
    const before = latest.current
    const bumped = before.length >= LIMIT ? before[before.length - 1] : null
    const kept = bumped ? before.slice(0, LIMIT - 1) : before
    save([...kept, { id: crypto.randomUUID(), text }])
    setUndo({
      key: `pin-${Date.now()}`,
      label: bumped
        ? `已固定「${short(text)}」，移出「${short(bumped.text)}」`
        : `已固定「${short(text)}」`,
      expiresAt: Date.now() + UNDO_MS,
      undo: () => save(before),
    })
  }
  function clearRecent() {
    const previous = snapshot.recentClearedAt
    void props.setRecentCleared(Math.floor(Date.now() / 1000))
    setUndo({
      key: `recent-${Date.now()}`,
      label: '已清空最近发过',
      expiresAt: Date.now() + UNDO_MS,
      undo: () => void props.setRecentCleared(previous),
    })
  }
  const presetsAction = (
    <>
      {editing && (
        <ConfirmAction
          label='恢复默认'
          description='恢复默认文案？当前文案会被替换'
          success='已恢复默认文案'
          icon={<RotateCcw />}
          ghost
          onConfirm={props.resetTemplates}
        />
      )}
      <Tip content={editing ? '完成' : '编辑文案'}>
        <Button
          variant={editing ? 'secondary' : 'ghost'}
          size='icon-sm'
          aria-label={editing ? '完成' : '编辑文案'}
          aria-pressed={editing}
          disabled={props.disabled || (!editing && items.length === 0)}
          onClick={() => props.setEditing(!editing)}
        >
          {editing ? <Check /> : <Pencil />}
        </Button>
      </Tip>
    </>
  )
  return (
    <section className='flex min-h-0 flex-1 flex-col gap-3'>
      <UndoNotice pending={undo} onExpire={clearUndo} />
      <div className='flex h-7 shrink-0 items-center gap-3'>
        <h2 className='font-medium'>发送</h2>
        <ConnectionStatus
          connection={snapshot.connection}
          onReconnect={props.reconnect}
        />
      </div>
      {/* 内容区够宽时左右两张卡片，窄时上下排；两张卡片在编辑、为空时都保持原位，布局不跳 */}
      <div className='app-scroll @container -mx-4 min-h-0 flex-1 overflow-y-auto px-4'>
        <div className='grid grid-cols-1 items-start gap-3 pb-1 @lg:grid-cols-2'>
          <Card title='文案' action={presetsAction}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[vertical]}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={items.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className='space-y-1'>
                  {items.map((item) => (
                    <Row
                      key={item.id}
                      item={item}
                      editing={editing}
                      feedback={feedback}
                      send={() => void send(item.id, item.text)}
                      update={(text) =>
                        save(
                          items.map((t) =>
                            t.id === item.id ? { ...t, text } : t,
                          ),
                        )
                      }
                      remove={() => remove(item)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            {/* 添加常驻在最后一行，点一下原地变输入框，回车后可以接着输下一条 */}
            {items.length < LIMIT && (
              <Line>
                {adding ? (
                  <TextField
                    value=''
                    autoFocus
                    keepOpen
                    placeholder='输入文案，回车添加'
                    onSubmit={add}
                    onCancel={() => setAdding(false)}
                  />
                ) : (
                  <Button
                    variant='outline'
                    className={`${FIELD} border-dashed bg-transparent text-muted-foreground shadow-none`}
                    aria-label='添加文案'
                    disabled={props.disabled}
                    onClick={() => setAdding(true)}
                  >
                    <Plus />
                  </Button>
                )}
              </Line>
            )}
          </Card>
          {/* 最近发过：自己发过的消息，单击重发，图钉固定为文案；清空只隐藏，不删历史，5 秒内可撤销 */}
          <Card
            title='最近发过'
            action={
              recent.length > 0 && (
                <Tip content='清空'>
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label='清空最近发过'
                    className='text-muted-foreground'
                    onClick={clearRecent}
                  >
                    <Trash2 />
                  </Button>
                </Tip>
              )
            }
          >
            {recent.length === 0 ? (
              <p className='px-2 pb-1.5 text-muted-foreground/70'>
                自定义发过的消息会出现在这里
              </p>
            ) : (
              <ul className='space-y-1'>
                {recent.map((text) => {
                  const id = `recent:${text}`
                  const status = feedback?.id === id ? feedback.state : null
                  return (
                    <li key={id}>
                      <Line
                        side={<SendStatus status={status} />}
                        handle={
                          <Tip content='固定为文案'>
                            <button
                              aria-label='固定为文案'
                              className='flex size-7 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-muted hover:text-foreground'
                              onClick={() => pin(text)}
                            >
                              <Pin className='size-4' />
                            </button>
                          </Tip>
                        }
                      >
                        <Button
                          variant='outline'
                          className={`${FIELD} justify-start bg-transparent text-muted-foreground shadow-none hover:text-foreground`}
                          onClick={() => void send(id, text)}
                        >
                          <span className='truncate'>{text}</span>
                        </Button>
                      </Line>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
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
        <Button
          size='icon'
          className='size-9 shrink-0'
          aria-label='发送'
          disabled={props.disabled || (!props.draft.trim() && !draftStatus)}
          onClick={() => void submit()}
        >
          {draftStatus === 'sending' ? (
            <Loader2 className='animate-spin' />
          ) : draftStatus === 'sent' ? (
            <Check />
          ) : (
            <SendHorizontal />
          )}
        </Button>
      </div>
    </section>
  )
}
