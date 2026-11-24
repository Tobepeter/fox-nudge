import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Bug,
  History as HistoryIcon,
  Send,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react'
import { Toaster } from './components/ui/sonner'
import { Button } from './components/ui/button'
import { Compose } from './components/compose'
import { History } from './components/history'
import { renderAvatarPng } from './components/avatar'
import { NotifyGuide } from './components/notify-guide'
import { PauseControl } from './components/pause-control'
import { Peers } from './components/peers'
import { Settings } from './components/settings'
import { initial } from './lib/initial'
import {
  api,
  available,
  desktop,
  events,
  MOCK_BAR_KEY,
  webPreview,
  type NotificationStatus,
  type Settings as SettingsData,
} from './lib/runtime'

const DebugPage = import.meta.env.DEV
  ? lazy(() =>
      import('./debug/debug-page').then((m) => ({ default: m.DebugPage })),
    )
  : null
const MockBar = import.meta.env.DEV
  ? lazy(() => import('./debug/mock-bar').then((m) => ({ default: m.MockBar })))
  : null
// 有 Mock 状态可切的页面
const MOCK_PAGES = ['send', 'history', 'peers', 'settings']

function readMockBar() {
  try {
    return import.meta.env.DEV && localStorage.getItem(MOCK_BAR_KEY) === '1'
  } catch {
    return false
  }
}

const pages = [
  { id: 'send', title: '发送', icon: Send },
  { id: 'history', title: '历史', icon: HistoryIcon },
  { id: 'peers', title: '在线', icon: Users },
]

/** DEBUG：调试页打开引导弹窗的参数 */
export type DebugGuide = {
  mode: 'welcome' | 'notify'
  status?: NotificationStatus
}

