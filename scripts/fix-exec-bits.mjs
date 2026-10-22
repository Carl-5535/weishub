/**
 * tsc 重新生成 lib/*.js 时不保留可执行位，带 shebang 的入口
 * （weishub / wx 的全局 bin 符号链接）会变成 Permission denied。
 * 构建后统一补上。
 */
import { chmod, readFile } from 'node:fs/promises'

const entries = ['packages/weishub/lib/cli.js', 'packages/weishub/lib/wx.js']
for (const file of entries) {
  const content = await readFile(file, 'utf8').catch(() => null)
  if (content === null) continue
  if (content.startsWith('#!')) {
    await chmod(file, 0o755)
    console.log(`chmod +x ${file}`)
  }
}
