// DEBUG：浏览器 DEV 的模拟运行时，命令名和返回结构与 Rust 一致，数据只在内存里
// 不依赖 import.meta，供 node --test 直接测试
import type { Snapshot } from '../../lib/bindings/Snapshot'
import type { Settings } from '../../lib/bindings/Settings'
import type { Template } from '../../lib/bindings/Template'
import type { Message } from '../../lib/bindings/Message'
import type { Connection } from '../../lib/bindings/Connection'
import type { Peer } from '../../lib/bindings/Peer'
import { ANONYMOUS, cleanName } from '../../lib/avatar-text.ts'
import { AVATAR_STYLES, HUMAN_STYLES } from '../../lib/avatar-styles.ts'

type Listener = (value: unknown) => void
export type Effect =
  | { kind: 'notification'; title: string; body: string }
  | { kind: 'sound'; sound: string }
  | { kind: 'log'; level: string; event: string }
  | { kind: 'open-logs' }

const PRESETS: readonly string[] = AVATAR_STYLES
const randomStyle = () => HUMAN_STYLES[Math.floor(Math.random() * HUMAN_STYLES.length)]
// 模拟构建时内置的地址和主题，界面只显示「已内置」
const BUILTIN = { server: 'https://ntfy.example', topic: 'demo' }

// 与 Rust throttle.rs 一致：连发 3 条后冷却 2、4、8、16 秒，最长 30 秒，每安静 20 秒降一档
export function cooldown(level: number) {
  return level <= 3 ? 0 : Math.min(2000 * 2 ** Math.min(level - 4, 8), 30000)
}

const SOUNDS = ['Glass', 'Ping', 'Pop', 'Purr', 'Submarine', 'Hero', 'Funk', 'none']
const BODY_LIMIT = 500

function randomId(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => (b % 16).toString(16)).join('')
}

function defaultTemplates(): Template[] {
  return ['ding', 'hi', '叮', '来一下', '吃饭啦', '收到'].map((text) => ({ id: randomId(16), text }))
}

/** Mock 浮窗里每个页面能切的状态，空串（原样）由浮窗自己加 */
export const MOCK_STATES: Record<string, { id: string; label: string }[]> = {
  send: [
    { id: 'connecting', label: '连接中' },
    { id: 'waiting', label: '断线' },
    { id: 'unconfigured', label: '未配置' },
    { id: 'paused', label: '暂停中' },
    { id: 'no-templates', label: '没有文案' },
    { id: 'no-recent', label: '没发过' },
    { id: 'many', label: '很多' },
  ],
  history: [
    { id: 'empty', label: '空' },
    { id: 'many', label: '很多' },
    { id: 'undecryptable', label: '有解不开的' },
  ],
  peers: [
    { id: 'alone', label: '只有本机' },
    { id: 'some', label: '几台在线' },
    { id: 'paused', label: '有人暂停' },
    { id: 'offline', label: '都离线' },
    { id: 'me-offline', label: '本机断线' },
    { id: 'crowd', label: '很多设备' },
  ],
  settings: [
    { id: 'no-secrets', label: '没有令牌和密钥' },
    { id: 'custom', label: '全部自定义' },
    { id: 'unconfigured', label: '未配置' },
  ],
}

const NAMES = ['小明', '阿狸', 'eating', 'm5', '一个名字特别特别长的同事', 'Lucy', '老王', 'k', '小红', 'design-mac', '测试机', '大白']
const peer = (name: string, extra: Partial<Peer> = {}): Peer => ({
  id: `debug-${name}`,
  name,
  avatar: '',
  online: true,
  paused: false,
  lastSeen: Math.floor(Date.now() / 1000),
  ...extra,
})

export type WebRuntimeOptions = { connectMs?: number; retryMs?: number }

export class WebRuntime {
  state: Snapshot
  effects: Effect[] = []
  permission: 'notDetermined' | 'denied' | 'authorized' = 'notDetermined'
  #listeners = new Map<string, Set<Listener>>()
  #timers = new Set<ReturnType<typeof setTimeout>>()
  #cli = false
  #initial: Snapshot
  #connectMs: number
  #retryMs: number
  /** Mock 切状态前的样子：桌面端是复制进来的真实快照，浏览器里是第一次切之前的状态 */
  #original?: Snapshot

  constructor(initial: Snapshot, options: WebRuntimeOptions = {}) {
    this.#initial = initial
    this.#connectMs = options.connectMs ?? 600
    this.#retryMs = options.retryMs ?? 2000
    this.state = this.#fresh()
    this.#connect()
  }

