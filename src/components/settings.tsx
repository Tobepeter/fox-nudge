import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Copy, Dices } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Choice } from './choice'
import { AvatarPicker } from './avatar-picker'
import { ClearableInput } from './clearable-input'
import { ConfirmAction } from './confirm-action'
import { HelpTip } from './help-tip'
import { ThemeToggle } from './theme-toggle'
import { Tip } from './tip'
import { sounds } from '../lib/initial'
import { ANONYMOUS, cleanName, hasName, NAME_LIMIT } from '../lib/avatar-text'
import {
  api,
  desktop,
  type Settings as SettingsData,
  type Snapshot,
} from '../lib/runtime'

// 覆盖型设置的占位：用内置值时只显示「已内置」，不暴露具体内容
const sourceText = (source: string) =>
  source === 'builtin' ? '已内置' : '未设置'

const pressed =
  'px-3 data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground'

function Row(props: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className='flex min-h-9 items-center justify-between gap-4'>
      <div className='flex items-center gap-0.5'>
        {props.label}
        {props.help && <HelpTip label={props.label}>{props.help}</HelpTip>}
      </div>
      <div className='flex shrink-0 items-center gap-2'>{props.children}</div>
    </div>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-1'>
      <h3 className='text-muted-foreground'>{props.title}</h3>
      {props.children}
    </section>
  )
}

// 失焦或回车保存，Esc 还原；值等于 fallback 时留空、以灰色占位显示，清空即回到 fallback
function TextSetting(props: {
  value: string
  onSave: (value: string) => void
  fallback?: string
  placeholder?: string
  disabled?: boolean
  maxLength?: number
}) {
  const shown =
    props.fallback !== undefined && props.value === props.fallback
      ? ''
      : props.value
  const [value, setValue] = useState(shown)
  useEffect(() => setValue(shown), [shown])
  const commit = (next: string) => {
    const resolved = next.trim() || props.fallback || ''
    if (resolved !== props.value) props.onSave(resolved)
  }
  return (
    <ClearableInput
      className='w-60'
      value={value}
      disabled={props.disabled}
      placeholder={props.fallback ?? props.placeholder}
      maxLength={props.maxLength}
      onChange={(e) => setValue(e.target.value)}
      onClear={() => setValue('')}
      onBlur={() => commit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing)
          (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setValue(shown)
      }}
    />
  )
}

// 凭据只写不读：界面只知道来源，原值不回传
function SecretSetting(props: {
  kind: 'token' | 'key'
  source: string
  empty: string
  disabled?: boolean
  run: (work: () => Promise<unknown>) => Promise<boolean>
  generate?: boolean
}) {
  const [value, setValue] = useState('')
  const placeholder =
    props.source === 'custom'
      ? '已设置'
      : props.source === 'builtin'
        ? '已内置'
        : props.empty
  async function save(next: string) {
    if (await props.run(() => api.setSecret(props.kind, next))) setValue('')
  }
  return (
    <>
      {props.generate && !value && (
        <Tip content='生成'>
          <Button
            variant='ghost'
            size='icon'
            aria-label='生成'
            disabled={props.disabled}
            onClick={() =>
              void props.run(async () => setValue(await api.generateKey()))
            }
          >
            <Dices />
          </Button>
        </Tip>
      )}
      {props.generate && value && (
        <Tip content='复制'>
          <Button
            variant='ghost'
            size='icon'
            aria-label='复制'
            onClick={() =>
              void navigator.clipboard
                .writeText(value)
                .then(() =>
                  toast.success('已复制', { id: 'copy-key', duration: 1500 }),
                )
                .catch(() => toast.error('复制失败', { id: 'copy-key' }))
            }
          >
            <Copy />
          </Button>
        </Tip>
      )}
      {value.trim() ? (
        <Button
          variant='ghost'
          disabled={props.disabled}
          onClick={() => void save(value)}
        >
          保存
        </Button>
      ) : (
        props.source === 'custom' && (
          <Button
            variant='ghost'
            disabled={props.disabled}
            onClick={() => void save('')}
          >
            恢复内置
          </Button>
        )
      )}
      <Input
        type={props.generate && value ? 'text' : 'password'}
        value={value}
        disabled={props.disabled}
        placeholder={placeholder}
        className='w-60 font-mono'
        autoComplete='off'
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(value)}
      />
    </>
  )
}

