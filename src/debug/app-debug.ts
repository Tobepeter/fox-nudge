// DEBUG：主窗口业务探针，挂在 __DEBUG__.nudge.app；状态由 App 每次渲染后同步进来
import { mountDebug, type DebugSurface } from './index'
import { api, desktop, events, type InjectMessage, type Snapshot } from '../lib/runtime'

export type AppView = {
  snapshot: Snapshot
  loaded: boolean
  page: string
  draft: string
  editing: boolean
  setPage: (page: string) => void
  setDraft: (value: string) => void
  setEditing: (value: boolean) => void
  send: (body: string) => Promise<boolean>
}

// 一段时间内条件成立就返回，超时报错；给动作“等到目标状态再 resolve”
function until<T>(read: () => T | undefined | false, timeout = 10000, label = '条件') {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = read()
      if (value) return resolve(value)
      if (Date.now() - started > timeout) return reject(new Error(`等待${label}超时`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

export class AppDebug implements DebugSurface {
  #view: AppView | undefined
  sync(view: AppView) {
    this.#view = view
  }
  #need() {
    if (!this.#view) throw new Error('页面还没渲染')
    return this.#view
  }

  ready = () => !!this.#view?.loaded

  snapshot = () => {
    const v = this.#view
    if (!v) return { ready: false }
    const s = v.snapshot
    const last = s.messages.at(-1)
    return {
      ready: v.loaded,
      runtime: desktop ? 'desktop' : 'web',
      page: v.page,
      draft: v.draft,
      editing: v.editing,
      identity: s.identity,
      settings: {
        server: s.settings.server,
        topic: s.settings.topic,
        encrypt: s.settings.encrypt,
        mode: s.settings.mode,
        sound: s.settings.sound,
        notify: s.settings.notify,
        theme: s.settings.theme,
        dockMode: s.settings.dockMode,
      },
      tokenSource: s.tokenSource,
      keySource: s.keySource,
      connection: s.connection,
      templates: s.templates.map((t) => t.text),
      messages: s.messages.length,
      last: last && {
        id: last.id,
        mine: last.mine,
        status: last.status,
        encrypted: last.encrypted,
        sender: last.senderName,
        chars: [...last.body].length,
      },
    }
  }

  actions = {
    navigate: (page: string) => this.#need().setPage(page),
    setDraft: (value: string) => this.#need().setDraft(value),
    edit: (value = true) => this.#need().setEditing(value),
    // 走界面同一条发送路径，等消息出现在列表里再返回
    send: async (body: string) => {
      const v = this.#need()
      const before = v.snapshot.messages.length
      if (!(await v.send(body))) throw new Error('发送失败')
      await until(() => this.#view!.snapshot.messages.length > before, 5000, '消息入列表')
      return this.snapshot()
    },
    // 真实链路：发一条消息，等它经服务器订阅回到本机
    roundtrip: async (body = '探针往返测试') => {
      const started = Date.now()
      // 订阅回来可能比发送响应还快：那时走 message 事件，之后才到的走 echo 事件
      const seen = new Set<string>()
      const stops = await Promise.all([
        events.echo((id) => seen.add(id)),
        events.message((m) => m.mine && seen.add(m.id)),
      ])
      const stop = () => stops.forEach((s) => s())
      try {
        const message = await api.send('', body)
        await until(() => seen.has(message.id), 15000, '回声')
        return { id: message.id, encrypted: message.encrypted, ms: Date.now() - started }
      } finally {
        stop()
      }
    },
    inject: async (message: InjectMessage) => {
      const id = await api.debugInject(message)
      await until(() => this.#view!.snapshot.messages.some((m) => m.id === id), 5000, '注入消息')
      return id
    },
    backlog: async (count = 3) => {
      for (let i = 0; i < count; i++)
        await api.debugInject({ body: `离线消息 ${i + 1}`, senderName: '调试', backlog: true })
    },
    disconnect: async () => {
      await api.debugDisconnect()
      await until(() => this.#view!.snapshot.connection.state !== 'connected', 5000, '断开')
      return this.#view!.snapshot.connection
    },
    reconnect: () => api.reconnect(),
    waitConnected: (timeout = 15000) =>
      until(
        () => this.#view?.snapshot.connection.state === 'connected' && this.#view.snapshot.connection,
        timeout,
        '连接',
      ),
    saveSettings: async (patch: Partial<Snapshot['settings']>) => {
      await api.saveSettings({ ...this.#need().snapshot.settings, ...patch })
    },
  }
}

export const appDebug = new AppDebug()
mountDebug('nudge', 'app', appDebug)
