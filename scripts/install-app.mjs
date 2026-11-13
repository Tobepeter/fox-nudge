// 覆盖安装到 /Applications，不备份旧包；安装前先退出正在运行的 FoxNudge
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const source = 'src-tauri/target/release/bundle/macos/FoxNudge.app'
const target = '/Applications/FoxNudge.app'
if (!existsSync(source)) {
  console.error('先运行 pnpm build:desktop')
  process.exit(1)
}
try {
  execFileSync('osascript', ['-e', 'tell application id "com.tobe.fox-nudge" to quit'], { stdio: 'ignore' })
} catch {}
execFileSync('rm', ['-rf', target])
execFileSync('ditto', [source, target])
console.log(`已安装 ${target}`)
