import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recentSent } from '../src/lib/recent.ts'
import type { Message } from '../src/lib/bindings/Message.ts'

const msg = (id: string, time: number, body: string, mine = true, status = 'ok'): Message => ({
  id,
  time,
  title: '',
  body,
  senderId: mine ? 'me' : 'other',
  senderName: null,
  senderAvatar: null,
  mine,
  encrypted: true,
  status,
  toSelf: false,
})

test('最近发过：只要自己发的、去重、排除文案、最多 10 条、清空时间点之前的不算', () => {
  const messages = [
    msg('1', 10, '旧的'),
    msg('2', 20, '叮'),
    msg('3', 30, '马上到'),
    msg('4', 40, '别人发的', false),
    msg('5', 50, '马上到'),
    msg('6', 60, 'a'),
    msg('7', 70, 'b'),
    msg('8', 80, 'c'),
    msg('9', 90, 'd'),
    msg('10', 95, '坏的', true, 'undecryptable'),
  ]
  const templates = [{ id: 't', text: '叮' }]
  assert.deepEqual(recentSent({ messages, recentClearedAt: 0, recentHidden: {} }, templates), ['d', 'c', 'b', 'a', '马上到', '旧的'])
  const many = Array.from({ length: 15 }, (_, i) => msg(`m${i}`, 100 + i, `第${i}条`))
  assert.equal(recentSent({ messages: many, recentClearedAt: 0, recentHidden: {} }, []).length, 10)
  assert.deepEqual(recentSent({ messages, recentClearedAt: 70, recentHidden: {} }, templates), ['d', 'c'])
})

test('最近发过：单独删掉的不显示，删除之后再发同样内容会重新出现', () => {
  const messages = [msg('1', 10, 'a'), msg('2', 20, 'b'), msg('3', 30, 'c')]
  const view = (recentHidden: Record<string, number>, extra: Message[] = []) =>
    recentSent({ messages: [...messages, ...extra], recentClearedAt: 0, recentHidden }, [])
  assert.deepEqual(view({ b: 25 }), ['c', 'a'])
  assert.deepEqual(view({ b: 25 }, [msg('4', 40, 'b')]), ['b', 'c', 'a'])
})
