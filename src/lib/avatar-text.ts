// 中日韩等全角字符算 2 个宽度，其余算 1 个
const wide = (c: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(c)

export const AVATAR_TEXT_WIDTH = 4

/** 昵称最多取 4 个半角宽度：中文 2 个、英文 4 个；返回文字、宽度和估算的字宽（中文 1em，其余 0.6em） */
export function avatarText(name: string) {
  let text = ''
  let width = 0
  let em = 0
  for (const c of [...name.trim()]) {
    const w = wide(c) ? 2 : 1
    if (width + w > AVATAR_TEXT_WIDTH) break
    text += c
    width += w
    em += w === 2 ? 1 : 0.6
  }
  return { text, width, em }
}

/** 文字总宽约占直径的 72%，单字不超过直径的一半 */
export function avatarFontSize(size: number, em: number) {
  return Math.round(Math.min(size * 0.5, (size * 0.72) / Math.max(em, 1)) * 10) / 10
}
