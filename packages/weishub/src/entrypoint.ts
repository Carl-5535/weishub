/**
 * CLI 入口判定：`node <bin-path>` 直接运行时才执行主逻辑，测试 import 时跳过。
 *
 * argv[1] 可能是符号链接（npm 全局安装的 bin 就是链接到 lib/*.js），
 * 而 import.meta.url 是 realpath——必须 realpath 后比较，否则 npm i -g 后
 * `weishub --help` 会静默不执行主逻辑。
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** argv[1] 经 realpath 后与模块自身 URL 相同即认为是入口调用。 */
export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href
  } catch {
    // argv[1] 指向不存在的路径等异常：按非入口处理
    return false
  }
}
