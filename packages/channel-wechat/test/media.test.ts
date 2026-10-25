import { describe, expect, it } from 'vitest'
import {
  classifyOutbound,
  decryptMedia,
  detectLocalFilePaths,
  encryptMedia,
  extractFileDirectives,
  paddedSize,
  pruneInboundMedia,
  resolveWorkspaceFile,
  safeFileName,
  saveInboundMedia,
  splitText,
} from '../src/media.js'
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

describe('splitText', () => {
  it('按码点切分，不劈开代理对字符', () => {
    const text = '😀😅🙄'.repeat(3)
    const chunks = splitText(text, 3)
    expect(chunks).toHaveLength(3)
    expect(chunks.every(chunk => Array.from(chunk).length === 3)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })

  it('短文本返回单块', () => {
    expect(splitText('hello', 10)).toEqual(['hello'])
  })

  it('空文本返回空数组', () => {
    expect(splitText('', 10)).toEqual([])
  })
})

describe('extractFileDirectives', () => {
  it('提取独立成行的 send-file 指令并从文本中移除', () => {
    const result = extractFileDirectives('结果如下。\n[[send-file: report.pdf]]\n完毕')
    expect(result.files).toEqual(['report.pdf'])
    expect(result.text.replace(/\n+/g, '\n')).toBe('结果如下。\n完毕')
  })

  it('支持绝对路径与多个指令', () => {
    const result = extractFileDirectives('[[send-file: /tmp/a.png]]\n正文\n[[send-file:b/c.txt]]')
    expect(result.files).toEqual(['/tmp/a.png', 'b/c.txt'])
    expect(result.text).toBe('正文')
  })

  it('普通 Markdown 链接不会被当作外发请求', () => {
    const result = extractFileDirectives('参见 [报告](report.pdf) 与 https://example.com/x.png')
    expect(result.files).toEqual([])
    expect(result.text).toContain('[报告](report.pdf)')
  })

  it('行内（非独立行）指令不生效', () => {
    const result = extractFileDirectives('前缀 [[send-file:x.txt]] 后缀')
    expect(result.files).toEqual([])
    expect(result.text).toContain('[[send-file:x.txt]]')
  })
})

describe('detectLocalFilePaths（正文提及的本地文件）', () => {
  it('Windows 盘符路径（含空格与中文标点语境）', () => {
    const text = '已生成图标：\n本地文件: C:\\Users\\carl.chen.TRTECH\\dsh-weixin-gateway-icon.png，请查收。'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\Users\\carl.chen.TRTECH\\dsh-weixin-gateway-icon.png'])
  })

  it('含空格的路径整体匹配', () => {
    const text = '结果在 C:\\Users\\John Smith\\my report.pdf 这里'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\Users\\John Smith\\my report.pdf'])
  })

  it('POSIX 绝对路径', () => {
    expect(detectLocalFilePaths('输出：/home/alice/out/report.md 已就绪')).toEqual(['/home/alice/out/report.md'])
  })

  it('URL 不匹配（协议与域名部分不当作路径）', () => {
    const text = '图标 URL: https://platform-outputs.agnes-ai.space/images/t2i/275baa6aab3a45ffa191356ca7bec48c.png'
    expect(detectLocalFilePaths(text)).toEqual([])
  })

  it('无扩展名或目录不匹配', () => {
    expect(detectLocalFilePaths('日志目录是 D:\\logs\\today 而非 D:\\logs')).toEqual([])
    expect(detectLocalFilePaths('盘符 C:\\ 本身')).toEqual([])
  })

  it('同一路径去重、多路径按序返回', () => {
    const text = 'C:\\a\\x.png 与 C:\\a\\x.png，还有 /tmp/b.txt'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\a\\x.png', '/tmp/b.txt'])
  })

  it('大小写不同的写法视为同一路径', () => {
    expect(detectLocalFilePaths('C:\\Out\\A.png 与 c:\\out\\a.png')).toEqual(['C:\\Out\\A.png'])
  })

  it('引号与括号内的路径可提取，行尾句号不并入', () => {
    const text = '见 "C:\\out\\图标.png".（另见 /tmp/z.jpeg）'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\out\\图标.png', '/tmp/z.jpeg'])
  })
})

describe('媒体加解密', () => {
  it('AES-128-ECB 加解密往返一致', () => {
    const key = randomBytes(16)
    const data = Buffer.from('微信媒体加密测试 · WeChat media payload 📎', 'utf8')
    const ciphertext = encryptMedia(data, key)
    expect(ciphertext.byteLength).toBe(paddedSize(data.byteLength))
    // base64(16B key) 形态
    expect(decryptMedia(ciphertext, key.toString('base64'))).toEqual(data)
    // base64(hex32) 形态
    expect(decryptMedia(ciphertext, Buffer.from(key.toString('hex')).toString('base64'))).toEqual(data)
  })

  it('非法密钥被拒绝', () => {
    const ciphertext = encryptMedia(Buffer.from('x'), randomBytes(16))
    expect(() => decryptMedia(ciphertext, Buffer.from('short').toString('base64'))).toThrow(/密钥/)
  })

  it('密文损坏（截断/非块对齐）被拒绝而不是返回垃圾', () => {
    const key = randomBytes(16)
    const ciphertext = encryptMedia(Buffer.from('完整的一段密文', 'utf8'), key)
    // 截掉一半：不再是完整的块序列
    expect(() => decryptMedia(ciphertext.slice(0, 8), key.toString('base64'))).toThrow()
    // 非块对齐长度
    expect(() => decryptMedia(ciphertext.slice(0, ciphertext.byteLength - 3), key.toString('base64'))).toThrow()
  })
})

describe('safeFileName', () => {
  it('剥离路径成分与非法字符', () => {
    expect(safeFileName('../../etc/passwd', 'fallback.bin')).toBe('passwd')
    expect(safeFileName('a/b/报告 v1.2.pdf', 'fallback.bin')).toBe('报告 v1.2.pdf')
    expect(safeFileName('   ', 'fallback.bin')).toBe('fallback.bin')
    expect(safeFileName('..', 'fallback.bin')).toBe('fallback.bin')
  })
})

describe('classifyOutbound', () => {
  it('按扩展名分流', () => {
    expect(classifyOutbound('a.png')).toBe('image')
    expect(classifyOutbound('b.mp4')).toBe('video')
    expect(classifyOutbound('c.pdf')).toBe('file')
  })
})

describe('resolveWorkspaceFile', () => {
  it('工作区内的文件正常解析并返回内容', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'weishub-wsfile-'))
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'ok.txt'), '内容')
    const result = await resolveWorkspaceFile(ws, 'ok.txt', 1024)
    expect(result.name).toBe('ok.txt')
    expect(result.bytes.toString('utf8')).toBe('内容')
  })

  it('工作区外路径被拒绝', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'weishub-wsfile-'))
    await expect(resolveWorkspaceFile(ws, '../outside.txt', 1024)).rejects.toThrow(/工作区/)
    await expect(resolveWorkspaceFile(ws, '/etc/passwd', 1024)).rejects.toThrow(/工作区/)
  })

  it('工作区内指向外部的符号链接被拒绝（防逃逸）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'weishub-wsfile-'))
    const outside = await mkdtemp(join(tmpdir(), 'weishub-outside-'))
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, '机密')
    await symlink(secret, join(ws, 'leak.txt'))
    await expect(resolveWorkspaceFile(ws, 'leak.txt', 1024)).rejects.toThrow(/工作区/)
  })

  it('超过大小上限被拒绝', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'weishub-wsfile-'))
    await writeFile(join(ws, 'big.bin'), Buffer.alloc(100))
    await expect(resolveWorkspaceFile(ws, 'big.bin', 10)).rejects.toThrow(/限制/)
  })

  it('目录被拒绝（只发普通文件）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'weishub-wsfile-'))
    await mkdir(join(ws, 'sub'))
    await expect(resolveWorkspaceFile(ws, 'sub', 1024)).rejects.toThrow(/普通文件/)
  })
})