type PanelProps = {
  snapshot: Snapshot
  disabled: boolean
  set: (patch: Partial<SettingsData>) => void
  run: (work: () => Promise<unknown>) => Promise<boolean>
}

function General({ snapshot, disabled, set, run }: PanelProps) {
  const settings = snapshot.settings
  const named = hasName(snapshot.identity.name)
  // 悬停在提示音选项上就试听，快速划过时只播最后停住的那个
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const preview = (sound: string) => {
    clearTimeout(timer.current)
    if (sound !== 'none')
      timer.current = setTimeout(
        () => void api.testSound(sound).catch(() => {}),
        150,
      )
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      <Section title='身份'>
        <Row label='昵称'>
          <TextSetting
            value={snapshot.identity.name}
            fallback={ANONYMOUS}
            maxLength={NAME_LIMIT}
            disabled={disabled}
            onSave={(name) => void run(() => api.saveIdentity(cleanName(name)))}
          />
        </Row>
        <Row
          label='头像'
          help={named ? undefined : '设了昵称后可以用名字当头像'}
        >
          <AvatarPicker
            id={snapshot.identity.id}
            name={snapshot.identity.name}
            value={settings.avatarStyle}
            named={named}
            disabled={disabled}
            onChange={(avatarStyle) => set({ avatarStyle })}
          />
        </Row>
      </Section>
      <Section title='提醒'>
        <Row label='系统通知'>
          <Switch
            checked={settings.notify}
            disabled={disabled}
            onCheckedChange={(notify) => {
              set({ notify })
              // 打开时顺手弹一条示例，确认系统通知能出来
              if (notify) void api.testNotification().catch(() => {})
            }}
          />
        </Row>
        <Row
          label='通知样式'
          help='极简只显示消息内容；详细的标题是发送者昵称，右侧带头像（开发版不显示头像）'
        >
          <ToggleGroup
            value={[settings.notifyStyle]}
            onValueChange={([notifyStyle]) =>
              notifyStyle && set({ notifyStyle })
            }
            variant='outline'
            size='sm'
            spacing={0}
            disabled={disabled || !settings.notify}
          >
            <ToggleGroupItem value='minimal' className={pressed}>
              极简
            </ToggleGroupItem>
            <ToggleGroupItem value='full' className={pressed}>
              详细
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label='提示音'>
          <Choice
            label='提示音'
            value={settings.sound}
            options={sounds}
            onChange={(sound) => set({ sound })}
            onHover={preview}
            disabled={disabled}
          />
        </Row>
      </Section>
      <Section title='桌面'>
        <Row label='外观'>
          <ThemeToggle
            value={settings.theme}
            disabled={disabled}
            onChange={(theme) => set({ theme })}
          />
        </Row>
        <Row label='Dock 图标'>
          <Choice
            label='Dock 图标'
            value={settings.dockMode}
            options={[
              { value: 'window', label: '窗口打开时' },
              { value: 'always', label: '始终' },
              { value: 'never', label: '不显示' },
            ]}
            onChange={(dockMode) => set({ dockMode })}
            disabled={disabled}
          />
        </Row>
        <Row
          label='登录时启动'
          help={snapshot.dev ? '开发版不注册' : undefined}
        >
          <Switch
            checked={settings.launchAtLogin}
            disabled={disabled || snapshot.dev}
            onCheckedChange={(launchAtLogin) => set({ launchAtLogin })}
          />
        </Row>
      </Section>
    </>
  )
}

