import { useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

export type PausePreset = '30m' | '1h' | 'morning'

const presets: [PausePreset, string][] = [
  ['30m', '30 分钟'],
  ['1h', '1 小时'],
  ['morning', '到明早 9 点'],
]

/** 截止时间：今天只写时分，明天带「明天」，再往后带日期；和菜单栏一致 */
export function pauseLabel(at: number, now = new Date()) {
  const date = new Date(at * 1000)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(date) - day(now)) / 86400000)
  if (diff === 0) return time
  if (diff === 1) return `明天 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

// 暂停提醒：消息照收，不弹通知、不响；到点由 Rust 恢复并推新快照，这里不计时
// 侧栏标题旁的一个图标，和菜单栏一致：平时铃铛，暂停时带斜杠的铃铛、琥珀色
// 没暂停时平时隐藏（仍占位，标题不跳），鼠标移到标题这一行才出现；暂停中一直显示，当作状态提示
// 点击切换（暂停默认的 30 分钟 / 恢复），悬停展开菜单：暂停时顶部写截止时间，下面是各档时长
export function PauseControl(props: {
  until: number
  onPause: (preset: PausePreset) => void
  onResume: () => void
}) {
  const paused = props.until > 0
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next, details) => {
        // 按下按钮不开关菜单，由下面的 onClick 切换暂停
        if (details.reason === 'trigger-press') return
        setOpen(next)
      }}
    >
      <DropdownMenuTrigger
        openOnHover
        delay={150}
        // 菜单在 mousedown 时开关，且悬停展开后 0.5 秒内的按下会被忽略（Base UI 的 stickIfOpen），
        // 所以拦掉 Base UI 的按下处理，自己在 click 里切换
        onMouseDown={(event) => event.preventBaseUIHandler?.()}
        onClick={() => {
          setOpen(false)
          if (paused) props.onResume()
          else props.onPause('30m')
        }}
        render={
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={paused ? '恢复提醒' : '暂停提醒 30 分钟'}
            // 按钮左右各有内边距，往左收一点，让铃铛和文字的间距与 logo 和文字一致
            className={`-ml-1.5 ${
              paused
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100'
            }`}
          />
        }
      >
        {paused ? <BellOff /> : <Bell />}
      </DropdownMenuTrigger>
      <DropdownMenuContent side='bottom' align='end' className='w-auto'>
        {paused && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>已暂停至 {pauseLabel(props.until)}</DropdownMenuLabel>
              <DropdownMenuItem onClick={props.onResume}>恢复提醒</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{paused ? '改为' : '暂停提醒'}</DropdownMenuLabel>
          {presets.map(([id, label]) => (
            <DropdownMenuItem key={id} onClick={() => props.onPause(id)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
