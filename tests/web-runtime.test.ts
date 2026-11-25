import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cooldown, WebRuntime } from '../src/debug/web/runtime.ts'
import type { Snapshot } from '../src/lib/bindings/Snapshot.ts'
import type { Message } from '../src/lib/bindings/Message.ts'

const initial: Snapshot = {
  settings: {
    server: '',
    topic: '',
    encrypt: true,
    mode: 'stream',
    pollSeconds: 60,
    sound: 'Glass',
    soundFollowSystem: true,
    notify: true,
    notifyStyle: 'minimal',
    dockMode: 'window',
    theme: 'system',
    avatarStyle: 'beam',
    launchAtLogin: false,
  },
  identity: { id: '', name: 'anonymous' },
  defaultName: 'anonymous',
  templates: [],
  messages: [],
  connection: { state: 'connecting', mode: 'stream', connectedAt: null, lastEventAt: null, attempts: 0, retryAt: null, error: '' },
  serverSource: 'none',
  topicSource: 'none',
  tokenSource: 'none',
  keySource: 'none',
  recentClearedAt: 0,
  pausedUntil: 0,
  welcomed: true,
  recentHidden: {},
  peers: [],
  presenceLimited: false,
  version: '0.1.0',
  dev: false,
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const snapshot = (rt: WebRuntime) => rt.command('get_snapshot') as Promise<Snapshot>

test('首次启动生成身份和默认模板，清除数据后换新身份', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  const first = await snapshot(rt)
  assert.equal(first.identity.id.length, 12)
  assert.equal(first.identity.name, 'web')
  assert.equal(first.templates.length, 6)
  await rt.command('wipe_data')
  assert.notEqual((await snapshot(rt)).identity.id, first.identity.id)
  rt.dispose()
})

test('连接后发送：消息先入列表，回声随后到达', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  const echoes: string[] = []
  const announced: Message[] = []
  rt.on('echo', (id) => echoes.push(String(id)))
  rt.on('message', (m) => announced.push(m as Message))
  await wait(20)
  assert.equal((await snapshot(rt)).connection.state, 'connected')
  const sent = (await rt.command('send', { title: '', body: ' 来一下 ' })) as Message
  assert.equal(sent.body, '来一下')
  assert.equal(sent.mine, true)
  assert.equal((await snapshot(rt)).messages.length, 1)
  assert.equal(announced.length, 0, '自己发的消息不当作新收到的消息')
  await wait(350)
  assert.deepEqual(echoes, [sent.id])
  rt.dispose()
})

test('发送校验：空消息、超长、没有密钥', async () => {
  const rt = new WebRuntime({ ...initial }, { connectMs: 5 })
  await assert.rejects(rt.command('send', { body: '  ' }), /不能为空/)
  await assert.rejects(rt.command('send', { body: 'x'.repeat(501) }), /最长/)
  rt.state.keySource = 'none'
  await assert.rejects(rt.command('send', { body: 'hi' }), /共享密钥/)
  rt.dispose()
})

test('收到他人消息会提醒，密钥不一致标记为无法解密', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  await rt.command('debug_inject', { message: { body: '在吗', senderName: '小明' } })
  await rt.command('debug_inject', { message: { body: '秘密', wrongKey: true } })
  const s = await snapshot(rt)
  assert.equal(s.messages.length, 2)
  assert.equal(s.messages[0].senderName, '小明')
  assert.equal(s.messages[1].status, 'undecryptable')
  assert.equal(s.messages[1].body, '')
  assert.ok(rt.effects.some((e) => e.kind === 'notification'))
  assert.ok(rt.effects.some((e) => e.kind === 'sound'))
  rt.dispose()
})

test('断线后按退避重连', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5, retryMs: 30 })
  await wait(20)
  await rt.command('debug_disconnect')
  let s = await snapshot(rt)
  assert.equal(s.connection.state, 'waiting')
  assert.equal(s.connection.attempts, 1)
  assert.ok(s.connection.retryAt)
  await assert.rejects(rt.command('send', { body: 'hi' }), /连不上/)
  await wait(80)
  s = await snapshot(rt)
  assert.equal(s.connection.state, 'connected')
  rt.dispose()
})

