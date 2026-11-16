import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupHistory } from '../src/lib/history-groups.ts'
import type { Message } from '../src/lib/bindings/Message.ts'

const at = (d: Date, id: string): Message => ({
  id,
  time: Math.floor(d.getTime() / 1000),
  title: '',
  body: id,
  senderId: null,
  senderName: null,
  senderAvatar: null,
  mine: false,
  encrypted: true,
  status: 'ok', toSelf: false,
})

test('按今天、昨天、前天、具体日期分组，最新在上，跨年带年份', () => {
  const now = new Date(2026, 10, 13, 21, 0)
  const day = (offset: number, hour = 10) => new Date(2026, 10, 13 - offset, hour)
  const groups = groupHistory(
    [at(day(3), 'd3'), at(day(0, 9), 't1'), at(day(1), 'y'), at(day(0, 20), 't2'), at(day(2), 'd2'), at(new Date(2025, 11, 31, 8), 'old')],
    now,
  )
  assert.deepEqual(
    groups.map((g) => [g.title, g.messages.map((m) => m.id)]),
    [
      ['今天', ['t2', 't1']],
      ['昨天', ['y']],
      ['前天', ['d2']],
      ['11月10日', ['d3']],
      ['2025年12月31日', ['old']],
    ],
  )
})
