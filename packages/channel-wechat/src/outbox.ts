import { splitText } from './media.js'

/**
 * 发件箱条目：与前身 state.ts 的 outbox 结构相同，便于将来状态互通。
 * `next` / `nextFile` 是断点：指向下一个待发送的文本块与文件下标，
 * 投递失败耗尽重试后停在原地（不前进、不丢弃），等下次 resumePending 再试。
 */
export interface OutboxItem {
  chunks: string[]
  files: string[]
  next: number
  nextFile: number
}

export interface OutboxDeps {
  /** 发送文本（注入的通道发送原语，失败应抛错） */
  send(chatId: string, text: string): Promise<void>
  /** 发送文件（注入的通道发送原语，失败应抛错） */
  sendFile(chatId: string, path: string): Promise<void>
  /** 单条文本最大字符数，超长文本按此切分 */
  maxChars: number
  /** 发送失败的最大重试次数（不含首次尝试），默认 3 */
  maxRetries?: number
  /** 重试退避间隔毫秒，默认 2000 */
  retryDelayMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * 可靠投递发件箱（纯类，依赖注入 send/sendFile，不缠插件框架）。
 *
 * - 超长文本按 `maxChars` 切分，逐条串行发送，保持顺序；
 * - 文本全部发完后才发文件（按序）；
 * - 发送失败按退避重试，耗尽后条目保留在发件箱（绝不丢失）；
 * - 投递进行中再 enqueue，新内容追加到同一条目尾部（carriedChunks 语义）；
 * - 每个 chat 一条串行投递循环，chat 之间互不阻塞；
 * - 发件箱清空时触发 `onEmpty` 回调。
 */
export class Outbox {
  readonly #items = new Map<string, OutboxItem>()
  readonly #inFlight = new Map<string, Promise<void>>()
  readonly #send: OutboxDeps['send']
  readonly #sendFile: OutboxDeps['sendFile']
  readonly #maxChars: number
  readonly #maxRetries: number
  readonly #retryDelayMs: number
  #emptyCallbacks: Array<() => void> = []

  constructor(deps: OutboxDeps) {
    if (!Number.isInteger(deps.maxChars) || deps.maxChars <= 0) throw new Error('maxChars 必须是正整数')
    this.#send = deps.send
    this.#sendFile = deps.sendFile
    this.#maxChars = deps.maxChars
    this.#maxRetries = deps.maxRetries ?? 3
    this.#retryDelayMs = deps.retryDelayMs ?? 2000
  }

  /**
   * 入队一条待发内容（可附文件）。该 chat 已有投递进行中（或尚有存留条目）
   * 时，新内容追加到同一条目尾部，维持既有顺序；否则新建条目并立即开始投递。
   */
  enqueue(chatId: string, text: string, files: readonly string[] = []): void {
    const chunks = splitText(text, this.#maxChars)
    const existing = this.#items.get(chatId)
    if (existing !== undefined) {
      existing.chunks.push(...chunks)
      existing.files.push(...files)
    } else {
      this.#items.set(chatId, { chunks, files: [...files], next: 0, nextFile: 0 })
    }
    this.#kick(chatId)
  }

  /**
   * 尽力送完指定 chat（缺省为全部 chat）的存留条目；重试耗尽的条目保留，
   * 下次调用再试。对投递进行中的 chat，等待其当前循环结束（含追加内容）。
   */
  async resumePending(chatId?: string): Promise<void> {
    const targets = chatId === undefined
      ? [...this.#items.keys()]
      : this.#items.has(chatId) ? [chatId] : []
    for (const id of targets) {
      const running = this.#inFlight.get(id)
      if (running !== undefined) {
        await running
        continue
      }
      if (!this.#items.has(id)) continue
      const run = this.#startDrain(id)
      await run
    }
  }

  /** 当前发件箱快照（深拷贝，外部修改不影响内部状态）。 */
  pending(): Record<string, OutboxItem> {
    const snapshot: Record<string, OutboxItem> = {}
    for (const [chatId, item] of this.#items) {
      snapshot[chatId] = { chunks: [...item.chunks], files: [...item.files], next: item.next, nextFile: item.nextFile }
    }
    return snapshot
  }

  /** 载入断点快照（如进程重启后从持久化存储恢复），替换当前发件箱内容。 */
  load(snapshot: Record<string, OutboxItem>): void {
    this.#items.clear()
    for (const [chatId, item] of Object.entries(snapshot)) {
      this.#items.set(chatId, {
        chunks: [...item.chunks],
        files: [...item.files],
        next: item.next,
        nextFile: item.nextFile,
      })
    }
  }

  /** 注册发件箱清空回调：每次全部 chat 都送完（发件箱变空）时触发。 */
  onEmpty(cb: () => void): void {
    this.#emptyCallbacks.push(cb)
  }

  /** 该 chat 没有进行中的投递时启动一条串行投递循环。 */
  #kick(chatId: string): void {
    if (this.#inFlight.has(chatId)) return
    if (!this.#items.has(chatId)) return
    void this.#startDrain(chatId)
  }

  #startDrain(chatId: string): Promise<void> {
    const run = this.#drain(chatId).finally(() => { this.#inFlight.delete(chatId) })
    this.#inFlight.set(chatId, run)
    return run
  }

  /** 单 chat 串行投递循环：先送完全部文本块，再按序送文件；失败耗尽重试即停在断点。 */
  async #drain(chatId: string): Promise<void> {
    const item = this.#items.get(chatId)
    if (item === undefined) return
    while (item.next < item.chunks.length) {
      const delivered = await this.#deliverWithRetry(() => this.#send(chatId, item.chunks[item.next]!))
      if (!delivered) return // 重试耗尽：保留断点，绝不丢弃
      item.next += 1
    }
    while (item.nextFile < item.files.length) {
      const delivered = await this.#deliverWithRetry(() => this.#sendFile(chatId, item.files[item.nextFile]!))
      if (!delivered) return
      item.nextFile += 1
    }
    // 全部送达才移除条目：中途崩溃后 resumePending 会续发，代价是极端情况下的重复，换来绝不丢失。
    if (item.next === item.chunks.length && item.nextFile === item.files.length && this.#items.get(chatId) === item) {
      this.#items.delete(chatId)
      if (this.#items.size === 0) {
        for (const cb of this.#emptyCallbacks) cb()
      }
    }
  }

  /** 带退避重试的单次投递：失败后重试至多 maxRetries 次，仍失败返回 false（调用方停在断点）。 */
  async #deliverWithRetry(attempt: () => Promise<void>): Promise<boolean> {
    for (let tries = 0; ; tries += 1) {
      try {
        await attempt()
        return true
      } catch {
        if (tries >= this.#maxRetries) return false
        await sleep(this.#retryDelayMs)
      }
    }
  }
}