describe('saveInboundMedia', () => {
  it('落盘到 16 位十六进制聊天目录，文件名安全且内容一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weishub-media-'))
    const path = await saveInboundMedia(root, 'chat-1', {
      kind: 'image', name: '../../evil name.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]),
    })
    const dir = dirname(path)
    expect(basename(dir)).toMatch(/^[0-9a-f]{16}$/)
    expect(basename(path)).not.toContain('..')
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]))
  })
})

describe('pruneInboundMedia', () => {
  it('删除超龄入站媒体，保留新文件与非媒体目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weishub-prune-'))
    const chatDir = join(root, '0123456789abcdef')
    await mkdir(chatDir, { recursive: true })
    const oldFile = join(chatDir, '1000000000000-abcd-old.png')
    const newFile = join(chatDir, '9999999999999-ef01-new.png')
    await writeFile(oldFile, 'old')
    await writeFile(newFile, 'new')
    // 修正 mtime：oldFile 设为很久以前
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(oldFile, old, old)
    // 非十六进制目录里的 agent 产物不得被碰
    const agentDir = join(root, 'project')
    await mkdir(agentDir, { recursive: true })
    const agentFile = join(agentDir, 'build-output.txt')
    await writeFile(agentFile, 'keep')

    const pruned = await pruneInboundMedia(root, 30 * 24 * 60 * 60 * 1000)
    expect(pruned).toBe(1)
    await expect(access(oldFile)).rejects.toThrow()
    await access(newFile) // 新文件不该被删
    await access(agentFile) // agent 文件不该被删
  })
})
