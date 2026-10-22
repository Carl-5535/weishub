// 微枢本地面板：零依赖原生 JS。token 经页面 URL 的 ?token= 携带，所有 API 调用复用同一参数。
(() => {
  'use strict'

  const token = new URLSearchParams(location.search).get('token') || ''
  const $ = (id) => document.getElementById(id)

  let state = null            // 最近一次 /api/state
  let selected = null         // 当前选中的 chatId
  let qrActive = false        // 扫码流程进行中（避免重复 start）
  let qrTimerStarted = false
  const localMsgs = new Map() // chatId -> [{dir:'out'|'reply', text}]（仅本页面会话期内的消息）

  function apiUrl(path) {
    return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
  }

  async function api(path, options) {
    const res = await fetch(apiUrl(path), options)
    if (res.status === 401) throw new Error('token 无效')
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  }

  function put(path, body) {
    return api(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  }

  function textEl(tag, cls, text) {
    const el = document.createElement(tag)
    if (cls) el.className = cls
    el.textContent = text
    return el
  }

  // ---- 扫码登录 ----

  async function startQr() {
    if (qrActive) return
    qrActive = true
    $('qr-status').textContent = '正在获取二维码…'
    try {
      const r = await post('/api/qr/start')
      $('qr-img').src = r.dataUrl
      $('qr-status').textContent = '请用手机微信扫码登录'
    } catch (e) {
      qrActive = false
      $('qr-status').textContent = '获取二维码失败：' + e.message
    }
  }

  async function pollQr() {
    if (!qrActive || !state || state.loggedIn) return
    let r
    try {
      r = await api('/api/qr/poll')
    } catch {
      return
    }
    if (r.status === 'confirmed') {
      qrActive = false
      refresh()
    } else if (r.status === 'expired') {
      qrActive = false
      $('qr-status').textContent = '二维码已过期，请刷新'
    } else if (r.status === 'scanned') {
      $('qr-status').textContent = '已扫码，请在手机上确认'
    } else if (r.status === 'needs-code' || r.status === 'code-blocked') {
      qrActive = false
      $('qr-status').textContent = '需要数字验证码，请改用命令行登录'
    }
  }

  // ---- 状态渲染 ----

  function render() {
    if (!state) return
    $('login').hidden = state.loggedIn
    if (state.loggedIn) {
      qrActive = false
      renderChats()
      renderApprovals()
      renderWorkspace()
    } else if (!qrActive) {
      startQr()
    }
  }

  function renderChats() {
    const list = $('chat-list')
    list.textContent = ''
    if (state.chats.length === 0) {
      list.appendChild(textEl('li', 'muted', '暂无会话：在微信里给机器人发条消息即可开始'))
      $('chat-detail').hidden = true
      return
    }
    if (selected && !state.chats.some((c) => c.chatId === selected)) selected = null
    if (!selected) selected = state.chats[0].chatId
    for (const chat of state.chats) {
      const li = textEl('li', 'chat-item' + (chat.chatId === selected ? ' sel' : ''), chat.chatId)
      li.appendChild(textEl('span', 'badge', chat.agentName))
      li.appendChild(textEl('span', 'badge mode', chat.mode))
      if (chat.running) li.appendChild(textEl('span', 'badge busy', '运行中'))
      if (chat.queued > 0) li.appendChild(textEl('span', 'badge busy', `队列 ${chat.queued}`))
      const pendingOut = (state.outbox[chat.chatId]?.chunks.length ?? 0) - (state.outbox[chat.chatId]?.next ?? 0)
      if (pendingOut > 0) li.appendChild(textEl('span', 'badge busy', `待发 ${pendingOut}`))
      li.addEventListener('click', () => {
        selected = chat.chatId
        renderChats()
      })
      list.appendChild(li)
    }
    renderDetail()
  }

  function renderDetail() {
    const chat = state.chats.find((c) => c.chatId === selected)
    if (!chat) {
      $('chat-detail').hidden = true
      return
    }
    $('chat-detail').hidden = false
    $('chat-title').textContent = ''
    $('chat-title').appendChild(document.createTextNode(chat.chatId))
    $('chat-title').appendChild(textEl('span', 'badge', chat.agentName))
    if (chat.sessionId) $('chat-title').appendChild(textEl('span', 'badge mode', '会话恢复'))
    const list = $('msg-list')
    list.textContent = ''
    const msgs = localMsgs.get(chat.chatId) ?? []
    if (msgs.length === 0) {
      list.appendChild(textEl('li', 'muted', '（本页消息仅展示此页面发出的插话；历史消息见微信聊天）'))
    }
    for (const m of msgs) {
      list.appendChild(textEl('li', m.dir, (m.dir === 'out' ? '我：' : '回复：') + m.text))
    }
    const outbox = state.outbox[chat.chatId]
    if (outbox && outbox.next < outbox.chunks.length) {
      list.appendChild(textEl('li', 'reply', '（待投递）' + outbox.chunks[outbox.next]))
    }
  }

  function renderApprovals() {
    const wrap = $('approval-list')
    wrap.textContent = ''
    if (state.approvals.length === 0) {
      wrap.appendChild(textEl('p', 'muted', '暂无待审批'))
      return
    }
    for (const ap of state.approvals) {
      const card = textEl('div', 'approval-card', '')
      card.appendChild(textEl('div', '', `【${ap.tool}】 会话 ${ap.chatId}`))
      const pre = document.createElement('pre')
      try {
        pre.textContent = JSON.stringify(JSON.parse(ap.input), null, 2)
      } catch {
        pre.textContent = ap.input
      }
      card.appendChild(pre)
      const actions = textEl('div', 'actions', '')
      const allow = textEl('button', '', '同意')
      allow.addEventListener('click', () => decide(ap.id, 'allow'))
      const deny = textEl('button', 'deny', '拒绝')
      deny.addEventListener('click', () => decide(ap.id, 'deny'))
      actions.append(allow, deny)
      card.appendChild(actions)
      wrap.appendChild(card)
    }
  }

  async function decide(id, decision) {
    try {
      await post(`/api/approvals/${encodeURIComponent(id)}`, { decision })
      refresh()
    } catch (e) {
      alert('审批失败：' + e.message)
    }
  }

  // ---- 工作目录表单 ----

  function renderWorkspace() {
    const per = $('ws-per')
    if (document.activeElement && per.contains(document.activeElement)) return // 编辑中不重绘
    $('ws-global').value = state.workspace.global
    per.textContent = ''
    for (const name of state.agents) {
      const row = textEl('div', 'ws-row', '')
      const label = textEl('label', '', `${name} 覆盖`)
      label.htmlFor = `ws-agent-${name}`
      const input = document.createElement('input')
      input.type = 'text'
      input.id = `ws-agent-${name}`
      input.placeholder = '（留空则用全局）'
      input.value = state.workspace.perAgent[name] || ''
      row.append(label, input)
      per.appendChild(row)
    }
  }

  async function saveWorkspace() {
    const perAgent = {}
    for (const input of $('ws-per').querySelectorAll('input')) {
      const name = input.id.replace('ws-agent-', '')
      if (input.value.trim() !== '') perAgent[name] = input.value.trim()
    }
    try {
      await put('/api/workspace', { global: $('ws-global').value.trim(), perAgent })
      $('ws-msg').textContent = '已保存并即时生效'
    } catch (e) {
      $('ws-msg').textContent = ''
      $('ws-msg').className = 'err'
      $('ws-msg').textContent = '保存失败：' + e.message
    }
    setTimeout(() => {
      $('ws-msg').textContent = ''
      $('ws-msg').className = 'muted'
    }, 4000)
  }

  // ---- 手动插话 ----

  async function sendText(e) {
    e.preventDefault()
    const input = $('send-text')
    const text = input.value.trim()
    if (text === '' || !selected) return
    input.value = ''
    const msgs = localMsgs.get(selected) ?? []
    msgs.push({ dir: 'out', text })
    localMsgs.set(selected, msgs)
    renderDetail()
    try {
      await post(`/api/chats/${encodeURIComponent(selected)}/send`, { text })
    } catch (err) {
      alert('发送失败：' + err.message)
    }
  }

  // ---- 轮询驱动 ----

  async function refresh() {
    try {
      state = await api('/api/state')
      render()
    } catch {
      // 网络抖动等下一轮重试
    }
  }

  $('qr-refresh').addEventListener('click', () => {
    qrActive = false
    startQr()
  })
  $('send-form').addEventListener('submit', sendText)
  $('ws-save').addEventListener('click', saveWorkspace)

  refresh()
  setInterval(refresh, 3000)
  if (!qrTimerStarted) {
    qrTimerStarted = true
    setInterval(pollQr, 2000)
  }
})()
