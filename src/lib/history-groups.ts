import type { Message } from './bindings/Message'

// 照 TalkMore：按本地日历日期分组，标题为今天、昨天、前天，再早写几月几日，跨年带年份
export function groupHistory(messages: Message[], now = new Date()) {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  const ago = (days: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - days)
    return key(d)
  }
  const named = new Map([
    [ago(0), '今天'],
    [ago(1), '昨天'],
    [ago(2), '前天'],
  ])
  const groups = new Map<string, { key: string; title: string; messages: Message[] }>()
  // 最新的在上
  for (const message of [...messages].sort((a, b) => b.time - a.time)) {
    const date = new Date(message.time * 1000)
    const k = key(date)
    let group = groups.get(k)
    if (!group) {
      const title =
        named.get(k) ??
        date.toLocaleDateString('zh-CN', {
          year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
          month: 'long',
          day: 'numeric',
        })
      group = { key: k, title, messages: [] }
      groups.set(k, group)
    }
    group.messages.push(message)
  }
  return [...groups.values()]
}
