// DEBUG：浏览器 DEV 的模拟运行时，命令名和返回结构与 Rust 一致，数据只在内存里
// 不依赖 import.meta，供 node --test 直接测试
import type { Snapshot } from '../../lib/bindings/Snapshot'
import type { Settings } from '../../lib/bindings/Settings'
import type { Template } from '../../lib/bindings/Template'
import type { Message } from '../../lib/bindings/Message'
import type { Connection } from '../../lib/bindings/Connection'
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
  return ['叮', '来一下', '吃饭啦', '好了', '收到'].map((text) => ({ id: randomId(16), text }))
}

export type WebRuntimeOptions = { connectMs?: number; retryMs?: number }

export class WebRuntime {
  state: Snapshot
  effects: Effect[] = []
  #listeners = new Map<string, Set<Listener>>()
  #timers = new Set<ReturnType<typeof setTimeout>>()
  #initial: Snapshot
  #connectMs: number
  #retryMs: number

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
      identity: { id: randomId(12), name: ANONYMOUS },
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
      case 'save_identity': {
        const name = cleanName(String(args.name ?? ''))
        this.state.identity = { ...this.state.identity, name: name || ANONYMOUS }
        // 回到兜底名字时，名字头像不能用，自动换成随机一套预设
        if (!name && this.state.settings.avatarStyle === 'name') this.state.settings.avatarStyle = randomStyle()
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
        if (!this.#configured()) throw new Error('请先在设置里填写服务器和主题')
        if (this.state.settings.encrypt && this.state.keySource === 'none')
          throw new Error('加密已开启，但还没有共享密钥，请在设置里填写')
        if (!this.#checkThrottle()) throw new Error('发得太快了，稍后再试')
        if (this.state.connection.state === 'waiting') throw new Error('连不上服务器')
        const message: Message = {
          id: `web-${randomId(10)}`,
          time: Math.floor(Date.now() / 1000),
          title,
          body,
          senderId: this.state.identity.id,
          senderName: this.state.identity.name,
          senderAvatar: this.state.settings.avatarStyle,
          mine: true,
          encrypted: this.state.settings.encrypt,
          status: 'ok',
        }
        // 和桌面一致：发送结果先入列表，订阅回声稍后到达
        this.#push(message, false)
        this.#later(300, () => this.#emit('echo', message.id))
        return structuredClone(message)
      }
      case 'reconnect':
        this.#connect()
        return
      case 'set_recent_cleared':
        this.state.recentClearedAt = Number(args.at)
        this.#changed()
        return
      case 'debug_fill_history': {
        const texts = ['叮', '来一下', '吃饭啦', '好了', '收到', '马上到', '在吗', '下午三点开会别忘了', '构建完成，可以看了', '帮我看下这个报错', '今天早点走', '快递到了', '喝水', '会议改到明天上午', '这是一条比较长的消息，用来看历史里一行放不下的时候怎么截断显示，后面还有很多字']
        const senders = [['debug-xiaoming', '小明', 'name'], ['debug-ahu', '阿狐', 'openPeeps'], ['debug-lucy', 'Lucy', 'notionists'], ['debug-tobe', 'tobe', 'lorelei'], ['debug-long-cn', '欧阳慕容东方西门北冥南宫上官司马', 'name'], ['debug-long-en', 'Alexander Wright', 'adventurer']]
        texts.push('这是一条写满 500 字的消息，用来看历史和悬停提示在内容最长时的样子。'.repeat(20).slice(0, 500), '这条刚好一百个字，和文案的长度上限一样，用来看最近发过和文案两边在内容最长时怎么截断。'.repeat(3).slice(0, 100))
        const now = Math.floor(Date.now() / 1000)
        const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]
        for (let i = 0; i < Number(args.count); i++) {
          const roll = Math.floor(Math.random() * 10)
          const [senderId, senderName, senderAvatar] =
            roll < 3 ? [this.state.identity.id, this.state.identity.name, this.state.settings.avatarStyle] : roll === 3 ? [null, null, null] : pick(senders)
          this.state.messages.push({
            id: `debug-fill-${randomId(8)}-${i}`,
            time: now - 60 - Math.floor(Math.random() * (30 * 86400 - 3660)),
            title: '',
            body: pick(texts),
            senderId,
            senderName,
            senderAvatar,
            mine: roll < 3,
            encrypted: true,
            status: 'ok',
          })
        }
        this.state.messages.sort((a, b) => a.time - b.time)
        this.#prune()
        this.#changed()
        return this.state.messages.length
      }
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
          anonymous?: boolean
          ago?: number
          silent?: boolean
        }
        const undecryptable = !!input.wrongKey
        const unknown = undecryptable || (!!input.anonymous && !input.encrypted)
        const senderId = input.senderId ?? 'debug-sender'
        const message: Message = {
          id: `debug-${randomId(10)}`,
          time: Math.floor(Date.now() / 1000) - (input.ago ?? (input.backlog ? 600 : 0)),
          title: undecryptable ? '' : (input.title ?? ''),
          body: undecryptable ? '' : input.body,
          senderId: unknown ? null : senderId,
          senderName: unknown ? null : (input.senderName ?? '调试'),
          senderAvatar: unknown ? null : (input.avatar ?? null),
          mine: !unknown && senderId === this.state.identity.id,
          encrypted: !!input.encrypted || undecryptable,
          status: undecryptable ? 'undecryptable' : 'ok',
        }
        this.#push(message)
        if (input.silent || message.mine) return message.id
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