export function App() {
  const [snapshot, setSnapshot] = useState(initial)
  const [loaded, setLoaded] = useState(false)
  const [page, setPage] = useState('send')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [working, setWorking] = useState(false)
  const [sending, setSending] = useState(false)
  const [permission, setPermission] =
    useState<NotificationStatus>('unsupported')
  // 引导弹窗：welcome 带昵称和头像（首次启动、清除数据后），notify 只说通知权限
  const [guide, setGuide] = useState<'welcome' | 'notify'>()
  const guided = useRef(false)
  // DEBUG：调试页模拟的通知权限，只给这次弹窗用，不改真实的权限状态
  const [fakeStatus, setFakeStatus] = useState<NotificationStatus>()
  // DEV：调试页里的 Mock 模式开关，打开后各页面右下角出现本页的状态浮窗
  const [mockBar, setMockBarState] = useState(readMockBar)
  const setMockBar = (on: boolean) => {
    setMockBarState(on)
    try {
      if (on) localStorage.setItem(MOCK_BAR_KEY, '1')
      else localStorage.removeItem(MOCK_BAR_KEY)
    } catch {}
  }
  const running = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)

  async function refresh() {
    setSnapshot(await api.snapshot())
  }

  useEffect(() => {
    let disposed = false
    const stops: Promise<() => void>[] = [
      events.snapshot((s) => !disposed && setSnapshot(s)),
      events.connection(
        (connection) => !disposed && setSnapshot((s) => ({ ...s, connection })),
      ),
      events.navigate((p) => !disposed && setPage(p)),
      events.compose(() => {
        setEditing(false)
        setTimeout(() => input.current?.focus(), 50)
      }),
      events.error((text) => toast.error(text, { id: 'backend-error' })),
      // 通知右侧的发送者头像由前端画好交给 Rust，窗口隐藏时也能响应
      events.avatarRequest(
        (request) =>
          void renderAvatarPng(request)
            .then((png) => api.avatarReady(request.key, png))
            .catch((e) =>
              api
                .logClient('warn', 'avatar-render-failed', { error: String(e) })
                .catch(() => {}),
            ),
      ),
    ]
    api
      .snapshot()
      .then(async (s) => {
        if (disposed) return
        setSnapshot(s)
        setLoaded(true)
        const status = await api
          .notificationStatus()
          .catch(() => 'unsupported' as const)
        setPermission(status)
        // 看过欢迎页、应用里开着通知、系统还没允许时，只引导通知一次；没看过的由下面的欢迎页一起说明
        if (guided.current) return
        guided.current = true
        if (
          s.welcomed &&
          s.settings.notify &&
          (status === 'notDetermined' || status === 'denied')
        )
          setGuide('notify')
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
      void api
        .logClient('error', 'window-error', {
          error: e.message,
          file: e.filename,
          line: e.lineno,
        })
        .catch(() => {})
    const onRejection = (e: PromiseRejectionEvent) =>
      void api
        .logClient('error', 'unhandled-rejection', { error: String(e.reason) })
        .catch(() => {})
    // 从系统设置改完权限回来时刷新状态
    const refreshPermission = () =>
      void api
        .notificationStatus()
        .then(setPermission)
        .catch(() => {})
    window.addEventListener('focus', refreshPermission)
    stops.push(
      Promise.resolve(() =>
        window.removeEventListener('focus', refreshPermission),
      ),
    )
    // DEBUG：调试页打开引导，可带模拟的通知权限（dev 查不了真实权限）
    const showGuide = (e: Event) => {
      const { mode, status } = (e as CustomEvent<DebugGuide>).detail
      setGuide(undefined)
      setFakeStatus(status)
      setTimeout(() => setGuide(mode))
    }
    if (import.meta.env.DEV) {
      window.addEventListener('fox-nudge:guide', showGuide)
      stops.push(
        Promise.resolve(() =>
          window.removeEventListener('fox-nudge:guide', showGuide),
        ),
      )
    }
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
        snapshot.settings.theme === 'dark' ||
          (snapshot.settings.theme === 'system' && media.matches),
      )
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [snapshot.settings.theme])

  async function run(work: () => Promise<unknown>) {
    if (running.current) return false
    running.current = true
    // 超过 300ms 才把控件置为忙碌，短操作不会让整页闪一下
    const busy = setTimeout(() => setWorking(true), 300)
    try {
      await work()
      await refresh()
      return true
    } catch (e) {
      toast.error(String(e), { id: 'action-error' })
      return false
    } finally {
      clearTimeout(busy)
      running.current = false
      setWorking(false)
    }
  }

  // 首次启动、清除数据后（welcomed 变回 false）弹欢迎页
  useEffect(() => {
    if (loaded && !snapshot.welcomed) setGuide('welcome')
  }, [loaded, snapshot.welcomed])

  function save(settings: SettingsData) {
    return run(() => api.saveSettings(settings))
  }

  // 仅自己：只在这次运行里有效，重启回到广播，免得忘了关、别人一直收不到
  const [toSelf, setToSelf] = useState(false)

  async function send(body: string) {
    if (!body.trim() || sending) return false
    setSending(true)
    try {
      await api.send('', body, toSelf)
      await refresh()
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
      appDebug.sync({
        snapshot,
        loaded,
        page,
        draft,
        editing,
        setPage,
        setDraft,
        setEditing,
        send,
      }),
    )
  })

  return (
    <div className='flex h-screen overflow-hidden'>
      {MockBar && mockBar && MOCK_PAGES.includes(page) && (
        <Suspense fallback={null}>
          <MockBar target={page} restored={refresh} />
        </Suspense>
      )}
      <Toaster
        position='top-right'
        theme={
          snapshot.settings.theme === 'dark'
            ? 'dark'
            : snapshot.settings.theme === 'light'
              ? 'light'
              : 'system'
        }
        offset={{ top: desktop ? 52 : 16, right: 16 }}
      />
      <aside className='flex w-44 shrink-0 flex-col border-r bg-sidebar px-3 pb-3'>
        {/* 红绿灯所在的一行：留空可拖动，内容从下一行开始 */}
        {desktop && (
          <div
            data-tauri-drag-region
            className='-mx-3 mb-3 h-11 shrink-0 select-none'
          />
        )}
        <div
          className={`group/title mb-4 flex items-center gap-2 px-2 font-semibold ${desktop ? '' : 'pt-3'}`}
        >
          <img src='/app-icon.png' alt='' className='size-6 rounded-md' />
          FoxNudge
          <PauseControl
            until={snapshot.pausedUntil}
            onPause={(preset) => void run(() => api.pauseAlerts(preset))}
            onResume={() => void run(api.resumeAlerts)}
          />
        </div>
        <nav className='space-y-1'>
          {pages.map((item) => (
            <Button
              key={item.id}
              className='w-full justify-start'
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
          {DebugPage && (
            <Button
              className='w-full justify-start text-amber-600 dark:text-amber-400'
              variant={page === 'debug' ? 'secondary' : 'ghost'}
              onClick={() => setPage('debug')}
            >
              <Bug />
              调试
            </Button>
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
        {desktop && (
          <div data-tauri-drag-region className='h-11 shrink-0 select-none' />
        )}
        <main
          className={`min-h-0 flex-1 p-4 ${desktop ? 'pt-0' : ''} ${
            page === 'settings'
              ? 'app-scroll overflow-auto [scrollbar-gutter:stable]'
              : 'flex flex-col overflow-hidden'
          }`}
        >
          {page === 'send' && (
            <Compose
              snapshot={snapshot}
              draft={draft}
              setDraft={setDraft}
              sending={sending}
              send={send}
              toSelf={toSelf}
              setToSelf={setToSelf}
              saveTemplates={(templates) =>
                run(() => api.saveTemplates(templates))
              }
              resetTemplates={() => run(api.resetTemplates)}
              setRecentCleared={(at) => run(() => api.setRecentCleared(at))}
              setRecentHidden={(text, at) =>
                run(() => api.setRecentHidden(text, at))
              }
              editing={editing}
              setEditing={setEditing}
              reconnect={() => void run(api.reconnect)}
              inputRef={input}
              disabled={!available || working}
            />
          )}
          {page === 'history' && (
            <History
              messages={snapshot.messages}
              identity={snapshot.identity}
              avatarStyle={snapshot.settings.avatarStyle}
              clear={() => run(api.clearHistory)}
              disabled={!available || working}
            />
          )}
          {page === 'peers' && (
            <Peers
              peers={snapshot.peers}
              identity={snapshot.identity}
              avatarStyle={snapshot.settings.avatarStyle}
              paused={snapshot.pausedUntil > 0}
              connected={snapshot.connection.state === 'connected'}
            />
          )}
          {page === 'settings' && (
            <Settings
              snapshot={snapshot}
              permission={permission}
              setPermission={setPermission}
              disabled={!available || working}
              save={save}
              run={run}
            />
          )}
          {page === 'debug' && DebugPage && (
            <Suspense fallback={null}>
              <DebugPage
                snapshot={snapshot}
                mockBar={mockBar}
                setMockBar={setMockBar}
              />
            </Suspense>
          )}
        </main>
      </div>
      {guide && (
        <NotifyGuide
          snapshot={snapshot}
          status={fakeStatus ?? permission}
          welcome={guide === 'welcome'}
          onAvatar={(avatarStyle) =>
            void save({ ...snapshot.settings, avatarStyle })
          }
          onDone={(status) => {
            if (!fakeStatus) setPermission(status)
            setFakeStatus(undefined)
            setGuide(undefined)
          }}
        />
      )}
    </div>
  )
}