function Advanced({ snapshot, disabled, set, run }: PanelProps) {
  const settings = snapshot.settings
  return (
    <>
      <Section title='服务器'>
        <Row label='地址'>
          <TextSetting
            value={settings.server}
            placeholder={sourceText(snapshot.serverSource)}
            disabled={disabled}
            onSave={(server) => set({ server })}
          />
        </Row>
        <Row label='主题' help='同一主题的设备都会收到'>
          <TextSetting
            value={settings.topic}
            placeholder={sourceText(snapshot.topicSource)}
            maxLength={64}
            disabled={disabled}
            onSave={(topic) => set({ topic })}
          />
        </Row>
        <Row label='访问令牌'>
          <SecretSetting
            kind='token'
            source={snapshot.tokenSource}
            empty='tk_…'
            disabled={disabled}
            run={run}
          />
        </Row>
        <Row
          label='订阅方式'
          help='长连接实时收到；轮询定时拉取，长连接不稳时用'
        >
          {settings.mode === 'poll' && (
            <Choice
              label='轮询间隔'
              value={String(settings.pollSeconds)}
              options={[30, 60, 120, 300].map((s) => ({
                value: String(s),
                label: s < 60 ? `${s} 秒` : `${s / 60} 分钟`,
              }))}
              onChange={(v) => set({ pollSeconds: Number(v) })}
              disabled={disabled}
            />
          )}
          <ToggleGroup
            value={[settings.mode]}
            onValueChange={([mode]) => mode && set({ mode })}
            variant='outline'
            size='sm'
            spacing={0}
            disabled={disabled}
          >
            <ToggleGroupItem value='stream' className={pressed}>
              长连接
            </ToggleGroupItem>
            <ToggleGroupItem value='poll' className={pressed}>
              轮询
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
      </Section>
      <Section title='加密'>
        <Row label='加密' help='关掉后以明文经过服务器'>
          <Switch
            checked={settings.encrypt}
            disabled={disabled}
            onCheckedChange={(encrypt) => set({ encrypt })}
          />
        </Row>
        <Row label='共享密钥' help='每台电脑填同一个'>
          <SecretSetting
            kind='key'
            source={snapshot.keySource}
            empty='粘贴或生成'
            disabled={disabled}
            run={run}
            generate
          />
        </Row>
      </Section>
      <Section title='维护'>
        <div className='flex flex-wrap gap-2 pt-1'>
          <Button
            variant='outline'
            disabled={!desktop}
            onClick={() => void run(api.openLogs)}
          >
            打开调试日志
          </Button>
          <Button
            variant='outline'
            disabled={disabled}
            onClick={() => void run(api.reconnect)}
          >
            重新连接
          </Button>
          <ConfirmAction
            label='重置设置'
            description='恢复默认设置？昵称、文案、历史、令牌和密钥会保留'
            success='已恢复默认设置'
            disabled={disabled}
            onConfirm={() => run(api.resetSettings)}
          />
          <ConfirmAction
            label='清除数据'
            description='删除设置、文案、历史、令牌、密钥和日志，回到首次安装状态？此操作无法撤销'
            success='已清除全部数据'
            disabled={disabled}
            trigger={
              <Button
                variant='outline'
                className='text-destructive'
                disabled={disabled}
              >
                清除数据
              </Button>
            }
            onConfirm={() => run(api.wipeData)}
          />
        </div>
      </Section>
    </>
  )
}

export function Settings(props: {
  snapshot: Snapshot
  disabled: boolean
  save: (settings: SettingsData) => Promise<boolean>
  run: (work: () => Promise<unknown>) => Promise<boolean>
}) {
  const [tab, setTab] = useState('general')
  const panel: PanelProps = {
    snapshot: props.snapshot,
    disabled: props.disabled,
    run: props.run,
    set: (patch) => void props.save({ ...props.snapshot.settings, ...patch }),
  }
  return (
    <div className='max-w-xl space-y-5 pb-4'>
      <div className='flex items-center justify-between'>
        <h2 className='font-medium'>设置</h2>
        <ToggleGroup
          value={[tab]}
          onValueChange={([next]) => next && setTab(next)}
          variant='outline'
          size='sm'
          spacing={0}
          aria-label='设置分页'
        >
          <ToggleGroupItem value='general' className={pressed}>
            通用
          </ToggleGroupItem>
          <ToggleGroupItem value='advanced' className={pressed}>
            高级
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {tab === 'general' ? <General {...panel} /> : <Advanced {...panel} />}
    </div>
  )
}
