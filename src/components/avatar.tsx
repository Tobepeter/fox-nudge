import Boring from 'boring-avatars'
import { avatarFontSize, avatarText } from '../lib/avatar-text'

// FoxNudge 主题色：狐狸橙、奶油、深棕、淡紫、品牌紫
const PALETTE = ['#F2843A', '#FBE3C8', '#5B3A29', '#B1B8D7', '#8C6BD9']
// 昵称头像的底色，避开太浅的奶油色，保证白字可读
const TEXT_BACKGROUNDS = ['#F2843A', '#5B3A29', '#8C6BD9', '#D9693A', '#6F7AB0']

export const avatarStyles = [
  { value: 'beam', label: '笑脸' },
  { value: 'marble', label: '大理石' },
  { value: 'bauhaus', label: '包豪斯' },
  { value: 'ring', label: '圆环' },
  { value: 'pixel', label: '像素' },
  { value: 'sunset', label: '日落' },
]

type Variant = 'beam' | 'marble' | 'bauhaus' | 'ring' | 'pixel' | 'sunset'

function hash(text: string) {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619)
  return h >>> 0
}

export function Avatar(props: { id?: string | null; name?: string | null; style: string; size: number }) {
  const { id, size } = props
  const name = props.name?.trim()
  if (!id)
    return <span className='inline-block shrink-0 rounded-full bg-muted' style={{ width: size, height: size }} aria-hidden='true' />
  if (name && name !== 'anonymous') {
    const { text, em } = avatarText(name)
    return (
      <span
        className='inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none font-medium text-white select-none'
        style={{ width: size, height: size, background: TEXT_BACKGROUNDS[hash(id) % TEXT_BACKGROUNDS.length], fontSize: avatarFontSize(size, em) }}
        title={name}
        aria-hidden='true'
      >
        {text}
      </span>
    )
  }
  return <Boring name={id} variant={props.style as Variant} colors={PALETTE} size={size} className='shrink-0' aria-hidden='true' />
}
