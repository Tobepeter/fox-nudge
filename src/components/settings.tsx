import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Copy, Dices, Play } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Choice } from './choice'
import { ConfirmAction } from './confirm-action'
import { HelpTip } from './help-tip'
import { ThemeToggle } from './theme-toggle'
import { Tip } from './tip'
import { sounds } from '../lib/initial'
import { api, desktop, type Settings as SettingsData, type Snapshot } from '../lib/runtime'

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
      <h3 className='text-xs text-muted-foreground'>{props.title}</h3>
      {props.children}
    </section>
  )
}

// 失焦或回车保存，Esc 还原
function TextSetting(props: {
  value: string
  onSave: (value: string) => void
  placeholder?: string
  disabled?: boolean
  maxLength?: number
}) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  return (
    <Input
      value={value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      className='w-60'
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== props.value && props.onSave(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setValue(props.value)
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
  const placeholder = props.source === 'custom' ? '已设置' : props.source === 'builtin' ? '已内置' : props.empty
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
            onClick={() => void props.run(async () => setValue(await api.generateKey()))}
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
                .then(() => toast.success('已复制', { id: 'copy-key', duration: 1500 }))
                .catch(() => toast.error('复制失败', { id: 'copy-key' }))
            }
          >
            <Copy />
          </Button>
        </Tip>
      )}
      {value.trim() ? (
        <Button variant='ghost' disabled={props.disabled} onClick={() => void save(value)}>
          保存
        </Button>
      ) : (
        props.source === 'custom' && (
          <Button variant='ghost' disabled={props.disabled} onClick={() => void save('')}>
            清除
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

export function Settings(props: {
  snapshot: Snapshot
  disabled: boolean
  save: (settings: SettingsData) => Promise<boolean>
  run: (work: () => Promise<unknown>) => Promise<boolean>
}) {
  const { snapshot, disabled } = props
  const settings = snapshot.settings
  const set = (patch: Partial<SettingsData>) => void props.save({ ...settings, ...patch })
  const pressed = 'px-3 data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground'
  return (
    <div className='max-w-xl space-y-5 pb-4'>
      <h2 className='font-medium'>设置</h2>
      <Section title='通用'>
        <Row label='昵称'>
          <TextSetting value={snapshot.identity.name} maxLength={24} disabled={disabled} onSave={(name) => void props.run(() => api.saveIdentity(name))} />
        </Row>
        <Row label='快捷键' help='在任何地方打开发送页，留空不注册'>
          <TextSetting value={settings.shortcut} placeholder='Control+Alt+N' disabled={disabled} onSave={(shortcut) => set({ shortcut: shortcut.trim() })} />
        </Row>
        <Row label='外观'>
          <ThemeToggle value={settings.theme} disabled={disabled} onChange={(theme) => set({ theme })} />
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
        <Row label='登录时启动' help={snapshot.dev ? '开发版不注册' : undefined}>
          <Switch checked={settings.launchAtLogin} disabled={disabled || snapshot.dev} onCheckedChange={(launchAtLogin) => set({ launchAtLogin })} />
        </Row>
      </Section>
      <Section title='服务器'>
        <Row label='地址'>
          <TextSetting value={settings.server} placeholder='https://notify.tobeei.com' disabled={disabled} onSave={(server) => set({ server })} />
        </Row>
        <Row label='主题' help='同一主题的设备都会收到'>
          <TextSetting value={settings.topic} placeholder='notify-main' maxLength={64} disabled={disabled} onSave={(topic) => set({ topic })} />
        </Row>
        <Row label='访问令牌'>
          <SecretSetting kind='token' source={snapshot.tokenSource} empty='tk_…' disabled={disabled} run={props.run} />
        </Row>
        <Row label='订阅方式' help='长连接实时收到；轮询定时拉取，长连接不稳时用'>
          {settings.mode === 'poll' && (
            <Choice
              label='轮询间隔'
              value={String(settings.pollSeconds)}
              options={[30, 60, 120, 300].map((s) => ({ value: String(s), label: s < 60 ? `${s} 秒` : `${s / 60} 分钟` }))}
              onChange={(v) => set({ pollSeconds: Number(v) })}
              disabled={disabled}
            />
          )}
          <ToggleGroup value={[settings.mode]} onValueChange={([mode]) => mode && set({ mode })} variant='outline' size='sm' spacing={0} disabled={disabled}>
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
          <Switch checked={settings.encrypt} disabled={disabled} onCheckedChange={(encrypt) => set({ encrypt })} />
        </Row>
        <Row label='共享密钥' help='每台电脑填同一个'>
          <SecretSetting kind='key' source={snapshot.keySource} empty='粘贴或生成' disabled={disabled} run={props.run} generate />
        </Row>
      </Section>
      <Section title='提醒'>
        <Row label='系统通知'>
          <Button variant='ghost' size='sm' disabled={disabled} onClick={() => void props.run(api.testNotification)}>
            测试
          </Button>
          <Switch checked={settings.notify} disabled={disabled} onCheckedChange={(notify) => set({ notify })} />
        </Row>
        <Row label='提示音'>
          <Tip content='试听'>
            <Button
              variant='ghost'
              size='icon'
              aria-label='试听'
              disabled={disabled || settings.sound === 'none'}
              onClick={() => void props.run(() => api.testSound(settings.sound))}
            >
              <Play />
            </Button>
          </Tip>
          <Choice label='提示音' value={settings.sound} options={sounds} onChange={(sound) => set({ sound })} disabled={disabled} />
        </Row>
      </Section>
      <div className='flex flex-wrap gap-2 pt-1'>
        <Button variant='outline' disabled={!desktop} onClick={() => void props.run(api.openLogs)}>
          打开调试日志
        </Button>
        <Button variant='outline' disabled={disabled} onClick={() => void props.run(api.reconnect)}>
          重新连接
        </Button>
        <ConfirmAction
          label='重置设置'
          description='恢复默认设置？昵称、文案、历史、令牌和密钥会保留'
          success='已恢复默认设置'
          disabled={disabled}
          onConfirm={() => props.run(api.resetSettings)}
        />
        <ConfirmAction
          label='清除数据'
          description='删除设置、文案、历史、令牌、密钥和日志，回到首次安装状态？此操作无法撤销'
          success='已清除全部数据'
          disabled={disabled}
          trigger={
            <Button variant='outline' className='text-destructive' disabled={disabled}>
              清除数据
            </Button>
          }
          onConfirm={() => props.run(api.wipeData)}
        />
      </div>
      <p className='text-xs text-muted-foreground'>
        {snapshot.version}
        {snapshot.dev ? ' dev' : ''} · {snapshot.identity.id}
      </p>
    </div>
  )
}
