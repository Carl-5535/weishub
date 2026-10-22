export interface PendingApproval {
  id: string
  chatId: string
  tool: string
  input: string
  createdAt: number
}

type ApprovalDecision = 'allow' | 'deny' | 'timeout'

interface PendingEntry {
  approval: PendingApproval
  settle: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

/**
 * 微信审批路由：agent 的权限请求在此挂起，等微信回复（resolve）或超时。
 * 纯内存，不落盘——重启丢审批可接受，前身同策略。
 */
export class ApprovalRouter {
  readonly #timeoutMs: number
  readonly #pending = new Map<string, PendingEntry>()
  #seq = 0

  constructor(deps: { timeoutMs?: number } = {}) {
    this.#timeoutMs = deps.timeoutMs ?? 600_000
  }

  /** 挂起一条审批请求，直到 resolve / cancelChat / 超时 */
  request(chatId: string, tool: string, input: string): Promise<ApprovalDecision> {
    return new Promise((settle) => {
      const id = `ap-${++this.#seq}-${Date.now()}`
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) settle('timeout')
      }, this.#timeoutMs)
      timer.unref?.()
      this.#pending.set(id, {
        approval: { id, chatId, tool, input, createdAt: Date.now() },
        settle,
        timer,
      })
    })
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

  /** 任务中止 / 通道失效时撤销该 chat 的全部挂起请求，立即 deny */
  cancelChat(chatId: string): void {
    for (const entry of [...this.#pending.values()]) {
      if (entry.approval.chatId !== chatId) continue
      this.#pending.delete(entry.approval.id)
      clearTimeout(entry.timer)
      entry.settle('deny')
    }
  }
}
