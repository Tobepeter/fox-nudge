import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { initial } from './initial'
import type { Snapshot } from './bindings/Snapshot'
import type { Settings } from './bindings/Settings'
import type { Template } from './bindings/Template'
import type { Message } from './bindings/Message'
import type { Connection } from './bindings/Connection'
import type { Identity } from './bindings/Identity'
import type { Peer } from './bindings/Peer'
export type { Snapshot, Settings, Template, Message, Connection, Identity, Peer }

export const desktop = isTauri()
// 浏览器 DEV 走模拟运行时，正式构建的浏览器页面只读
export const webPreview = import.meta.env.DEV && !desktop
export const available = desktop || webPreview

/** unsupported：开发版没有应用包，查不了 */
export type NotificationStatus = 'unsupported' | 'notDetermined' | 'denied' | 'authorized'

/** installed：装的是 FoxNudge 的脚本；foreign：同名文件不是我们装的；none：没装 */
export type CliStatus = { state: 'installed' | 'foreign' | 'none'; path: string; target: string }

export type AvatarRequest = { key: string; id: string | null; name: string | null; avatar: string | null }

export type InjectMessage = {
  title?: string
  body: string
  senderName?: string
  encrypted?: boolean
  backlog?: boolean
  wrongKey?: boolean
  avatar?: string
  senderId?: string
}

/** DEV：调试页里的 Mock 模式开关，存在 localStorage（只对这个窗口，不进 data.json），打开后各页面右下角出现本页的状态浮窗 */
export const MOCK_BAR_KEY = 'fox-nudge:mock'

// DEV：Mock 浮窗选了某个状态后，命令和事件改走内存里的模拟运行时（从当前真实快照复制一份再改），
// 不碰真实数据和服务器；选「原样」切回真实数据。浏览器 DEV 一直走模拟运行时
// 开关和模拟运行时挂在 window 上整页共用，热更新多出一份本模块时，界面听的和浮窗改的仍是同一份（FoxSync 踩过）
type DevShared = {
  overlay: boolean
  preview?: Promise<import('../debug/web/runtime').WebRuntime>
}
const dev = globalThis as { __foxNudgeDev?: DevShared }
const shared: DevShared = import.meta.env.DEV ? (dev.__foxNudgeDev ??= { overlay: false }) : { overlay: false }
const mocked = () => webPreview || shared.overlay
export const mockActive = () => import.meta.env.DEV && shared.overlay

// 通知头像、前端日志是给真实应用的，模拟时也照常走桌面端
const REAL_ONLY = new Set(['avatar_ready', 'log_client'])
// 模拟时只拦下这些状态事件；菜单栏跳页、聚焦输入框、头像请求照常从桌面端来
const STATE_EVENTS = new Set(['snapshot', 'connection', 'message', 'echo'])

// DEV 动态入口在生产构建中整体剔除
async function preview() {
  if (import.meta.env.DEV) {
    return (shared.preview ??= import('../debug/web/runtime').then((module) => new module.WebRuntime(initial)))
  }
  throw new Error('此功能需要桌面端')
}

async function call<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (desktop && (!mocked() || REAL_ONLY.has(command))) return invoke<T>(command, args)
  if (import.meta.env.DEV) return (await preview()).command(command, args) as Promise<T>
  throw new Error('此功能需要桌面端')
}

async function on<T>(name: string, callback: (value: T) => void): Promise<() => void> {
  if (!import.meta.env.DEV) return desktop ? listen<T>(name, (event) => callback(event.payload)) : () => {}
  if (!desktop) return (await preview()).on(name, (value) => callback(value as T))
  const gated = STATE_EVENTS.has(name)
  if (!gated) return listen<T>(name, (event) => callback(event.payload))
  // 开发版两边都听，按当前是否在 Mock 里只放行一边
  const stops = [
    (await preview()).on(name, (value) => mocked() && callback(value as T)),
    await listen<T>(name, (event) => !mocked() && callback(event.payload)),
  ]
  return () => stops.forEach((stop) => stop())
}