  #fresh(): Snapshot {
    const base = structuredClone(this.#initial)
    return {
      ...base,
      settings: { ...base.settings, avatarStyle: randomStyle() },
      // 模拟的系统账户名
      identity: { id: randomId(12), name: 'web' },
      defaultName: 'web',
      welcomed: false,
      templates: defaultTemplates(),
      messages: [],
      serverSource: 'builtin',
      topicSource: 'builtin',
      tokenSource: 'builtin',
      // 模拟内置了默认密钥，开箱即可加密发送
      keySource: 'builtin',
      version: `${base.version || '0.1.0'}-web`,
      dev: true,
    }
  }

  /** 把真实快照复制进来，之后的模拟都在复制品上改；停掉自己模拟的连接，免得盖掉复制进来的状态 */
  seed(snapshot: Snapshot) {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#original = structuredClone(snapshot)
    this.#restore()
  }

  #restore() {
    if (this.#original) this.state = structuredClone(this.#original)
    this.#changed()
    this.#emit('connection', this.state.connection)
  }

  /** 某个页面切到某个状态：先回到切之前的样子，再改出这个状态 */
  #mock(target: string, state: string) {
    this.#original ??= structuredClone(this.state)
    this.state = structuredClone(this.#original)
    const s = this.state
    const now = Math.floor(Date.now() / 1000)
    const connection = (next: Partial<Connection>) => (s.connection = { ...s.connection, ...next })
    const offline = () =>
      connection({ state: 'waiting', connectedAt: null, attempts: 3, error: '连不上服务器', retryAt: Date.now() + 30_000 })
    const unconfigured = () => {
      connection({ state: 'unconfigured', connectedAt: null, error: '', retryAt: null })
      s.settings = { ...s.settings, server: '', topic: '' }
      s.serverSource = 'none'
      s.topicSource = 'none'
    }
    const message = (i: number, extra: Partial<Message>): Message => ({
      id: `debug-mock-${i}`,
      time: now - i * 3600 * 5,
      title: '',
      body: '',
      senderId: null,
      senderName: null,
      senderAvatar: null,
      mine: false,
      encrypted: true,
      status: 'ok',
      toSelf: false,
      ...extra,
    })
    const mine = (i: number, body: string) =>
      message(i, { body, mine: true, senderId: s.identity.id, senderName: s.identity.name, senderAvatar: s.settings.avatarStyle })
    const from = (i: number, name: string, body: string) => message(i, { body, senderId: `debug-${name}`, senderName: name })
    switch (`${target}:${state}`) {
      case 'send:connecting':
        connection({ state: 'connecting', connectedAt: null, error: '', retryAt: null })
        break
      case 'send:waiting':
        offline()
        break
      case 'send:unconfigured':
      case 'settings:unconfigured':
        unconfigured()
        break
      case 'send:paused':
        s.pausedUntil = now + 3600
        break
      case 'send:no-templates':
        s.templates = []
        break
      case 'send:no-recent':
        s.messages = s.messages.filter((m) => !m.mine)
        break
      case 'send:many':
        s.templates = ['ding', 'hi', '叮', '来一下', '吃饭啦', '收到', '下楼拿外卖', '我先走了，明天见', '会议室见，带上电脑和充电器', '好'].map(
          (text, i) => ({ id: `debug-${i}`, text }),
        )
        s.recentClearedAt = 0
        s.recentHidden = {}
        s.messages = ['等我五分钟', '已经发你了，看一下', '这一条特别长，用来看最近发过里文字太长时怎么截断，后面还有很多很多字', '在吗', '好的', '晚点再说', '收到', '到了']
          .map((body, i) => mine(i + 1, body))
          .reverse()
        break
      case 'history:empty':
        s.messages = []
        break
      case 'history:many':
        s.messages = Array.from({ length: 40 }, (_, i) =>
          i % 3 === 0
            ? mine(i, i % 2 ? '来一下' : '这一条特别长，用来看历史里文字太长时怎么截断，后面还有很多很多很多很多字')
            : i % 7 === 0
              ? message(i, { body: 'Agent 跑完了', mine: true, toSelf: true, senderId: s.identity.id, senderName: s.identity.name })
              : from(i, NAMES[i % 5], ['在吗', '吃饭啦', '收到', '下楼拿外卖'][i % 4]),
        ).reverse()
        break
      case 'history:undecryptable':
        s.messages = [
          ...s.messages,
          message(2, { status: 'undecryptable' }),
          message(1, { status: 'undecryptable' }),
          message(0, { body: 'curl 发的明文', encrypted: false }),
        ].sort((a, b) => a.time - b.time)
        break
      case 'peers:alone':
        s.peers = []
        break
      case 'peers:some':
        s.peers = [peer('小明'), peer('eating'), peer('m5', { online: false, lastSeen: now - 25 * 60 })]
        break
      case 'peers:paused':
        s.pausedUntil = now + 3600
        s.peers = [peer('小明', { paused: true }), peer('eating')]
        break
      case 'peers:offline':
        s.peers = [peer('eating', { online: false, lastSeen: now - 3 * 60 }), peer('m5', { online: false, lastSeen: now - 5 * 3600 }), peer('小明', { online: false, lastSeen: now - 2 * 86400 })]
        break
      case 'peers:me-offline':
        offline()
        s.peers = [peer('eating', { online: false, lastSeen: now - 4 * 60 })]
        break
      case 'peers:crowd':
        s.peers = NAMES.map((name, i) => peer(name, i % 4 === 3 ? { online: false, lastSeen: now - i * 600 } : { paused: i % 5 === 1 })).sort(
          (a, b) => Number(b.online) - Number(a.online),
        )
        break
      case 'settings:no-secrets':
        s.tokenSource = 'none'
        s.keySource = 'none'
        break
      case 'settings:custom':
        s.settings = { ...s.settings, server: 'https://ntfy.example.com', topic: 'notify-home' }
        s.serverSource = 'custom'
        s.topicSource = 'custom'
        s.tokenSource = 'custom'
        s.keySource = 'custom'
        break
    }
    this.#changed()
    this.#emit('connection', s.connection)
  }

