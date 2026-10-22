/**
 * 启动后自动打开面板。
 *
 * 用系统自带的 opener，不引依赖：
 * - macOS: open
 * - Windows: cmd /c start "" <url>（start 会把第一个参数当窗口标题，故空标题占位）
 * - Linux: xdg-open
 *
 * 失败一律静默吞掉：打不开浏览器不该影响 hub 运行，用户仍可手动访问打印出来的地址。
 * 可通过 WEISHUB_NO_OPEN=1 关闭（无图形环境、远程 SSH、自动化测试都适用）。
 */

import { spawn } from 'node:child_process'

export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

/** 尝试在浏览器打开 url；返回是否真的发起了打开动作（不代表打开成功）。 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  if (process.env.WEISHUB_NO_OPEN === '1' || process.env.WEISHUB_NO_OPEN === 'true') return false
  const { command, args } = openerCommand(url, platform)
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined) // 命令不存在：静默
    child.unref()
    return true
  } catch {
    return false
  }
}
