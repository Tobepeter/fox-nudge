import type { CSSProperties } from 'react'
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

// 复用 FoxDeck 的 shadcn Sonner，主题由应用设置传入
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className='toaster group'
      icons={{
        success: <CircleCheckIcon className='size-4' />,
        info: <InfoIcon className='size-4' />,
        warning: <TriangleAlertIcon className='size-4' />,
        error: <OctagonXIcon className='size-4' />,
        loading: <Loader2Icon className='size-4 animate-spin' />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          // PATCH：弹窗会禁用外部指针事件，通知仍需支持关闭和撤销
          pointerEvents: 'auto',
        } as CSSProperties
      }
      {...props}
      closeButton
      toastOptions={{
        ...props.toastOptions,
        closeButtonAriaLabel: '关闭通知',
        // sonner 自带的按钮是黑白灰阶，换成应用主题色；它的样式优先级高，用 ! 覆盖
        classNames: {
          actionButton: 'bg-primary! text-primary-foreground! hover:bg-primary/80!',
          closeButton:
            'border-border! bg-popover! text-muted-foreground! hover:bg-muted! hover:text-foreground!',
          ...props.toastOptions?.classNames,
        },
      }}
    />
  )
}
