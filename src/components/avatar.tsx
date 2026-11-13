import Boring from 'boring-avatars'
import { avatarFontSize, avatarText, hasName } from '../lib/avatar-text'

// FoxNudge 主题色：狐狸橙、奶油、深棕、淡紫、品牌紫
const PALETTE = ['#F2843A', '#FBE3C8', '#5B3A29', '#B1B8D7', '#8C6BD9']
// 昵称头像的底色，避开太浅的奶油色，保证白字可读
const TEXT_BACKGROUNDS = ['#F2843A', '#5B3A29', '#8C6BD9', '#D9693A', '#6F7AB0']

export const avatarPresets = ['beam', 'marble', 'bauhaus', 'ring', 'pixel', 'sunset'] as const
type Preset = (typeof avatarPresets)[number]

function hash(text: string) {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619)
  return h >>> 0
}

/**
 * 头像：avatar 为 name 且设了昵称时显示昵称文字，否则按设备 ID 画预设风格；
 * 发送者没带风格（旧消息）时按 ID 算一套；没有 ID（curl 发的）显示灰色圆
 */
export function Avatar(props: { id?: string | null; name?: string | null; avatar?: string | null; size: number }) {
  const { id, size } = props
  if (!id)
    return <span className='inline-block shrink-0 rounded-full bg-muted' style={{ width: size, height: size }} aria-hidden='true' />
  if (props.avatar === 'name' && hasName(props.name)) {
    const { text, em } = avatarText(props.name!)
    return (
      <span
        className='inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none font-medium text-white select-none'
        style={{ width: size, height: size, background: TEXT_BACKGROUNDS[hash(id) % TEXT_BACKGROUNDS.length], fontSize: avatarFontSize(size, em) }}
        aria-hidden='true'
      >
        {text}
      </span>
    )
  }
  const preset = avatarPresets.includes(props.avatar as Preset) ? (props.avatar as Preset) : avatarPresets[hash(id) % avatarPresets.length]
  return <Boring name={id} variant={preset} colors={PALETTE} size={size} title={false} className='shrink-0' aria-hidden='true' />
}
