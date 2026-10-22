import { describe, expect, it, vi } from 'vitest'
import { Outbox } from '../src/outbox.js'

/** 等待微任务队列清空，让自动投递循环跑完当前可跑的部分。 */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('Outbox', () => {
  it('超长文本按 maxChars 切分逐条发送且保持顺序', async () => {
    const sent: string[] = []
    const outbox = new Outbox({
      send: async (_chatId, text) => { sent.push(text) },
      sendFile: async () => {},
      maxChars: 3,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', 'aaabbbccc')
    await outbox.resumePending()
    expect(sent).toEqual(['aaa', 'bbb', 'ccc'])
    expect(outbox.pending()).toEqual({})
  })

  it('文本与文件交错时文件在全部文本之后按序发送', async () => {
    const sent: string[] = []
    const filesSent: string[] = []
    const outbox = new Outbox({
      send: async (_chatId, text) => { sent.push(text) },
      sendFile: async (_chatId, path) => { filesSent.push(path) },
      maxChars: 100,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', '正文', ['b.pdf', 'a.png'])
    await outbox.resumePending()
    expect(sent).toEqual(['正文'])
    expect(filesSent).toEqual(['b.pdf', 'a.png'])
  })

  it('send 抛错时重试 3 次后保留断点（next 不前进）', async () => {
    let calls = 0
    const outbox = new Outbox({
      send: async () => {
        calls += 1
        throw new Error('网络故障')
      },
      sendFile: async () => {},
      maxChars: 10,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', 'hello')
    await outbox.resumePending()
    // 首次尝试 + 3 次重试
    expect(calls).toBe(4)
    const pending = outbox.pending()
    expect(pending['c1']).toBeDefined()
    expect(pending['c1']!.next).toBe(0)
    expect(pending['c1']!.chunks).toEqual(['hello'])
  })

  it('重试耗尽后下次 resumePending 会再试且能成功送达', async () => {
    let calls = 0
    const sent: string[] = []
    const outbox = new Outbox({
      send: async (_chatId, text) => {
        calls += 1
        if (calls <= 4) throw new Error('网络故障')
        sent.push(text)
      },
      sendFile: async () => {},
      maxChars: 10,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', 'hello')
    await outbox.resumePending()
    expect(outbox.pending()['c1']).toBeDefined()
    await outbox.resumePending()
    expect(sent).toEqual(['hello'])
    expect(outbox.pending()).toEqual({})
  })

  it('load 断点快照后 resumePending 从 next 继续（不重发已发块）', async () => {
    const sent: string[] = []
    const filesSent: string[] = []
    let emptyFired = 0
    const outbox = new Outbox({
      send: async (_chatId, text) => { sent.push(text) },
      sendFile: async (_chatId, path) => { filesSent.push(path) },
      maxChars: 10,
      retryDelayMs: 1,
    })
    outbox.onEmpty(() => { emptyFired += 1 })
    outbox.load({ c1: { chunks: ['a', 'b', 'c'], files: ['f1.pdf'], next: 1, nextFile: 0 } })
    expect(outbox.pending()).toEqual({ c1: { chunks: ['a', 'b', 'c'], files: ['f1.pdf'], next: 1, nextFile: 0 } })
    await outbox.resumePending()
    expect(sent).toEqual(['b', 'c'])
    expect(filesSent).toEqual(['f1.pdf'])
    expect(outbox.pending()).toEqual({})
    expect(emptyFired).toBe(1)
  })

  it('enqueue 时该 chat 有投递进行中，新内容追加到同一条目尾部（carriedChunks 语义）', async () => {
    const sent: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const outbox = new Outbox({
      send: async (_chatId, text) => {
        sent.push(text)
        if (sent.length === 1) await gate
      },
      sendFile: async () => {},
      maxChars: 5,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', 'aaaaa')
    await flush()
    expect(sent).toEqual(['aaaaa'])
    // 首块尚未送达（仍在等待 gate），此时追加应并入同一条目
    outbox.enqueue('c1', 'bbbbb')
    expect(Object.keys(outbox.pending())).toEqual(['c1'])
    release()
    await outbox.resumePending()
    expect(sent).toEqual(['aaaaa', 'bbbbb'])
    expect(outbox.pending()).toEqual({})
  })

  it('追加的内容同样按序切分并与旧块保持顺序', async () => {
    const sent: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const outbox = new Outbox({
      send: async (_chatId, text) => {
        sent.push(text)
        if (sent.length === 1) await gate
      },
      sendFile: async () => {},
      maxChars: 2,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', 'aabb')
    await flush()
    outbox.enqueue('c1', 'ccdd', ['x.pdf'])
    release()
    await outbox.resumePending()
    expect(sent).toEqual(['aa', 'bb', 'cc', 'dd'])
    expect(outbox.pending()).toEqual({})
  })

  it('空 outbox 触发 onEmpty', async () => {
    let emptyFired = 0
    const outbox = new Outbox({
      send: async () => {},
      sendFile: async () => {},
      maxChars: 10,
      retryDelayMs: 1,
    })
    outbox.onEmpty(() => { emptyFired += 1 })
    outbox.enqueue('c1', 'hi')
    outbox.enqueue('c2', 'yo')
    await outbox.resumePending()
    expect(emptyFired).toBe(1)
    // 已空时再次送达完成不再触发
    outbox.enqueue('c3', 'ok')
    await outbox.resumePending()
    expect(emptyFired).toBe(2)
  })

  it('多个 chat 并行入队互不串扰，各自串行投递', async () => {
    const perChat: Record<string, string[]> = {}
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const outbox = new Outbox({
      send: async (chatId, text) => {
        ;(perChat[chatId] ??= []).push(text)
        if (chatId === 'slow') await gate
      },
      sendFile: async () => {},
      maxChars: 100,
      retryDelayMs: 1,
    })
    outbox.enqueue('slow', 's1')
    outbox.enqueue('fast', 'f1')
    outbox.enqueue('fast', 'f2')
    await flush()
    release()
    await outbox.resumePending()
    expect(perChat['slow']).toEqual(['s1'])
    expect(perChat['fast']).toEqual(['f1', 'f2'])
    expect(outbox.pending()).toEqual({})
  })

  it('sendFile 抛错重试耗尽同样保留断点（nextFile 不前进）', async () => {
    let calls = 0
    const outbox = new Outbox({
      send: async () => {},
      sendFile: async () => {
        calls += 1
        throw new Error('文件发送失败')
      },
      maxChars: 10,
      maxRetries: 2,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', '正文', ['a.pdf'])
    await outbox.resumePending()
    expect(calls).toBe(3) // 首次 + 2 次重试
    const pending = outbox.pending()
    expect(pending['c1']!.next).toBe(1) // 文本已送达
    expect(pending['c1']!.nextFile).toBe(0)
  })

  it('pending() 返回快照，外部修改不影响内部状态', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const outbox = new Outbox({
      send: async () => { await gate },
      sendFile: async () => {},
      maxChars: 10,
      retryDelayMs: 1,
    })
    outbox.enqueue('c1', 'hello')
    const snapshot = outbox.pending()
    snapshot['c1']!.chunks.push('恶意注入')
    snapshot['c1']!.next = 99
    release()
    await outbox.resumePending()
    expect(outbox.pending()).toEqual({})
  })

  it('默认重试参数为 maxRetries=3、retryDelayMs=2000', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const outbox = new Outbox({
        send: async () => {
          calls += 1
          throw new Error('始终失败')
        },
        sendFile: async () => {},
        maxChars: 10,
      })
      outbox.enqueue('c1', 'hello')
      const settled = outbox.resumePending()
      await vi.advanceTimersByTimeAsync(1999)
      expect(calls).toBe(1) // 2 秒退避未到，第一次重试尚未发起
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls).toBe(3)
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls).toBe(4) // 首次 + 默认 3 次重试，之后耗尽
      await settled
      expect(outbox.pending()['c1']!.next).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
