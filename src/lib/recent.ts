import type { Snapshot } from './bindings/Snapshot'
import type { Template } from './bindings/Template'

const RECENT = 10

/** 自己最近发过的消息：同样内容只留最新一条，已经是文案的不重复，清空时间点之前的不算 */
export function recentSent(
  snapshot: Pick<Snapshot, 'messages' | 'recentClearedAt'>,
  templates: Template[],
) {
  const taken = new Set(templates.map((t) => t.text.trim()))
  const out: string[] = []
  for (const m of [...snapshot.messages].sort((a, b) => b.time - a.time)) {
    if (out.length >= RECENT) break
    const text = m.body.trim()
    if (
      !m.mine ||
      m.status !== 'ok' ||
      !text ||
      m.time <= snapshot.recentClearedAt ||
      taken.has(text)
    )
      continue
    taken.add(text)
    out.push(text)
  }
  return out
}
