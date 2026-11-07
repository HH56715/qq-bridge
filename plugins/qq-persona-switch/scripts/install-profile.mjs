// 把插件登记进 DSH profile：加一条 link 依赖 + 把包名加进 bundles 列表。
//
// 为什么要有脚本：这两处手改很容易漏（只加依赖不加 bundle 就完全不生效，而且不报错），
// 而且 profile 在启动时解析，改错了要等下一次启动才发现。
//
// 幂等：已经是目标状态时什么都不写。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'qq-persona-switch'

function profileDirFromArgs(argv) {
  const flag = argv.find((arg) => arg.startsWith('--profile='))
  if (flag) return path.resolve(flag.slice('--profile='.length))
  return path.join(os.homedir(), '.dsh', 'profiles', 'web')
}

function pluginDir() {
  // scripts/install-profile.mjs → 插件根目录
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

const profileDir = profileDirFromArgs(process.argv.slice(2))
const manifestPath = path.join(profileDir, 'package.json')

if (!fs.existsSync(manifestPath)) {
  console.error(`找不到 profile 清单：${manifestPath}`)
  console.error('用 --profile=<DSH profile 目录> 指定，例如 --profile=C:/Users/你/.dsh/profiles/web')
  process.exit(1)
}

const raw = fs.readFileSync(manifestPath, 'utf8')
let manifest
try {
  manifest = JSON.parse(raw)
} catch (error) {
  console.error(`profile 清单不是合法 JSON，未做任何修改：${error.message}`)
  process.exit(1)
}

// link: 依赖要写成 URL 风格的正斜杠路径，Windows 反斜杠会被当成转义。
const target = pluginDir().replace(/\\/g, '/')
manifest.dependencies = manifest.dependencies ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []

const changes = []
const existingDep = manifest.dependencies[PACKAGE_NAME]
const desiredDep = `link:${target}`
if (existingDep !== desiredDep) {
  manifest.dependencies[PACKAGE_NAME] = desiredDep
  changes.push(`dependencies["${PACKAGE_NAME}"]: ${existingDep ?? '(无)'} → ${desiredDep}`)
}
if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  manifest.dsh.profile.bundles.push(PACKAGE_NAME)
  changes.push(`bundles: 追加 "${PACKAGE_NAME}"`)
}

if (changes.length === 0) {
  console.log('profile 已经是目标状态，无需修改。')
  process.exit(0)
}

const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(manifestPath, backup)
const next = `${JSON.stringify(manifest, null, 2)}\n`
JSON.parse(next) // 写之前再确认一次可解析
fs.writeFileSync(manifestPath, next, 'utf8')

console.log(`已更新 ${manifestPath}（备份：${backup}）`)
for (const line of changes) console.log(`  · ${line}`)
console.log('')
console.log('重启 DSH 后生效，然后打开 http://127.0.0.1:3080/api/qq-persona-switch')