// 微枢本地面板：零依赖原生 JS。页面免 token 打开，脚本先向 /api/session-token 取 token，
// 之后所有 API 调用带上它（URL 上仍可手工带 ?token= 覆盖，便于多实例调试）。
(() => {
  'use strict'

  let token = new URLSearchParams(location.search).get('token') || ''
  const $ = (id) => document.getElementById(id)

  async function loadToken() {
    if (token !== '') return
    try {
      const res = await fetch('/api/session-token')
      if (res.ok) token = (await res.json()).token || ''
    } catch {
      // 取不到就让后续请求以 401 暴露出来
    }
  }

  let state = null            // 最近一次 /api/state
  let selected = null         // 当前选中的 chatId
  let qrActive = false
  let qrTimerStarted = false
  let msgFetchSeq = 0         // 消息流请求序号：慢响应不覆盖新选中的 chat

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

  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  // ---- agent 图标：每个引擎一个可辨认的几何符号（内联 SVG，跟随 currentColor） ----

  const GLYPHS = {
    // 对话气泡里的星芒
    claude: '<path d="M12 4c.6 4.2 1.8 5.4 6 6-4.2.6-5.4 1.8-6 6-.6-4.2-1.8-5.4-6-6 4.2-.6 5.4-1.8 6-6Z"/>',
    // 尖括号
    codex: '<path d="M9 6 3.8 12 9 18M15 6l5.2 6-5.2 6"/>',
    // 层次节点
    dsh: '<circle cx="12" cy="5" r="2.2"/><circle cx="5.5" cy="17" r="2.2"/><circle cx="18.5" cy="17" r="2.2"/><path d="M12 7.2v4.3M10.6 12.4 6.8 15.4M13.4 12.4l3.8 3"/>',
    // 圆周率
    pi: '<path d="M5 8h14M9.5 8v9M15.5 8c0 6 .8 8 2 9"/>',
  }
  const FALLBACK_GLYPH = '<rect x="6" y="6" width="12" height="12" rx="2"/>'

  function agentGlyph(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    const key = name.toLowerCase()
    const shape = GLYPHS[key] ?? FALLBACK_GLYPH
    // 第一个图标是实心星芒，其余是描边
    svg.innerHTML = key === 'claude' ? `<g fill="currentColor" stroke="none">${shape}</g>` : shape
    return svg
  }

  // ---- 引擎架：已安装 agent，只能启用一个 ----

  async function enableAgent(name) {
    try {
      await put('/api/agent', { name })
      await refresh()
    } catch (e) {
      alert('切换 agent 失败：' + e.message)
    }
  }

  function renderEngines() {
    const rack = $('engine-rack')
    rack.textContent = ''
    const agents = state.agents
    $('engine-count').textContent = agents.length > 0 ? `${agents.length} 个已安装` : ''
    $('engine-empty').hidden = agents.length > 0

    for (const agent of agents) {
      const btn = el('button', 'engine')
      btn.type = 'button'
      btn.setAttribute('aria-pressed', agent.name === state.enabledAgent ? 'true' : 'false')
      btn.title = agent.enabled
        ? `当前启用：${agent.name}`
        : `启用 ${agent.name}（会停用当前的 agent）`
      btn.addEventListener('click', () => {
        if (agent.name === state.enabledAgent) return
        void enableAgent(agent.name)
      })

      const glyphWrap = el('span', 'glyph')
      glyphWrap.appendChild(agentGlyph(agent.name))
      const label = el('span', 'label')
      label.appendChild(el('span', 'name mono', agent.name))
      label.appendChild(el('span', 'state', agent.name === state.enabledAgent ? '已启用' : '待命'))
      const radio = el('span', 'radio')
      radio.setAttribute('aria-hidden', 'true')
      btn.append(glyphWrap, label, radio)
      rack.appendChild(btn)
    }
  }

  // ---- 扫码登录 ----

  async function startQr() {
    if (qrActive) return
    qrActive = true
    $('qr-status').textContent = '正在获取二维码…'
    try {
      const r = await post('/api/qr/start')
      $('qr-img').src = r.dataUrl
      $('qr-img').hidden = false
      $('qr-status').textContent = '用手机微信扫码'
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
      $('qr-status').textContent = '二维码已过期'
    } else if (r.status === 'scanned') {
      $('qr-status').textContent = '已扫码，在手机上确认'
    } else if (r.status === 'needs-code' || r.status === 'code-blocked') {
      qrActive = false
      $('qr-status').textContent = '需要数字验证码，请改用命令行 weishub login'
    }
  }

  // ---- 状态渲染 ----

  function render() {
    if (!state) return
    $('login-dot').className = 'status-dot ' + (state.loggedIn ? 'on' : 'off')
    $('login-text').textContent = state.loggedIn ? '微信已连接' : '微信未连接'
    $('login-overlay').hidden = state.loggedIn
    if (!state.loggedIn && !qrActive) void startQr()

    renderEngines()
    renderApprovals()
    renderWorkspace()
    renderChats()
  }

  function renderChats() {
    const list = $('chat-list')
    list.textContent = ''
    const shell = list.closest('.chats')
    shell.classList.toggle('is-empty', state.chats.length === 0)
    if (state.chats.length === 0) {
      $('chat-pane').replaceChildren(el('div', 'empty', '在微信里给机器人发一条消息，会话会出现在这里。'))
      return
    }
    if (selected && !state.chats.some((c) => c.chatId === selected)) selected = null
    if (!selected) selected = state.chats[0].chatId

    for (const chat of state.chats) {
      const item = el('button', 'chat-item')
      item.type = 'button'
      item.setAttribute('aria-selected', chat.chatId === selected ? 'true' : 'false')
      item.appendChild(el('span', 'cid', chat.chatId))
      const tags = el('span', 'tags')
      tags.appendChild(el('span', 'chip agent', chat.agentName))
      tags.appendChild(el('span', 'chip', chat.mode))
      if (chat.running) tags.appendChild(el('span', 'chip live', '运行中'))
      if (chat.queued > 0) tags.appendChild(el('span', 'chip live', `排队 ${chat.queued}`))
      const pendingOut = (state.outbox[chat.chatId]?.chunks.length ?? 0) - (state.outbox[chat.chatId]?.next ?? 0)
      if (pendingOut > 0) tags.appendChild(el('span', 'chip live', `待发 ${pendingOut}`))
      item.appendChild(tags)
      item.addEventListener('click', () => {
        selected = chat.chatId
        renderChats()
      })
      list.appendChild(item)
    }
    renderChatPane()
  }

  function renderChatPane() {
    const chat = state.chats.find((c) => c.chatId === selected)
    const pane = $('chat-pane')
    if (!chat) {
      pane.replaceChildren(el('div', 'empty', '选择左侧的会话'))
      return
    }
    // 已渲染则只更新头部标签，避免轮询时打断消息滚动
    let head = pane.querySelector('.chat-head')
    let list = pane.querySelector('.msg-list')
    if (head === null || list === null) {
      pane.textContent = ''
      head = el('div', 'chat-head')
      list = el('ul', 'msg-list')
      const compose = el('form', 'compose')
      const input = document.createElement('input')
      input.type = 'text'
      input.id = 'send-text'
      input.placeholder = '以你本人的身份插入一条消息'
      input.autocomplete = 'off'
      const submit = el('button', 'primary', '发送')
      submit.type = 'submit'
      compose.append(input, submit)
      compose.addEventListener('submit', sendText)
      pane.append(head, list, compose)
      list.dataset.chat = chat.chatId
    }
    head.textContent = ''
    head.appendChild(el('span', 'cid', chat.chatId))
    head.appendChild(el('span', 'chip agent', chat.agentName))
    if (chat.sessionId) head.appendChild(el('span', 'chip', '会话恢复'))
    if (list.dataset.chat !== chat.chatId) {
      list.dataset.chat = chat.chatId
      list.textContent = ''
    }
    void loadMessages(chat.chatId)
  }

  // 消息流：hub 每 chat 的收发环（最近 50 条）
  async function loadMessages(chatId) {
    const mySeq = ++msgFetchSeq
    let r
    try {
      r = await api(`/api/chats/${encodeURIComponent(chatId)}/messages`)
    } catch {
      return
    }
    if (mySeq !== msgFetchSeq || chatId !== selected) return
    const pane = $('chat-pane')
    const list = pane.querySelector('.msg-list')
    if (list === null || list.dataset.chat !== chatId) return
    const signature = JSON.stringify(r.messages)
    if (list.dataset.signature === signature) return // 无变化不重绘
    list.dataset.signature = signature
    list.textContent = ''
    if (r.messages.length === 0) {
      list.appendChild(el('li', 'note', '还没有消息。'))
    }
    for (const m of r.messages) {
      list.appendChild(el('li', m.direction === 'in' ? 'in' : 'out', m.text))
    }
    const outbox = state.outbox[chatId]
    if (outbox && outbox.next < outbox.chunks.length) {
      list.appendChild(el('li', 'note', '待投递：' + outbox.chunks[outbox.next]))
    }
    list.scrollTop = list.scrollHeight
  }

  function renderApprovals() {
    const wrap = $('approval-list')
    wrap.textContent = ''
    $('approval-hint').textContent = state.approvals.length > 0 ? `${state.approvals.length} 项等待你决定` : ''
    if (state.approvals.length === 0) {
      wrap.appendChild(el('div', 'empty', '没有等待中的操作。agent 要越界时才会来这里问你。'))
      return
    }
    for (const ap of state.approvals) {
      const card = el('div', 'approval')
      const who = el('div', 'who')
      who.appendChild(el('span', 'tag', ap.tool))
      who.appendChild(el('span', 'muted', ap.chatId))
      card.appendChild(who)
      const pre = document.createElement('pre')
      try {
        pre.textContent = JSON.stringify(JSON.parse(ap.input), null, 2)
      } catch {
        pre.textContent = ap.input
      }
      card.appendChild(pre)
      const actions = el('div', 'actions')
      const allow = el('button', 'primary', '允许这次')
      allow.addEventListener('click', () => decide(ap.id, 'allow'))
      const deny = el('button', 'danger', '拒绝')
      deny.addEventListener('click', () => decide(ap.id, 'deny'))
      actions.append(allow, deny)
      card.appendChild(actions)
      wrap.appendChild(card)
    }
  }

  async function decide(id, decision) {
    try {
      await post(`/api/approvals/${encodeURIComponent(id)}`, { decision })
      await refresh()
    } catch (e) {
      alert('审批失败：' + e.message)
    }
  }

  // ---- 工作目录 ----

  function renderWorkspace() {
    const per = $('ws-per')
    if (document.activeElement && per.contains(document.activeElement)) return // 编辑中不重绘
    $('ws-global').value = state.workspace.global
    per.textContent = ''
    for (const agent of state.agents) {
      const row = el('div', 'ws-row')
      const label = document.createElement('label')
      label.htmlFor = `ws-agent-${agent.name}`
      label.appendChild(document.createTextNode(''))
      label.appendChild(el('span', 'mono', agent.name))
      const input = document.createElement('input')
      input.type = 'text'
      input.id = `ws-agent-${agent.name}`
      input.spellcheck = false
      input.placeholder = '留空则用全局默认'
      input.value = state.workspace.perAgent[agent.name] || ''
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
      await refresh()
      $('ws-msg').className = 'muted'
      $('ws-msg').textContent = '已保存，下一次任务起生效'
    } catch (e) {
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
    if (input === null || !selected) return
    const text = input.value.trim()
    if (text === '') return
    input.value = ''
    try {
      await post(`/api/chats/${encodeURIComponent(selected)}/send`, { text })
      await loadMessages(selected)
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
    $('qr-img').hidden = true
    void startQr()
  })
  $('relogin').addEventListener('click', () => {
    $('login-overlay').hidden = false
    qrActive = false
    void startQr()
  })
  $('ws-save').addEventListener('click', saveWorkspace)

  // 先取 token 再开轮询：页面免 token 打开，token 由服务端下发
  void loadToken().then(() => {
    void refresh()
    setInterval(refresh, 3000)
    if (!qrTimerStarted) {
      qrTimerStarted = true
      setInterval(pollQr, 2000)
    }
  })
})()