  on(name: string, listener: Listener) {
    let set = this.#listeners.get(name)
    if (!set) this.#listeners.set(name, (set = new Set()))
    set.add(listener)
    return () => set.delete(listener)
  }

  #emit(name: string, value: unknown) {
    for (const listener of this.#listeners.get(name) ?? []) listener(structuredClone(value))
  }

  #changed() {
    this.#emit('snapshot', this.state)
  }

  #later(ms: number, work: () => void) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      work()
    }, ms)
    this.#timers.add(timer)
  }

  dispose() {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#listeners.clear()
  }

  #setConnection(next: Partial<Connection>) {
    this.state.connection = { ...this.state.connection, ...next }
    this.#emit('connection', this.state.connection)
  }

  #configured() {
    return (!!this.state.settings.server || !!BUILTIN.server) && (!!this.state.settings.topic || !!BUILTIN.topic)
  }

  #throttle = { level: 0, last: 0, next: 0 }
  #checkThrottle(now = Date.now()) {
    const t = this.#throttle
    if (now < t.next) return false
    if (t.last) t.level = Math.max(0, t.level - Math.floor((now - t.last) / 20000))
    t.level += 1
    t.last = now
    t.next = now + cooldown(t.level)
    return true
  }

  #connect() {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    if (!this.#configured()) {
      this.#setConnection({ state: 'unconfigured', connectedAt: null, error: '', retryAt: null })
      return
    }
    this.#setConnection({ state: 'connecting', mode: this.state.settings.mode, retryAt: null })
    this.#later(this.#connectMs, () => {
      const now = Date.now()
      this.#setConnection({ state: 'connected', connectedAt: now, lastEventAt: now, attempts: 0, error: '' })
    })
  }

  // 和 Rust 一致：超过 30 天的去掉，再只留最近 300 条
  #prune() {
    const oldest = Math.floor(Date.now() / 1000) - 30 * 86400
    this.state.messages = this.state.messages.filter((m) => m.time >= oldest).slice(-300)
  }

  #push(message: Message, announce = true) {
    if (this.state.messages.some((m) => m.id === message.id)) return false
    this.state.messages.push(message)
    this.state.messages.sort((a, b) => a.time - b.time)
    this.#prune()
    if (announce) this.#emit('message', message)
    this.#changed()
    return true
  }

  #validate(settings: Settings) {
    if (settings.server && !/^https?:\/\//.test(settings.server))
      throw new Error('服务器地址需以 https:// 开头')
    if (settings.topic && !/^[A-Za-z0-9_-]+$/.test(settings.topic))
      throw new Error('主题只能包含字母、数字、- 和 _')
    if (!SOUNDS.includes(settings.sound)) throw new Error('未知的提示音')
  }

  async command(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await Promise.resolve()
    switch (name) {
      case 'get_snapshot':
        return structuredClone(this.state)
      case 'save_settings': {
        const settings = structuredClone(args.settings as Settings)
        settings.server = settings.server.trim().replace(/\/+$/, '')
        settings.topic = settings.topic.trim()
        if (settings.server === BUILTIN.server) settings.server = ''
        if (settings.topic === BUILTIN.topic) settings.topic = ''
        settings.pollSeconds = Math.min(3600, Math.max(15, settings.pollSeconds))
        this.#validate(settings)
        if (settings.avatarStyle !== 'name' && !PRESETS.includes(settings.avatarStyle)) settings.avatarStyle = randomStyle()
        if (settings.avatarStyle === 'name' && this.state.identity.name === ANONYMOUS) settings.avatarStyle = randomStyle()
        const previous = this.state.settings
        const reconnect =
          settings.server !== previous.server ||
          settings.topic !== previous.topic ||
          settings.mode !== previous.mode ||
          settings.pollSeconds !== previous.pollSeconds
        this.state.settings = settings
        this.state.serverSource = settings.server ? 'custom' : 'builtin'
        this.state.topicSource = settings.topic ? 'custom' : 'builtin'
        if (reconnect) this.#connect()
        this.#changed()
        return
      }
      case 'finish_welcome':
        this.state.welcomed = true
        this.#changed()
        return
      case 'save_identity': {
        const name = cleanName(String(args.name ?? ''))
        this.state.identity = { ...this.state.identity, name: name || this.state.defaultName }
        // 连系统账户名都没有、回到 anonymous 时，名字头像不能用，自动换成随机一套预设
        if (this.state.identity.name === ANONYMOUS && this.state.settings.avatarStyle === 'name') this.state.settings.avatarStyle = randomStyle()
        this.#changed()
        return
      }
      case 'save_templates': {
        const templates = structuredClone(args.templates as Template[]).map((t) => ({
          id: t.id || randomId(16),
          text: t.text.trim(),
        }))
        if (templates.length > 10) throw new Error('文案最多 10 条')
        if (templates.some((t) => !t.text)) throw new Error('文案不能为空')
        if (templates.some((t) => [...t.text].length > 100)) throw new Error('文案最长 100 个字')
        this.state.templates = templates
        this.#changed()
        return
      }
      case 'set_secret': {
        const value = String(args.value ?? '').trim()
        if (args.kind === 'token') {
          this.state.tokenSource = value ? 'custom' : 'builtin'
          this.#connect()
        } else if (args.kind === 'key') this.state.keySource = value ? 'custom' : 'builtin'
        else throw new Error('未知的凭据')
        this.#changed()
        return
      }
      case 'reset_templates':
        this.state.templates = defaultTemplates()
        this.#changed()
        return
      case 'reset_settings':
        return this.command('save_settings', { settings: structuredClone(this.#initial.settings) })
      case 'generate_key':
        return randomId(32)
      case 'send': {
        const body = String(args.body ?? '').trim()
        const title = String(args.title ?? '').trim()
        if (!body) throw new Error('消息不能为空')
        if ([...body].length > BODY_LIMIT) throw new Error(`消息最长 ${BODY_LIMIT} 个字`)
        // 仅自己：不经过服务器，本机记录并提醒，不受节流和连接状态影响
        const toSelf = !!args.toSelf
        if (!toSelf) {
          if (!this.#configured()) throw new Error('请先在设置里填写服务器和主题')
          if (this.state.settings.encrypt && this.state.keySource === 'none')
            throw new Error('加密已开启，但还没有共享密钥，请在设置里填写')
          if (!this.#checkThrottle()) throw new Error('发得太快了，稍后再试')
          if (this.state.connection.state === 'waiting') throw new Error('连不上服务器')
        }
        const message: Message = {
          id: `web-${randomId(10)}`,
          time: Math.floor(Date.now() / 1000),
          title,
          body,
          senderId: this.state.identity.id,
          senderName: this.state.identity.name,
          senderAvatar: this.state.settings.avatarStyle,
          mine: true,
          encrypted: !toSelf && this.state.settings.encrypt,
          status: 'ok',
          toSelf,
        }
        if (toSelf) {
          this.#push(message)
          return structuredClone(message)
        }
        // 和桌面一致：发送结果先入列表，订阅回声稍后到达
        this.#push(message, false)
        this.#later(300, () => this.#emit('echo', message.id))
        return structuredClone(message)
      }
      case 'reconnect':
        this.#connect()
        return
      case 'pause_alerts': {
        // 模拟只算截止时间并到点恢复，不做错过消息的合并提醒
        const now = Date.now() / 1000
        const morning = new Date()
        if (morning.getHours() >= 9) morning.setDate(morning.getDate() + 1)
        morning.setHours(9, 0, 0, 0)
        const minutes: Record<string, number> = { '30m': 30, '1h': 60 }
        const until = args.preset === 'morning' ? Math.floor(morning.getTime() / 1000) : Math.floor(now + (minutes[String(args.preset)] ?? 0) * 60)
        if (until <= now) throw new Error('未知的暂停时长')
        this.state.pausedUntil = until
        const at = until
        this.#later((until - now) * 1000, () => {
          if (this.state.pausedUntil !== at) return
          this.state.pausedUntil = 0
          this.#changed()
        })
        this.#changed()
        return until
      }
      case 'cli_status':
        return { state: this.#cli ? 'installed' : 'none', path: '~/.local/bin/fox-nudge', target: '' }
      case 'install_cli':
      case 'uninstall_cli':
        this.#cli = name === 'install_cli'
        return { state: this.#cli ? 'installed' : 'none', path: '~/.local/bin/fox-nudge', target: '' }
      case 'resume_alerts':
        this.state.pausedUntil = 0
        this.#changed()
        return
      case 'set_recent_hidden': {
        const text = String(args.text).trim()
        const hidden = { ...this.state.recentHidden }
        if (Number(args.at) > 0) hidden[text] = Number(args.at)
        else delete hidden[text]
        this.state.recentHidden = hidden
        this.#changed()
        return
      }
      case 'set_recent_cleared':
        this.state.recentClearedAt = Number(args.at)
        this.#changed()
        return
      case 'debug_clear_mock': {
        const before = this.state.messages.length
        this.state.messages = this.state.messages.filter((m) => !m.id.startsWith('debug-'))
        this.#changed()
        return before - this.state.messages.length
      }
      case 'debug_mock':
        this.#mock(String(args.target ?? ''), String(args.state ?? ''))
        return
      case 'debug_reset':
        this.#restore()
        this.#original = undefined
        return
      case 'clear_history':
        this.state.messages = []
        this.#changed()
        return
      case 'wipe_data':
        this.state = this.#fresh()
        this.#connect()
        this.#changed()
        return
      case 'open_logs':
        this.effects.push({ kind: 'open-logs' })
        return
      case 'test_sound':
        this.effects.push({ kind: 'sound', sound: String(args.sound) })
        return
      // 模拟新版通知权限：首次未决定，请求后允许，方便在浏览器里看引导
      case 'notification_status':
        return this.permission
      case 'request_notifications':
        this.permission = 'authorized'
        return this.permission
      case 'open_notification_settings':
        this.effects.push({ kind: 'open-logs' })
        return
      case 'preview_notification':
        this.effects.push({ kind: 'notification', title: this.state.identity.name, body: '这是一条预览消息' })
        return
      case 'test_notification':
        this.effects.push({ kind: 'notification', title: 'FoxNudge', body: '这是一条测试通知' })
        return
      case 'log_client':
        this.effects.push({ kind: 'log', level: String(args.level), event: String(args.event) })
        return
      case 'debug_inject': {
        const input = args.message as {
          title?: string
          body: string
          senderName?: string
          encrypted?: boolean
          backlog?: boolean
          wrongKey?: boolean
          avatar?: string
          senderId?: string
        }
        const undecryptable = !!input.wrongKey
        const unknown = undecryptable
        const senderId = input.senderId ?? 'debug-sender'
        const message: Message = {
          id: `debug-${randomId(10)}`,
          time: Math.floor(Date.now() / 1000) - (input.backlog ? 600 : 0),
          title: undecryptable ? '' : (input.title ?? ''),
          body: undecryptable ? '' : input.body,
          senderId: unknown ? null : senderId,
          senderName: unknown ? null : (input.senderName ?? '调试'),
          senderAvatar: unknown ? null : (input.avatar ?? null),
          mine: !unknown && senderId === this.state.identity.id,
          encrypted: !!input.encrypted || undecryptable,
          status: undecryptable ? 'undecryptable' : 'ok',
          toSelf: false,
        }
        this.#push(message)
        if (message.mine) return message.id
        if (this.state.settings.notify)
          this.effects.push({
            kind: 'notification',
            title: message.senderName ?? '收到一条无法解密的消息',
            body: message.body,
          })
        if (this.state.settings.sound !== 'none')
          this.effects.push({ kind: 'sound', sound: this.state.settings.sound })
        return message.id
      }
      case 'debug_disconnect':
        this.#setConnection({
          state: 'waiting',
          connectedAt: null,
          attempts: this.state.connection.attempts + 1,
          error: '模拟断线',
          retryAt: Date.now() + this.#retryMs,
        })
        this.#later(this.#retryMs, () => this.#connect())
        return
      default:
        throw new Error(`Web 模拟不支持：${name}`)
    }
  }
}
