import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebRuntime } from '../src/debug/web/runtime.ts'
import type { Snapshot } from '../src/lib/bindings/Snapshot.ts'
import type { Message } from '../src/lib/bindings/Message.ts'

const initial: Snapshot = {
  settings: {
    server: 'https://notify.tobeei.com',
    topic: 'notify-main',
    encrypt: true,
    mode: 'stream',
    pollSeconds: 60,
    sound: 'Glass',
    notify: true,
    shortcut: 'Control+Alt+N',
    dockMode: 'window',
    theme: 'system',
    launchAtLogin: false,
  },
  identity: { id: '', name: 'anonymous' },
  templates: [],
  messages: [],
  connection: { state: 'connecting', mode: 'stream', connectedAt: null, lastEventAt: null, attempts: 0, retryAt: null, error: '' },
  tokenSource: 'none',
  keySource: 'none',
  version: '0.1.0',
  dev: false,
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const snapshot = (rt: WebRuntime) => rt.command('get_snapshot') as Promise<Snapshot>

test('首次启动生成身份和默认模板，清除数据后换新身份', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  const first = await snapshot(rt)
  assert.equal(first.identity.id.length, 12)
  assert.equal(first.identity.name, 'anonymous')
  assert.equal(first.templates.length, 4)
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
  await rt.command('save_settings', { settings: { ...s.settings, topic: 'notify-test', server: 'https://x/' } })
  const next = await snapshot(rt)
  assert.equal(next.settings.server, 'https://x')
  assert.equal(next.connection.state, 'connecting')
  await rt.command('save_settings', { settings: { ...next.settings, server: '', topic: '' } })
  assert.equal((await snapshot(rt)).connection.state, 'unconfigured')
  rt.dispose()
})

test('模板校验', async () => {
  const rt = new WebRuntime(initial, { connectMs: 5 })
  await assert.rejects(rt.command('save_templates', { templates: [{ id: '', title: '', body: 'x' }] }), /不能为空/)
  await rt.command('save_templates', { templates: [{ id: '', title: '  新的 ', body: ' 内容 ' }] })
  const [t] = (await snapshot(rt)).templates
  assert.equal(t.title, '新的')
  assert.ok(t.id)
  rt.dispose()
})
