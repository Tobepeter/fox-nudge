import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Avatar } from './avatar'
import { HelpTip } from './help-tip'
import { AVATAR_CREDITS, AVATAR_STYLES, styleLabel } from '../lib/avatar-styles'

const credits = (
  <span>
    头像由 DiceBear 生成。以下风格按 CC BY 4.0 使用：
    {AVATAR_CREDITS.map(([style, author]) => `${style}（${author}）`).join('、')}
  </span>
)

// 点当前头像打开弹窗，全部风格用自己的设备 ID 预览，点一下即选中并关闭
export function AvatarPicker(props: {
  id: string
  name: string
  value: string
  named: boolean
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const options = ['name', ...AVATAR_STYLES]
  return (
    <>
      <button
        aria-label='更换头像'
        disabled={props.disabled}
        onClick={() => setOpen(true)}
        className='rounded-full ring-2 ring-transparent transition-shadow hover:ring-border focus-visible:ring-ring focus-visible:outline-none'
      >
        <Avatar id={props.id} name={props.name} avatar={props.value} size={32} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='flex max-h-[80vh] flex-col sm:max-w-lg'>
          <DialogHeader className='shrink-0'>
            <DialogTitle className='flex items-center gap-0.5'>
              选择头像
              <HelpTip label='头像版权'>{credits}</HelpTip>
            </DialogTitle>
          </DialogHeader>
          <div className='app-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4' role='radiogroup' aria-label='头像'>
            <div className='grid grid-cols-6 gap-2 pb-1'>
              {options.map((value) => {
                const off = value === 'name' && !props.named
                const checked = props.value === value
                return (
                  <button
                    key={value}
                    role='radio'
                    aria-checked={checked}
                    aria-label={value === 'name' ? '名字' : styleLabel(value)}
                    disabled={off}
                    onClick={() => {
                      props.onChange(value)
                      setOpen(false)
                    }}
                    className={`flex aspect-square items-center justify-center rounded-xl ring-2 transition-shadow disabled:opacity-40 ${checked ? 'ring-primary' : 'ring-transparent enabled:hover:bg-muted'}`}
                  >
                    {off ? (
                      <span className='flex size-12 items-center justify-center rounded-full border border-dashed text-muted-foreground'>名</span>
                    ) : (
                      <Avatar id={props.id} name={props.name} avatar={value} size={48} />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
