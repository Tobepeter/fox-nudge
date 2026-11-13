import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
export type ChoiceProps = {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  // 鼠标停在选项上时回调，比如试听提示音
  onHover?: (value: string) => void
}
export function Choice(props: ChoiceProps) {
  return (
    <Select
      value={props.value}
      // 触发器显示选项名称而不是值
      items={props.options}
      onValueChange={(value) => value !== null && props.onChange(value)}
      disabled={props.disabled}
    >
      <SelectTrigger aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((item) => (
          <SelectItem key={item.value} value={item.value} onPointerEnter={() => props.onHover?.(item.value)}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
