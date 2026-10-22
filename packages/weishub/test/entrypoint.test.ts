import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isEntrypoint } from '../src/entrypoint.js'

/** 回归：npm 全局 bin 是指向 lib/*.js 的符号链接，argv[1] 必须 realpath 后比较。 */
describe('isEntrypoint', () => {
  async function makeScriptWithSymlink(): Promise<{ script: string; link: string; url: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'weishub-entry-'))
    const script = join(dir, 'cli.js')
    await writeFile(script, 'export {}\n')
    const link = join(dir, 'weishub-link')
    await symlink(script, link)
    // import.meta.url 是 realpath（macOS 上 /var/... 会解析为 /private/var/...）
    return { script, link, url: pathToFileURL(await realpath(script)).href }
  }

  it('argv[1] 为指向脚本的符号链接时判定为入口（npm bin 形态）', async () => {
    const { link, url } = await makeScriptWithSymlink()
    expect(isEntrypoint(link, url)).toBe(true)
  })

  it('argv[1] 为脚本真实路径时判定为入口', async () => {
    const { script, url } = await makeScriptWithSymlink()
    expect(isEntrypoint(script, url)).toBe(true)
  })

  it('argv[1] 指向别的文件时不是入口', async () => {
    const { link, url } = await makeScriptWithSymlink()
    const other = link + '-other'
    await writeFile(other, 'export {}\n')
    expect(isEntrypoint(other, url)).toBe(false)
  })

  it('argv[1] 不存在时不抛错且不是入口', () => {
    expect(isEntrypoint('/nonexistent/weishub-bin', 'file:///x/cli.js')).toBe(false)
  })

  it('argv[1] 缺省时不是入口', () => {
    expect(isEntrypoint(undefined, 'file:///x/cli.js')).toBe(false)
  })
})
