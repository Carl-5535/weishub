import { expect, test } from 'vitest'
import { discoverAgents } from '../src/registry.js'
import type { AgentConfig } from '../src/types.js'

function makeConfig(name: string, detect: string): AgentConfig {
  return {
    name,
    detect,
    run: [detect, '-p'],
    passVia: 'stdin',
    outputFormat: 'text',
    resume: ['--resume', '{{sessionId}}'],
    approval: null,
    permissionFlags: { auto: [], full: [] },
    workspace: null,
    timeoutSec: 600,
  }
}

test('detect 指向 node（process.execPath 所在目录）的 config 被保留', async () => {
  const configs = [makeConfig('node-agent', 'node')]
  const found = await discoverAgents(configs)
  expect(found.map((c) => c.name)).toEqual(['node-agent'])
})

test('指向不存在命令的 config 被过滤', async () => {
  const configs = [makeConfig('ghost', 'weishub-definitely-not-a-real-cmd-xyz')]
  const found = await discoverAgents(configs)
  expect(found).toEqual([])
})

test('混合输入只保留命中项，且顺序不变', async () => {
  const configs = [
    makeConfig('first', 'weishub-nope-a'),
    makeConfig('node-agent', 'node'),
    makeConfig('second', 'weishub-nope-b'),
  ]
  const found = await discoverAgents(configs)
  expect(found.map((c) => c.name)).toEqual(['node-agent'])
})

test('全不命中返回空数组', async () => {
  const found = await discoverAgents([makeConfig('a', 'x1'), makeConfig('b', 'x2')])
  expect(found).toEqual([])
})

test('注入的探测函数按平台分支选择命令（win32 → where）', async () => {
  const calls: string[] = []
  const probe = async (cmd: string) => {
    calls.push(cmd)
    return cmd === 'node'
  }
  const found = await discoverAgents(
    [makeConfig('node-agent', 'node'), makeConfig('ghost', 'ghost')],
    probe,
  )
  expect(found.map((c) => c.name)).toEqual(['node-agent'])
  expect(calls).toEqual(['node', 'ghost'])
})

test('探测函数抛错按未命中处理，不向调用方抛出', async () => {
  const found = await discoverAgents([makeConfig('boom', 'anything')], async () => {
    throw new Error('探测炸了')
  })
  expect(found).toEqual([])
})
