import { useCallback, useLayoutEffect, useRef, type ComponentProps, type Ref } from 'react'
import { Textarea } from './ui/textarea'

export type AutoTextareaProps = ComponentProps<'textarea'> & {
  /** 最多长到几行，超出后内部滚动 */
  maxRows?: number
  /** Enter 提交，Shift+Enter 换行；输入法组字时的 Enter 不算 */
  onSubmit?: () => void
}

// 平时一行，随内容长高，到上限后不再长高、改为内部滚动
export function AutoTextarea({ maxRows = 6, onSubmit, onKeyDown, style, ref, value, ...props }: AutoTextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el
      assign(ref, el)
    },
    [ref],
  )
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const css = getComputedStyle(el)
    const line = parseFloat(css.lineHeight) || 20
    const chrome =
      parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth)
    const max = line * maxRows + chrome
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth), max)
    el.style.height = `${Math.max(next, line + chrome)}px`
    el.style.overflowY = el.scrollHeight + chrome > max ? 'auto' : 'hidden'
  }, [value, maxRows])
  return (
    <Textarea
      {...props}
      ref={setRef}
      value={value}
      rows={1}
      style={{ minHeight: 0, resize: 'none', ...style }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || !onSubmit) return
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onSubmit()
        }
      }}
    />
  )
}

function assign<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T | null }).current = value
}
