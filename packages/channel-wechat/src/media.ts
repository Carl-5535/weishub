/**
 * 微信 CDN 媒体加解密与本地文件工具。
 *
 * iLink 媒体通道使用 AES-128-ECB：上行先加密再上传 CDN，下行下载后解密。
 * ECB 模式无 IV，密钥来自消息体（hex 或 base64 编码的 16 字节）。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type MediaKind = 'image' | 'voice' | 'file' | 'video'

/** 一条已解密的入站媒体。 */
export interface InboundMedia {
  kind: MediaKind
  name: string
  mediaType: string
  data: Uint8Array
}

/** iLink 消息里的 CDN 引用。 */
export interface CdnMediaRef {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

/** 按 16 字节对齐后的密文长度（AES 块大小 + PKCS7 填充）。 */
export function paddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

export function encryptMedia(data: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 解密入站媒体。密钥兼容 base64(16B) 与 base64(hex32) 两种下发形态。 */
export function decryptMedia(data: Uint8Array, encodedKey: string): Buffer {
  const decoded = Buffer.from(encodedKey, 'base64')
  const key = decoded.length === 16
    ? decoded
    : decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))
      ? Buffer.from(decoded.toString('ascii'), 'hex')
      : undefined
  if (key === undefined) throw new Error('微信媒体 AES 密钥无效')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.json': 'application/json',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const DEFAULT_MIME: Readonly<Record<MediaKind, string>> = {
  image: 'application/octet-stream',
  video: 'video/mp4',
  voice: 'audio/silk',
  file: 'application/octet-stream',
}

export function mediaTypeForName(name: string, kind: MediaKind): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? DEFAULT_MIME[kind]
}

/** iLink getuploadurl 的 media_type 取值。 */
export function uploadMediaType(kind: MediaKind): number {
  return { image: 1, video: 2, file: 3, voice: 4 }[kind]
}

/** 去掉路径成分与控制字符，产出安全的展示/落盘文件名。 */
export function safeFileName(input: string, fallback: string): string {
  const cleaned = basename(input)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned.slice(0, 180)
}

/** 依据扩展名推断出站媒体的类型通道。 */
export function classifyOutbound(name: string): MediaKind {
  const mime = mediaTypeForName(name, 'file')
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

/** 把一条入站媒体落盘到媒体目录（按聊天分目录、文件名加时间戳防覆盖），返回绝对路径。 */
export async function saveInboundMedia(root: string, chatKey: string, media: InboundMedia): Promise<string> {
  const directory = join(root, createHash('sha256').update(chatKey).digest('hex').slice(0, 16))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const name = `${Date.now()}-${randomBytes(6).toString('hex')}-${safeFileName(media.name, `${media.kind}.bin`)}`
  const path = join(directory, name)
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(media.data)
    await file.sync()
  } finally {
    await file.close()
  }
  return path
}

/**
 * 解析 Agent 请求发送的文件，并用 realpath 证明它位于工作区内（防符号链接逃逸）。
 * 打开文件描述符后经 fd 读取：打开之后再发生的路径替换（symlink swap）不影响读到的内容。
 */
export async function resolveWorkspaceFile(workspace: string, requested: string, maxBytes: number): Promise<{ path: string; name: string; bytes: Buffer }> {
  const candidate = resolve(workspace, requested)
  // 先做词法边界检查：明显在工作区外的请求不做 realpath（目标不存在时也不误报 ENOENT）
  const lexical = relative(resolve(workspace), candidate)
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error('出站文件必须位于配置的工作区内')
  }
  const workspaceReal = await realpath(workspace)
  const candidateReal = await realpath(candidate)
  const inside = relative(workspaceReal, candidateReal)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('出站文件必须位于配置的工作区内')
  }
  // 经文件描述符 stat + 读取：fd 绑定 inode，路径中途被换成 symlink 也读不到外面
  const file = await open(candidateReal, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('出站附件不是普通文件')
    if (metadata.size > maxBytes) throw new Error(`出站附件超过 ${maxBytes} 字节限制`)
    return { path: candidateReal, name: safeFileName(candidateReal, 'file.bin'), bytes: await file.readFile() }
  } finally {
    await file.close()
  }
}

/**
 * 清理超龄的入站媒体：只碰保存入站媒体用的 16 位十六进制聊天目录，
 * 工作区里 agent 自己的文件一概不动。返回删除的文件数。
 */
export async function pruneInboundMedia(root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let pruned = 0
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0 // 根目录不存在 = 无媒体可清
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{16}$/.test(entry)) continue
    const directory = join(root, entry)
    let files: string[]
    try {
      if (!(await stat(directory)).isDirectory()) continue
      files = await readdir(directory)
    } catch {
      continue
    }
    for (const name of files) {
      const path = join(directory, name)
      try {
        const metadata = await stat(path)
        if (!metadata.isFile()) continue
        if (now - metadata.mtimeMs <= maxAgeMs) continue
        await unlink(path)
        pruned += 1
      } catch {
        // 单个文件失败不影响其余清理
      }
    }
  }
  return pruned
}

/**
 * 提取回复文本中的 [[send-file:路径]] 指令（Agent 显式声明才发文件，
 * 普通 Markdown 链接不会被当作外发请求）。
 */
export function extractFileDirectives(text: string): { text: string; files: string[] } {
  const files: string[] = []
  const output = text
    .replace(/^\s*\[\[send-file:(.+?)\]\]\s*$/gmu, (_match, path: string) => {
      const trimmed = path.trim()
      if (trimmed !== '') files.push(trimmed)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: output, files }
}

/** 路径段允许的字符（含空格与波浪号；不含引号、括号、冒号与中西文标点）。 */
const PATH_SEGMENT = '[\\p{L}\\p{N}\\-_. ~]'
/** Windows 盘符绝对路径（结尾须带扩展名）。 */
const WINDOWS_PATH = new RegExp(`[A-Za-z]:[\\\\/](${PATH_SEGMENT}+[\\\\/])*${PATH_SEGMENT}+\\.[A-Za-z0-9]{1,10}`, 'gu')
/** POSIX 绝对路径（排除 URL：其起始斜杠前面是冒号或另一个斜杠）。 */
const POSIX_PATH = new RegExp(`(?<![A-Za-z]:|[\\\\/])/((${PATH_SEGMENT}+/)*${PATH_SEGMENT}+)\\.[A-Za-z0-9]{1,10}`, 'gu')

/**
 * 提取正文中提及的本地文件绝对路径（Windows 盘符或 POSIX），按出现顺序去重。
 * 只认带扩展名的路径；URL、代码标识符、目录路径不匹配。命中后仍需通过
 * 存在性与工作区边界校验才会真正外发。
 */
export function detectLocalFilePaths(text: string): string[] {
  // 先剔除 URL 整段，避免把网址里的路径部分误当作本地文件（如 https://host/a.png）。
  const withoutUrls = text.replace(/https?:\/\/[^\s"'“”‘’）)】]+/gu, '')
  const seen = new Set<string>()
  const found: string[] = []
  for (const match of withoutUrls.matchAll(WINDOWS_PATH)) {
    const path = match[0]
    const key = path.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      found.push(path)
    }
  }
  for (const match of withoutUrls.matchAll(POSIX_PATH)) {
    const path = match[0]
    const key = path.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      found.push(path)
    }
  }
  return found
}

/** 按字符（而非 UTF-16 码元）切分，避免把 emoji / 生僻字劈成两半。 */
export function splitText(text: string, limit: number): string[] {
  const characters = Array.from(text)
  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''))
  }
  return chunks
}
