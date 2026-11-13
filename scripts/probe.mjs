// 桌面开发版探针：把表达式发给 Rust 的本机调试入口，在主窗口求值后输出 JSON
// d 指代 window.__DEBUG__，常用：snapshot、inject、send、disconnect、wait
const port = process.env.FOX_NUDGE_PROBE_PORT || 5193
const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'))
const [command = 'snapshot', ...rest] = argv
const text = rest.join(' ')
const app = 'd.nudge.app'
const expressions = {
  snapshot: `${app}.snapshot()`,
  ready: `${app}.ready()`,
  eval: text,
  inject: `(async () => { await ${app}.actions.inject({ body: ${JSON.stringify(text || '调试消息')}, senderName: '探针' }); return ${app}.snapshot() })()`,
  'inject-encrypted': `(async () => { await ${app}.actions.inject({ body: ${JSON.stringify(text || '加密调试消息')}, senderName: '探针', encrypted: true }); return ${app}.snapshot() })()`,
  send: `${app}.actions.send(${JSON.stringify(text || '探针测试消息')})`,
  roundtrip: `${app}.actions.roundtrip(${JSON.stringify(text || '探针往返测试')})`,
  disconnect: `${app}.actions.disconnect()`,
  wait: `${app}.actions.waitConnected(${Number(text) || 15000})`,
  navigate: `(async () => { ${app}.actions.navigate(${JSON.stringify(text || 'send')}); return ${app}.snapshot() })()`,
  reload: `(location.reload(), true)`,
}
const expression = expressions[command]
if (!expression) {
  console.error(`未知命令 ${command}，可用：${Object.keys(expressions).join(' ')}`)
  process.exit(2)
}
try {
  const response = await fetch(`http://127.0.0.1:${port}/eval`, { method: 'POST', body: expression })
  const result = await response.json()
  console.log(JSON.stringify(result.ok ? result.value : { error: result.error }, null, 2))
  process.exit(result.ok ? 0 : 1)
} catch (e) {
  console.error(`连不上探针（127.0.0.1:${port}），先运行 pnpm dev：${e.message}`)
  process.exit(1)
}
