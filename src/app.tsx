import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Bug, History as HistoryIcon, Send, Settings as SettingsIcon } from 'lucide-react'
import { Toaster } from './components/ui/sonner'
import { Button } from './components/ui/button'
import { Compose } from './components/compose'
import { History } from './components/history'
import { Settings } from './components/settings'
import { initial } from './lib/initial'
import { api, available, desktop, events, webPreview, type Settings as SettingsData } from './lib/runtime'

const DebugPage = import.meta.env.DEV
  ? lazy(() => import('./debug/debug-page').then((m) => ({ default: m.DebugPage })))
  : null

const pages = [
  { id: 'send', title: '发送', icon: Send },
  { id: 'history', title: '历史', icon: HistoryIcon },
  ...(DebugPage ? [{ id: 'debug', title: '调试', icon: Bug, className: 'text-amber-600 dark:text-amber-400' }] : []),
]

export function App() {
  const [snapshot, setSnapshot] = useState(initial)
  const [loaded, setLoaded] = useState(false)
  const [page, setPage] = useState('send')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [working, setWorking] = useState(false)
  const [sending, setSending] = useState(false)
  const running = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)

  async function refresh() {
    setSnapshot(await api.snapshot())
  }

  useEffect(() => {
    let disposed = false
    const stops: Promise<() => void>[] = [
      events.snapshot((s) => !disposed && setSnapshot(s)),
      events.connection((connection) => !disposed && setSnapshot((s) => ({ ...s, connection }))),
      events.navigate((p) => !disposed && setPage(p)),
      events.compose(() => {
        setEditing(false)
        setTimeout(() => input.current?.focus(), 50)
      }),
      events.error((text) => toast.error(text, { id: 'backend-error' })),
    ]
    api
      .snapshot()
      .then((s) => {
        if (disposed) return
        setSnapshot(s)
        setLoaded(true)
      })
      .catch((e) => toast.error(String(e), { id: 'connection-error' }))
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setPage('settings')
      }
    }
    // 前端异常经 Rust 统一脱敏写入调试日志
    const onError = (e: ErrorEvent) =>
      void api.logClient('error', 'window-error', { error: e.message, file: e.filename, line: e.lineno }).catch(() => {})
    const onRejection = (e: PromiseRejectionEvent) =>
      void api.logClient('error', 'unhandled-rejection', { error: String(e.reason) }).catch(() => {})
    window.addEventListener('keydown', key)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      disposed = true
      stops.forEach((s) => void s.then((stop) => stop()))
      window.removeEventListener('keydown', key)
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () =>
      document.documentElement.classList.toggle(
        'dark',
        snapshot.settings.theme === 'dark' || (snapshot.settings.theme === 'system' && media.matches),
      )
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [snapshot.settings.theme])

  async function run(work: () => Promise<unknown>) {
    if (running.current) return false
    running.current = true
    setWorking(true)
    try {
      await work()
      await refresh()
      return true
    } catch (e) {
      toast.error(String(e), { id: 'action-error' })
      return false
    } finally {
      running.current = false
      setWorking(false)
    }
  }

  function save(settings: SettingsData) {
    return run(() => api.saveSettings(settings))
  }

  async function send(body: string) {
    if (!body.trim() || sending) return false
    setSending(true)
    try {
      await api.send('', body)
      await refresh()
      toast.success('已发送', { id: 'sent', duration: 1500 })
      return true
    } catch (e) {
      toast.error(String(e), { id: 'send-error' })
      return false
    } finally {
      setSending(false)
    }
  }

  // DEV：把当前界面状态同步给 __DEBUG__.nudge.app 探针
  useEffect(() => {
    if (!import.meta.env.DEV) return
    void import('./debug/app-debug').then(({ appDebug }) =>
      appDebug.sync({ snapshot, loaded, page, draft, editing, setPage, setDraft, setEditing, send }),
    )
  })

  return (
    <div className='flex h-screen overflow-hidden'>
      <Toaster
        position='top-right'
        theme={snapshot.settings.theme === 'dark' ? 'dark' : snapshot.settings.theme === 'light' ? 'light' : 'system'}
        offset={{ top: desktop ? 52 : 16, right: 16 }}
      />
      <aside className='flex w-44 shrink-0 flex-col border-r bg-sidebar px-3 pb-3'>
        {/* 红绿灯所在的一行：留空可拖动，内容从下一行开始 */}
        {desktop && <div data-tauri-drag-region className='-mx-3 mb-3 h-11 shrink-0 select-none' />}
        <div className={`mb-4 flex items-center gap-2 px-2 font-semibold ${desktop ? '' : 'pt-3'}`}>
          <img src='/app-icon.png' alt='' className='size-6 rounded-md' />
          FoxNudge
        </div>
        <nav className='space-y-1'>
          {pages.map((item) => (
            <Button
              key={item.id}
              className={`w-full justify-start ${'className' in item ? item.className : ''}`}
              variant={page === item.id ? 'secondary' : 'ghost'}
              onClick={() => setPage(item.id)}
            >
              <item.icon />
              {item.title}
            </Button>
          ))}
        </nav>
        <div className='mt-auto space-y-2'>
          {!desktop && (
            <span className='block px-2 text-amber-600 dark:text-amber-400'>
              {webPreview ? 'Web 模拟' : '浏览器只读预览'}
            </span>
          )}
          <Button
            className='w-full justify-start'
            variant={page === 'settings' ? 'secondary' : 'ghost'}
            onClick={() => setPage('settings')}
          >
            <SettingsIcon />
            设置
          </Button>
        </div>
      </aside>
      <div className='flex min-w-0 flex-1 flex-col'>
        {desktop && <div data-tauri-drag-region className='h-11 shrink-0 select-none' />}
        <main
          className={`min-h-0 flex-1 p-4 ${desktop ? 'pt-0' : ''} ${
            page === 'settings' || page === 'debug' ? 'app-scroll overflow-auto [scrollbar-gutter:stable]' : 'flex flex-col overflow-hidden'
          }`}
        >
          {page === 'send' && (
            <Compose
              snapshot={snapshot}
              draft={draft}
              setDraft={setDraft}
              sending={sending}
              send={send}
              saveTemplates={(templates) => run(() => api.saveTemplates(templates))}
              resetTemplates={() => run(api.resetTemplates)}
              editing={editing}
              setEditing={setEditing}
              reconnect={() => void run(api.reconnect)}
              inputRef={input}
              disabled={!available || working}
            />
          )}
          {page === 'history' && (
            <History messages={snapshot.messages} clear={() => run(api.clearHistory)} disabled={!available || working} />
          )}
          {page === 'settings' && (
            <Settings snapshot={snapshot} disabled={!available || working} save={save} run={run} />
          )}
          {page === 'debug' && DebugPage && (
            <Suspense fallback={null}>
              <DebugPage snapshot={snapshot} />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  )
}
