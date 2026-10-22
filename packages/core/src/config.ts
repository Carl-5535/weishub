/**
 * agent 配置加载：内置 builtin-agents.json + agents.d 目录下的用户覆盖。
 *
 * 合并规则：按 name 匹配，同名条目做逐字段（浅层）覆盖，异名条目追加；
 * 内置条目始终排在最前。校验失败抛出指明文件与字段的中文错误。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '@weishub/channel-wechat'
import builtinJson from './builtin-agents.json' with { type: 'json' }
import type { AgentConfig } from './types.js'

const OUTPUT_FORMATS = ['text', 'claude-json', 'codex-jsonl', 'opencode-jsonl'] as const
const APPROVAL_MODES = ['permission-prompt-tool', 'app-server'] as const

/** 剥离 JSON 中以 $ 开头的注释键（如 $note）。 */
function stripNoteKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('$')) out[key] = value
  }
  return out
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * 校验单个 agent 配置对象，非法时抛中文错误（指明来源文件与字段）。
 * 校验前会剥离 $ 前缀的注释键。
 */
export function validateAgentConfig(raw: unknown, file: string): AgentConfig {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? stripNoteKeys(raw as Record<string, unknown>)
      : null
  if (!obj) {
    throw new Error(`配置文件 ${file} 非法：内容必须是 JSON 对象`)
  }

  const errors: string[] = []
  const requireNonEmptyString = (field: string): void => {
    if (!isNonEmptyString(obj[field])) {
      errors.push(`字段 ${field} 必须是非空字符串`)
    }
  }
  const requireStringArray = (field: string): void => {
    if (!isStringArray(obj[field])) {
      errors.push(`字段 ${field} 必须是字符串数组`)
    }
  }

  requireNonEmptyString('name')
  requireNonEmptyString('detect')
  requireStringArray('run')
  if (isStringArray(obj.run) && obj.run.length === 0) {
    errors.push('字段 run 不能为空数组')
  }
  if (obj.passVia !== 'stdin') {
    errors.push('字段 passVia 目前只支持 "stdin"')
  }
  if (
    typeof obj.outputFormat !== 'string' ||
    !(OUTPUT_FORMATS as readonly string[]).includes(obj.outputFormat)
  ) {
    errors.push(`字段 outputFormat 必须是 ${OUTPUT_FORMATS.map((f) => `"${f}"`).join(' / ')} 之一`)
  }
  // resume/resumeRun 都是可选；提供了就必须是字符串数组
  if (obj.resume !== undefined && !isStringArray(obj.resume)) {
    errors.push('字段 resume 必须是字符串数组')
  }
  if (obj.resumeRun !== undefined && !isStringArray(obj.resumeRun)) {
    errors.push('字段 resumeRun 必须是字符串数组')
  }
  if (
    obj.approval !== null &&
    !(typeof obj.approval === 'string' && (APPROVAL_MODES as readonly string[]).includes(obj.approval))
  ) {
    errors.push(
      `字段 approval 必须是 ${APPROVAL_MODES.map((f) => `"${f}"`).join(' / ')} 之一或 null`,
    )
  }
  const flags = obj.permissionFlags
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) {
    errors.push('字段 permissionFlags 必须是对象')
  } else {
    const rec = flags as Record<string, unknown>
    if (!isStringArray(rec.auto)) errors.push('字段 permissionFlags.auto 必须是字符串数组')
    if (!isStringArray(rec.full)) errors.push('字段 permissionFlags.full 必须是字符串数组')
  }
  if (
    typeof obj.timeoutSec !== 'number' ||
    !Number.isInteger(obj.timeoutSec) ||
    obj.timeoutSec <= 0
  ) {
    errors.push('字段 timeoutSec 必须是正整数')
  }
  if (errors.length > 0) {
    throw new Error(`配置文件 ${file} 非法：${errors.join('；')}`)
  }

  return obj as unknown as AgentConfig
}

/** 读取单个配置文件并校验（保留原始对象，供合并使用）。 */
async function readConfigFile(path: string, file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`配置文件 ${file} 读取失败：${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`配置文件 ${file} 非法：不是有效的 JSON（${(err as Error).message}）`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${file} 非法：内容必须是 JSON 对象`)
  }
  return parsed as Record<string, unknown>
}

/**
 * 加载全部 agent 配置：内置四条目在前，随后是 extraDir（默认
 * dataDir()/agents.d/）内每个 *.json 的合并结果。目录缺失时静默跳过。
 */
export async function loadAgentConfigs(extraDir?: string): Promise<AgentConfig[]> {
  const dir = extraDir ?? join(dataDir(), 'agents.d')

  const merged = new Map<string, AgentConfig>()
  for (const raw of builtinJson as unknown as Record<string, unknown>[]) {
    const config = validateAgentConfig(raw, `builtin-agents.json#${String(raw.name)}`)
    merged.set(config.name, config)
  }

  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [...merged.values()]
    throw new Error(`配置目录 ${dir} 读取失败：${(err as Error).message}`)
  }

  for (const file of files) {
    const raw = stripNoteKeys(await readConfigFile(join(dir, file), file))
    if (!isNonEmptyString(raw.name)) {
      throw new Error(`配置文件 ${file} 非法：字段 name 必须是非空字符串`)
    }
    const base = merged.get(raw.name)
    const combined = base ? { ...base, ...raw } : raw
    merged.set(raw.name, validateAgentConfig(combined, file))
  }

  return [...merged.values()]
}
