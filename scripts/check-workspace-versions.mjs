/**
 * 发布防呆：workspace 依赖用的是精确版本号（npm workspaces 的常规做法），
 * 意味着所有包必须同版本步进，漏改一处就会发布出指向不存在版本的包。
 * CI 里跑这个脚本挡住版本漂移。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const packages = ['channel-wechat', 'core', 'weishub', 'skills'].map((name) => {
  const manifest = JSON.parse(readFileSync(join(root, '..', 'packages', name, 'package.json'), 'utf8'))
  return manifest
})

const versions = new Set(packages.map((p) => p.version))
if (versions.size !== 1) {
  console.error(`各包 version 不一致：${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`)
  process.exit(1)
}
const version = packages[0].version

let failed = false
for (const p of packages) {
  for (const dep of Object.keys(p.dependencies ?? {})) {
    if (!dep.startsWith('@weishub/')) continue
    if (p.dependencies[dep] !== version) {
      console.error(`${p.name} 依赖 ${dep}@${p.dependencies[dep]}，与统一版本 ${version} 不一致`)
      failed = true
    }
  }
}
if (failed) process.exit(1)
console.log(`workspace 版本一致：${version}`)