export const api = {
  snapshot: () => call<Snapshot>('get_snapshot'),
  saveSettings: (settings: Settings) => call('save_settings', { settings }),
  saveIdentity: (name: string) => call('save_identity', { name }),
  finishWelcome: () => call('finish_welcome'),
  saveTemplates: (templates: Template[]) => call('save_templates', { templates }),
  resetTemplates: () => call('reset_templates'),
  resetSettings: () => call('reset_settings'),
  setSecret: (kind: 'token' | 'key', value: string) => call('set_secret', { kind, value }),
  generateKey: () => call<string>('generate_key'),
  // toSelf：只发给自己，本机记录并提醒，不经过服务器
  send: (title: string, body: string, toSelf = false) => call<Message>('send', { title, body, toSelf }),
  reconnect: () => call('reconnect'),
  clearHistory: () => call('clear_history'),
  setRecentCleared: (at: number) => call('set_recent_cleared', { at }),
  setRecentHidden: (text: string, at: number) => call('set_recent_hidden', { text, at }),
  pauseAlerts: (preset: '30m' | '1h' | 'morning') => call<number>('pause_alerts', { preset }),
  resumeAlerts: () => call('resume_alerts'),
  cliStatus: () => call<CliStatus>('cli_status'),
  installCli: () => call<CliStatus>('install_cli'),
  uninstallCli: () => call<CliStatus>('uninstall_cli'),
  wipeData: () => call('wipe_data'),
  openLogs: () => call('open_logs'),
  testSound: (sound: string) => call('test_sound', { sound }),
  testNotification: () => call('test_notification'),
  previewNotification: () => call('preview_notification'),
  notificationStatus: () => call<NotificationStatus>('notification_status'),
  requestNotifications: () => call<NotificationStatus>('request_notifications'),
  openNotificationSettings: () => call('open_notification_settings'),
  avatarReady: (key: string, png: string) => call('avatar_ready', { key, png }),
  logClient: (level: 'warn' | 'error', event: string, detail: unknown) =>
    call('log_client', { level, event, detail }),
  // 以下只在开发版注册，生产构建里整段剔除
  debugInject: (message: InjectMessage) =>
    import.meta.env.DEV ? call<string>('debug_inject', { message }) : Promise.reject(new Error('仅开发版可用')),
  debugDisconnect: () =>
    import.meta.env.DEV ? call('debug_disconnect') : Promise.reject(new Error('仅开发版可用')),
  debugClearMock: () =>
    import.meta.env.DEV ? call<number>('debug_clear_mock') : Promise.reject(new Error('仅开发版可用')),
  /** DEV：把某个页面切到某个模拟状态；第一次切时先把当前真实快照复制进模拟运行时 */
  debugMock: async (target: string, state: string) => {
    if (!import.meta.env.DEV) throw new Error('仅开发版可用')
    const rt = await preview()
    if (!shared.overlay) {
      if (desktop) rt.seed(await invoke<Snapshot>('get_snapshot'))
      shared.overlay = true
    }
    await rt.command('debug_mock', { target, state })
  },
  /** DEV：回到原本的界面：桌面切回真实数据，浏览器回到切状态之前 */
  debugRestore: async () => {
    if (!import.meta.env.DEV) throw new Error('仅开发版可用')
    shared.overlay = false
    if (webPreview) await (await preview()).command('debug_reset')
  },
}

export const events = {
  snapshot: (cb: (s: Snapshot) => void) => on('snapshot', cb),
  connection: (cb: (c: Connection) => void) => on('connection', cb),
  message: (cb: (m: Message) => void) => on('message', cb),
  echo: (cb: (id: string) => void) => on('echo', cb),
  navigate: (cb: (page: string) => void) => on('navigate', cb),
  compose: (cb: () => void) => on('compose', cb),
  error: (cb: (text: string) => void) => on('error', cb),
  // Rust 弹通知前请前端把发送者头像画成 PNG
  avatarRequest: (cb: (request: AvatarRequest) => void) => on('avatar-request', cb),
}

// DEV：运行时模块（含模拟运行时）热更新时整页刷新，只替换模块会留下两份实例，切状态看不到变化（FoxSync 踩过）
if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const touched = updates.some((u) => /\/src\/(lib|debug\/web)\/runtime\.ts/.test(`${u.path} ${u.acceptedPath}`))
    if (touched) location.reload()
  })
}