test('设置校验与改主题重连', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  const s = await snapshot(rt)
  await assert.rejects(rt.command('save_settings', { settings: { ...s.settings, topic: 'bad topic' } }), /主题/)
  await assert.rejects(rt.command('save_settings', { settings: { ...s.settings, server: 'ftp://x' } }), /https/)
  assert.equal(s.serverSource, 'builtin')
  await rt.command('save_settings', { settings: { ...s.settings, topic: 'notify-test', server: 'https://x/' } })
  const next = await snapshot(rt)
  assert.equal(next.settings.server, 'https://x')
  assert.equal(next.serverSource, 'custom')
  assert.equal(next.connection.state, 'connecting')
  await rt.command('save_settings', { settings: { ...next.settings, server: '', topic: ' ' } })
  const cleared = await snapshot(rt)
  assert.deepEqual([cleared.settings.server, cleared.serverSource, cleared.topicSource], ['', 'builtin', 'builtin'], '清空回到内置')
  rt.dispose()
})

test('文案校验：不能为空、最多 10 条、补 ID', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  await assert.rejects(rt.command('save_templates', { templates: [{ id: '', text: '  ' }] }), /不能为空/)
  const eleven = Array.from({ length: 11 }, (_, i) => ({ id: String(i), text: `t${i}` }))
  await assert.rejects(rt.command('save_templates', { templates: eleven }), /最多 10 条/)
  await rt.command('save_templates', { templates: [{ id: '', text: ' 叮 ' }] })
  const [t] = (await snapshot(rt)).templates
  assert.equal(t.text, '叮')
  assert.ok(t.id)
  rt.dispose()
})

test('重置设置保留昵称和文案，恢复默认文案', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  const s = await snapshot(rt)
  await rt.command('save_identity', { name: 'tobe' })
  await rt.command('save_templates', { templates: [{ id: '', text: '自定义' }] })
  await rt.command('save_settings', { settings: { ...s.settings, sound: 'Ping', topic: 'notify-x' } })
  await rt.command('reset_settings')
  let next = await snapshot(rt)
  assert.equal(next.settings.sound, 'Glass')
  assert.equal(next.settings.topic, '')
  assert.equal(next.identity.name, 'tobe')
  assert.deepEqual(next.templates.map((t) => t.text), ['自定义'])
  await rt.command('reset_templates')
  next = await snapshot(rt)
  assert.deepEqual(next.templates.map((t) => t.text), ['ding', 'hi', '叮', '来一下', '吃饭啦', '收到'])
  rt.dispose()
})

test('头像：首次随机预设；默认昵称是系统账户名，名字头像一直能用', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  let s = await snapshot(rt)
  assert.notEqual(s.settings.avatarStyle, 'name')
  await rt.command('save_settings', { settings: { ...s.settings, avatarStyle: 'name' } })
  assert.equal((await snapshot(rt)).settings.avatarStyle, 'name', '系统账户名也能当名字头像')
  await rt.command('save_identity', { name: '小狐狸' })
  s = await snapshot(rt)
  await rt.command('save_settings', { settings: { ...s.settings, avatarStyle: 'name' } })
  assert.equal((await snapshot(rt)).settings.avatarStyle, 'name')
  await rt.command('save_identity', { name: 'ANONYMOUS' })
  s = await snapshot(rt)
  // 清空或填 anonymous 都回到系统账户名，名字头像照样能用
  assert.equal(s.identity.name, 'web')
  assert.equal(s.settings.avatarStyle, 'name')
  const sent = (await rt.command('send', { title: '', body: 'hi' })) as Message
  assert.equal(sent.senderAvatar, s.settings.avatarStyle)
  rt.dispose()
})

test('发送节流：连发 3 条不限，之后冷却，最长 30 秒', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(cooldown), [0, 0, 0, 2000, 4000, 8000, 16000, 30000, 30000])
  const rt = new WebRuntime(initial, { connectMs: 5 })
  await wait(20)
  for (let i = 0; i < 4; i++) await rt.command('send', { body: `m${i}` })
  await assert.rejects(rt.command('send', { body: 'too fast' }), /太快/)
  rt.dispose()
})

test('Mock：切状态在复制品上改，还原回到切之前', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  await wait(20)
  const before = await snapshot(rt)
  await rt.command('debug_mock', { target: 'peers', state: 'some' })
  assert.equal((await snapshot(rt)).peers.length, 3)
  await rt.command('debug_mock', { target: 'send', state: 'waiting' })
  let s = await snapshot(rt)
  assert.equal(s.peers.length, 0, '换状态先回到原样')
  assert.equal(s.connection.state, 'waiting')
  await rt.command('debug_reset')
  s = await snapshot(rt)
  assert.equal(s.connection.state, 'connected')
  assert.equal(s.identity.id, before.identity.id)
  // 桌面端复制进来的快照不被模拟连接盖掉
  const seeded = new WebRuntime(initial, { connectMs: 5 })
  seeded.seed({ ...before, connection: { ...before.connection, state: 'waiting' } })
  await wait(20)
  assert.equal((await snapshot(seeded)).connection.state, 'waiting')
  rt.dispose()
  seeded.dispose()
})
