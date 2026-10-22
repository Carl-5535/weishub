export interface PendingApproval {
  id: string
  chatId: string
  tool: string
  input: string
  createdAt: number
}

export type ApprovalDecision = 'allow' | 'deny' | 'timeout'

/** 决议后的留存状态：供 resultOf 在决议落定后持续可查（桥轮询依赖这一点）。 */
interface ResolvedEntry {
  decision: ApprovalDecision
  at: number
}

interface PendingEntry {
  approval: PendingApproval
  settle: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

/** 决议留存上限：防止长时间运行的进程无限增长。 */
const RESOLVED_CAP = 512

/**
 * 微信审批路由：agent 的权限请求在此挂起，等微信回复（resolve）或超时。
 * 纯内存，不落盘——重启丢审批可接受，前身同策略。
 */
export class ApprovalRouter {
  readonly #timeoutMs: number
  readonly #pending = new Map<string, PendingEntry>()
  readonly #resolved = new Map<string, ResolvedEntry>()
  #seq = 0

  constructor(deps: { timeoutMs?: number } = {}) {
    this.#timeoutMs = deps.timeoutMs ?? 600_000
  }

  /** 挂起一条审批请求，直到 resolve / cancelChat / 超时 */
  request(chatId: string, tool: string, input: string): Promise<ApprovalDecision> {
    return this.startRequest(chatId, tool, input).done
  }

  /** 同 request，但同步返回 id 与决议 Promise——HTTP 层需要先答 id 再等决议。 */
  startRequest(chatId: string, tool: string, input: string): { id: string; done: Promise<ApprovalDecision> } {
    const id = `ap-${++this.#seq}-${Date.now()}`
    const done = new Promise<ApprovalDecision>((settle) => {
      const record = (decision: ApprovalDecision): void => {
        this.#remember(id, decision)
        settle(decision)
      }
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) record('timeout')
      }, this.#timeoutMs)
      timer.unref?.()
      this.#pending.set(id, {
        approval: { id, chatId, tool, input, createdAt: Date.now() },
        settle: record,
        timer,
      })
    })
    return { id, done }
  }

  /** 微信回复 / Web 面板裁决；未知 id 安全 no-op */
  resolve(id: string, decision: 'allow' | 'deny'): void {
    const entry = this.#pending.get(id)
    if (!entry) return
    this.#pending.delete(id)
    clearTimeout(entry.timer)
    entry.settle(decision)
  }

  /** 当前挂起的审批（快照，不含内部句柄） */
  pending(): PendingApproval[] {
    return [...this.#pending.values()].map((e) => ({ ...e.approval }))
  }

  /** 查询某条审批的当前状态：挂起 pending，决议后保留决议值，未知 id 返回 undefined */
  resultOf(id: string): ApprovalDecision | 'pending' | undefined {
    if (this.#pending.has(id)) return 'pending'
    return this.#resolved.get(id)?.decision
  }

  /** 任务中止 / 通道失效时撤销该 chat 的全部挂起请求，立即 deny */
  cancelChat(chatId: string): void {
    for (const entry of [...this.#pending.values()]) {
      if (entry.approval.chatId !== chatId) continue
      this.#pending.delete(entry.approval.id)
      clearTimeout(entry.timer)
      entry.settle('deny')
    }
  }

  /** 留存决议结果（容量封顶，超出淘汰最旧） */
  #remember(id: string, decision: ApprovalDecision): void {
    this.#resolved.delete(id) // Map 有序：先删再放使其成为最新
    this.#resolved.set(id, { decision, at: Date.now() })
    while (this.#resolved.size > RESOLVED_CAP) {
      const oldest = this.#resolved.keys().next().value
      if (oldest === undefined) break
      this.#resolved.delete(oldest)
    }
  }
}
