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

  // ---- 主题：跟随系统，手动切换后记住选择 ----

  const THEME_KEY = 'weishub-theme'

  function applyTheme(theme) {
    // theme: 'light' | 'dark'；未指定则跟随系统
    document.documentElement.dataset.theme = theme
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved)
      return
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    applyTheme(media.matches ? 'dark' : 'light')
    // 系统主题变化时，仅在用户未手动选择过的情况下跟随
    media.addEventListener('change', (e) => {
      if (localStorage.getItem(THEME_KEY) === null) applyTheme(e.matches ? 'dark' : 'light')
    })
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    localStorage.setItem(THEME_KEY, next)
  }

  initTheme()

  // ---- agent 图标：各厂商品牌形象的矢量近似版（内联 SVG，无外部资源） ----
  // 每个条目 = { d: 路径集, filled: 是否实心, color: 品牌色（未启用时的着色） }

  const GLYPHS = {
    // Anthropic Claude：星芒/火花
    claude: {
      filled: true,
      color: '#d97757',
      d: `<path d="M12 2.6c.55 4.9 2.1 6.45 7 7-4.9.55-6.45 2.1-7 7-.55-4.9-2.1-6.45-7-7 4.9-.55 6.45-2.1 7-7Z"/>`,
    },
    // OpenAI Codex：六瓣花结
    codex: {
      filled: true,
      color: '#10a37f',
      d: `<path d="M12 3.1a4.2 4.2 0 0 1 3.63 2.1 4.2 4.2 0 0 1 3.64 2.1 4.2 4.2 0 0 1 0 4.2 4.2 4.2 0 0 1-2.1 3.64 4.2 4.2 0 0 1-2.1 3.64 4.2 4.2 0 0 1-4.2 0 4.2 4.2 0 0 1-3.64-2.1 4.2 4.2 0 0 1-3.64-2.1 4.2 4.2 0 0 1 0-4.2 4.2 4.2 0 0 1 2.1-3.64A4.2 4.2 0 0 1 8.37 5.2 4.2 4.2 0 0 1 12 3.1Zm0 2.4a1.8 1.8 0 0 0-1.56.9l1.56 2.7 1.56-2.7A1.8 1.8 0 0 0 12 5.5Zm-4.2 2.42a1.8 1.8 0 0 0-.9 1.56v3.12l3.12-1.8V7.92H7.8Zm8.4 0h-2.22v3.12l3.12 1.8V9.48a1.8 1.8 0 0 0-.9-1.56ZM9.02 13.3l-3.12 1.8v2.22h4.44v-3.12L9.02 13.3Zm5.96 0-1.32.9v3.12h4.44V15.1l-3.12-1.8ZM12 14.34 9.72 15.66v2.64h4.56v-2.64L12 14.34Z"/>`,
    },
    // DeepSeek（dsh）：鲸鱼
    dsh: {
      filled: true,
      color: '#4d6bfe',
      d: `<path d="M2.1 12.4c0-2.9 2.3-5.3 5.2-5.3h5.1c2.6 0 4.6 1.2 5.9 3.1l2.9 4.2c.5.8-.2 1.8-1.1 1.6l-2.5-.5c-1.5-.3-2.6.4-2.9 1.8-.2 1-.9 1.6-2.1 1.7-4.9.5-8.9-1.7-10.2-5.2-.2-.5-.3-.9-.3-1.4Zm4.1-1.2a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z"/><path d="M14.9 8.4c.9-1.2 2.2-1.8 3.7-1.9-.2 1-.7 1.8-1.5 2.4l-2.2-.5Z"/>`,
    },
    // pi：圆周率
    pi: {
      filled: false,
      color: '#8a6fd6',
      d: `<path d="M4.5 7.6h15M9.3 7.6v8.9M8 16.5h2.6M14.6 7.6c0 6.2.9 8.4 2.3 9.3M14.2 11.6h2.1"/>`,
    },
  }
  const FALLBACK_GLYPH = { filled: false, color: 'currentColor', d: '<rect x="6" y="6" width="12" height="12" rx="2"/>' }

  function agentGlyph(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const glyph = GLYPHS[name.toLowerCase()] ?? FALLBACK_GLYPH
    if (glyph.filled) {
      svg.setAttribute('fill', 'currentColor')
      svg.innerHTML = glyph.d
    } else {
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.6')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.innerHTML = glyph.d
    }
    return svg
  }

  /** 品牌色：未启用时用厂商色（弱化），启用时统一为铜色以强化「当前生效」的单选语义。 */
  function brandColor(name) {
    return (GLYPHS[name.toLowerCase()] ?? FALLBACK_GLYPH).color
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
      // 图标始终使用厂商品牌色（这是识别厂商的锚点）；选中态由左栏铜条与单选圆点表达
      glyphWrap.style.color = brandColor(agent.name)
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
    const health = state.credential ?? { state: state.loggedIn ? 'ok' : 'missing' }
    const dot = $('login-dot')
    dot.className = 'status-dot ' + (
      health.state === 'ok' ? 'on'
        : health.state === 'expiring' ? 'warn'
          : health.state === 'missing' ? '' : 'off'
    )
    $('login-text').textContent = healthText(health)
    $('login-text').className = health.state === 'expiring' || health.state === 'expired' || health.state === 'rejected'
      ? 'status-warn' : ''
    const needsLogin = health.state === 'missing' || health.state === 'rejected'
    $('login-overlay').hidden = !needsLogin
    if (needsLogin && !qrActive) void startQr()

    renderEngines()
    renderApprovals()
    renderWorkspace()
    renderChats()
  }

  function healthText(health) {
    switch (health.state) {
      case 'missing': return '微信未连接'
      case 'ok': return `微信已连接 · 凭据剩 ${remainText(health.remainingMs)}`
      case 'expiring': return `凭据 ${remainText(health.remainingMs)}后过期 · 发条消息续期`
      case 'expired': return '凭据已过期 · 发条消息续期或重新扫码'
      case 'rejected': return '凭据已被微信拒绝 · 需要重新扫码'
      default: return '微信已连接'
    }
  }

  function remainText(ms) {
    if (ms <= 0) return '已过期'
    if (ms >= 3_600_000) {
      const h = ms / 3_600_000
      return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} 小时`
    }
    return `${Math.max(1, Math.ceil(ms / 60_000))} 分钟`
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
  $('theme-toggle').addEventListener('click', toggleTheme)

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
