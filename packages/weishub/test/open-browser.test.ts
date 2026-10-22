import { describe, expect, test, vi, afterEach } from 'vitest'
import { openerCommand } from '../src/open-browser.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('openerCommand', () => {
  test('macOS 用 open', () => {
    expect(openerCommand('http://127.0.0.1:8090/?token=x', 'darwin')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:8090/?token=x'],
    })
  })

  test('Windows 用 cmd /c start，空标题占位避免把 URL 当窗口名', () => {
    expect(openerCommand('http://127.0.0.1:8090/', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:8090/'],
    })
  })

  test('Linux 用 xdg-open', () => {
    expect(openerCommand('http://127.0.0.1:8090/', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:8090/'],
    })
  })

  test('URL 含 token 时原样传递，不做 shell 拼接', () => {
    const url = 'http://127.0.0.1:8090/?token=abc&x=1'
    expect(openerCommand(url, 'darwin').args[0]).toBe(url)
  })
})
