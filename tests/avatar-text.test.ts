import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarFontSize, avatarText } from '../src/lib/avatar-text.ts'

test('头像文字最多 4 个半角宽度：中文 2 个、英文 4 个', () => {
  const pick = (name: string) => {
    const { text, width } = avatarText(name)
    return { text, width }
  }
  assert.deepEqual(pick('tobe'), { text: 'tobe', width: 4 })
  assert.deepEqual(pick('anonymous'), { text: 'anon', width: 4 })
  assert.deepEqual(pick('小狐狸'), { text: '小狐', width: 4 })
  assert.deepEqual(pick('狐'), { text: '狐', width: 2 })
  assert.deepEqual(pick('A狐b'), { text: 'A狐b', width: 4 })
  assert.deepEqual(pick(' a '), { text: 'a', width: 1 })
})

test('字越多字号越小，单字不超过直径一半', () => {
  const size = 26
  const font = (name: string) => avatarFontSize(size, avatarText(name).em)
  assert.equal(font('狐'), 13)
  assert.ok(font('小狐') < font('狐'))
  assert.ok(font('tobe') < font('to'))
  assert.ok(font('小狐') >= 9, '两个中文字在 26px 头像里不小于 9px')
})
