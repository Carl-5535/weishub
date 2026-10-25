import { open, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from './types.js'

/** 一次可绑定的既有会话。source: mtime 早于 hub 状态时间视为 IDE（VS Code 等）创建。 */
export interface SessionInfo {
  id: string
  title: string
  mtime: number
  source: 'hub' | 'ide'
}

const DEFAULT_LIMIT = 10
const TITLE_MAX = 40
/** 标题/元信息都在文件开头几行，读头部足矣；多 MB 的会话文件绝不全量读。 */
const HEAD_BYTES = 64 * 1024

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function toSource(mtime: number, hubSince?: number): 'hub' | 'ide' {
  return hubSince !== undefined && mtime < hubSince ? 'ide' : 'hub'
}

/** 只读文件前 HEAD_BYTES 字节。末行可能被截断（JSON.parse 失败即跳过，无害）。 */
async function readHead(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** 排序前的廉价候选：mtime 来自 stat，标题与 codex 的 meta id 延后解析。 */
interface Candidate {
  id: string
  file: string
  mtime: number
  source: 'hub' | 'ide'
}

/**
 * 发现既有 agent 会话（含 IDE 创建的），按 mtime 降序，默认取 10 条。
 * title 取首条用户文本消息的前 40 字符；目录不存在时返回 []，绝不抛错。
 */
export async function listSessions(
  config: AgentConfig,
  limit: number = DEFAULT_LIMIT,
  hubSince?: number,
): Promise<SessionInfo[]> {
  const ls = config.listSessions
  if (!ls) return []
  const root = expandHome(ls.store)

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  // 先只做 readdir + stat 收集候选，排序取前 limit 条后才读文件内容：
  // 会话文件动辄几 MB，为展示 10 条标题去全量读几百个文件会长时间卡住 /sessions 回复。
  const candidates: Candidate[] = []
  if (ls.kind === 'claude') {
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, e.name)
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const fp = join(dir, f)
        const st = await stat(fp).catch(() => null)
        if (!st?.isFile()) continue
        candidates.push({ id: f.slice(0, -'.jsonl'.length), file: fp, mtime: st.mtimeMs, source: toSource(st.mtimeMs, hubSince) })
      }
    }
  } else {
    // codex：store 下按 YYYY/MM/DD 日期目录递归找 rollout-*.jsonl。
    // 注意：结构未实测（本机 ~/.codex/sessions 为空），依据公开文档格式，待真机会话产生后校准。
    await collectCodex(root, candidates, hubSince)
  }

  candidates.sort((a, b) => b.mtime - a.mtime)
  const sessions: SessionInfo[] = []
  for (const c of candidates.slice(0, limit)) {
    if (ls.kind === 'claude') {
      sessions.push({ id: c.id, title: await claudeTitle(c.file), mtime: c.mtime, source: c.source })
    } else {
      const meta = await codexMeta(c.file, c.id)
      sessions.push({ id: meta.id, title: meta.title, mtime: c.mtime, source: c.source })
    }
  }
  return sessions
}

// ---- claude ----
// 实测结构（~/.claude/projects/<路径斜杠转连字符>/<sessionId>.jsonl）：
// 每行一个 JSON 对象；首条用户消息所在行形如
// {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},...}
// content 也可能是字符串（旧版本）或 [{type:"tool_result",...}]（须跳过）；
// 文件开头还可能出现 {"type":"queue-operation",...} 行，同样跳过。

async function claudeTitle(file: string): Promise<string> {
  const raw = await readHead(file)
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(obj) || obj.type !== 'user') continue
    const message = obj.message
    if (!isRecord(message)) continue
    const text = extractText(message.content)
    if (text) return text.slice(0, TITLE_MAX)
  }
  return ''
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim()
      if (t) return t
    }
  }
  return ''
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// ---- codex ----
// 结构未实测，按公开文档：sessions/YYYY/MM/DD/rollout-*.jsonl，
// 首行 {"type":"session_meta","payload":{"id":"<uuid>",...}}，
// 用户消息行 {"type":"event_msg","payload":{"type":"user_message","message":"..."}}。

async function collectCodex(
  dir: string,
  out: Candidate[],
  hubSince?: number,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) {
      await collectCodex(fp, out, hubSince)
      continue
    }
    if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
    const st = await stat(fp).catch(() => null)
    if (!st) continue
    // id 的权威值在文件内 session_meta，但文件名里就有同一 uuid；排序阶段先用
    // 文件名兜底，只有进了前 limit 名才读文件核对（codexMeta）。
    const fallbackId = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(fp)?.[1] ?? fp
    out.push({ id: fallbackId, file: fp, mtime: st.mtimeMs, source: toSource(st.mtimeMs, hubSince) })
  }
}

async function codexMeta(file: string, fallbackId: string): Promise<{ id: string; title: string }> {
  const raw = await readHead(file)
  let id = ''
  let title = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue
    if (!id && obj.type === 'session_meta' && isRecord(obj.payload)) {
      const pid = obj.payload.id
      if (typeof pid === 'string') id = pid
    }
    if (!title && obj.type === 'event_msg' && isRecord(obj.payload)) {
      const p = obj.payload
      if (p.type === 'user_message' && typeof p.message === 'string') {
        title = p.message.trim().slice(0, TITLE_MAX)
      }
    }
    if (id && title) break
  }
  return { id: id || fallbackId, title }
}
