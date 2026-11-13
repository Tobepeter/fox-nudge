import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { initial } from './initial'
import type { Snapshot } from './bindings/Snapshot'
import type { Settings } from './bindings/Settings'
import type { Template } from './bindings/Template'
import type { Message } from './bindings/Message'
import type { Connection } from './bindings/Connection'
import type { Identity } from './bindings/Identity'
export type { Snapshot, Settings, Template, Message, Connection, Identity }

export const desktop = isTauri()
// 浏览器 DEV 走模拟运行时，正式构建的浏览器页面只读
export const webPreview = import.meta.env.DEV && !desktop
export const available = desktop || webPreview

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

// DEV 动态入口在生产构建中整体剔除
let previewRuntime: Promise<import('../debug/web/runtime').WebRuntime> | undefined
async function preview() {
  if (import.meta.env.DEV && !desktop) {
    return (previewRuntime ??= import('../debug/web/runtime').then(
      (module) => new module.WebRuntime(initial),
    ))
  }
  throw new Error('此功能需要桌面端')
}

async function call<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (desktop) return invoke<T>(command, args)
  if (import.meta.env.DEV) return (await preview()).command(command, args) as Promise<T>
  throw new Error('此功能需要桌面端')
}

async function on<T>(name: string, callback: (value: T) => void): Promise<() => void> {
  if (desktop) return listen<T>(name, (event) => callback(event.payload))
  if (import.meta.env.DEV) return (await preview()).on(name, (value) => callback(value as T))
  return () => {}
}

export const api = {
  snapshot: () => call<Snapshot>('get_snapshot'),
  saveSettings: (settings: Settings) => call('save_settings', { settings }),
  saveIdentity: (name: string) => call('save_identity', { name }),
  saveTemplates: (templates: Template[]) => call('save_templates', { templates }),
  resetTemplates: () => call('reset_templates'),
  resetSettings: () => call('reset_settings'),
  setSecret: (kind: 'token' | 'key', value: string) => call('set_secret', { kind, value }),
  generateKey: () => call<string>('generate_key'),
  send: (title: string, body: string) => call<Message>('send', { title, body }),
  reconnect: () => call('reconnect'),
  clearHistory: () => call('clear_history'),
  setRecentCleared: (at: number) => call('set_recent_cleared', { at }),
  wipeData: () => call('wipe_data'),
  openLogs: () => call('open_logs'),
  testSound: (sound: string) => call('test_sound', { sound }),
  testNotification: () => call('test_notification'),
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
