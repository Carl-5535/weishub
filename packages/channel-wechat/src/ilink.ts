/**
 * 微信 iLink Bot HTTP 协议客户端。
 *
 * 通道为腾讯官方 iLink Bot API（即微信「插件/ClawBot」机器人通道）。
 * 收消息：POST /ilink/bot/getupdates 长轮询（服务端 hold 到有更新或超时）；
 * 发消息：POST /ilink/bot/sendmessage；打字状态：getconfig + sendtyping；
 * 媒体：getuploadurl → CDN 上传密文 → sendmessage 引用。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  classifyOutbound,
  decryptMedia,
  encryptMedia,
  mediaTypeForName,
  paddedSize,
  safeFileName,
  uploadMediaType,
  type CdnMediaRef,
  type InboundMedia,
  type MediaKind,
} from './media.js'

/** 协议代际，与官方 ClawBot 插件保持一致。 */
const CHANNEL_VERSION = '2.2.0'
const CLIENT_VERSION = (2 << 16) | (2 << 8)
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: 'DeepSeek' }
}

/** 归一化后的入站消息。 */
export interface InboundMessage {
  /** iLink 消息 id，用于去重（可能为空）。 */
  id: string
  /** 会话标识：单聊为对方 userId，群聊为 roomId。 */
  chatId: string
  /** 发送者 userId。 */
  userId: string
  group: boolean
  text: string
  media: InboundMedia[]
  mediaErrors: string[]
}

/** 可安全持久化的轮询游标（不含凭据）。 */
export interface ILinkState {
  updatesBuffer: string
  contextTokens: Record<string, string>
}

export interface ILinkClientOptions {
  token: string
  accountId?: string
  apiBase: string
  cdnBase?: string
  fetch?: typeof globalThis.fetch
  state?: ILinkState
  onStateChange?: (state: ILinkState) => Promise<void> | void
  requestTimeoutMs?: number
  maxMediaBytes?: number
}

interface WireItem {
  type: number
  text_item?: { text?: string }
  image_item?: { media?: CdnMediaRef; aeskey?: string }
  voice_item?: { media?: CdnMediaRef }
  file_item?: { media?: CdnMediaRef; file_name?: string }
  video_item?: { media?: CdnMediaRef }
}

interface WireMessage {
  message_id?: string | number
  from_user_id?: string
  room_id?: string
  chat_room_id?: string
  context_token?: string
  item_list?: WireItem[]
}

interface ApiResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WireMessage[]
  get_updates_buf?: string
}

interface ConfigResponse extends ApiResponse {
  typing_ticket?: string
}

interface UploadResponse extends ApiResponse {
  upload_param?: string
  upload_full_url?: string
}

/** 校验 API 入口：凭据只会发往 HTTPS（回环地址放行 HTTP 以便本地测试）。 */
export function validateApiBase(apiBase: string): void {
  const parsed = new URL(apiBase)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) {
    throw new Error('微信 API 入口必须使用 HTTPS（仅回环地址允许 HTTP）')
  }
}

interface DownloadSpec {
  kind: MediaKind
  ref?: CdnMediaRef
  key?: string
  name: string
}

function downloadSpec(item: WireItem): DownloadSpec | undefined {
  switch (item.type) {
    case 2:
      return {
        kind: 'image',
        ref: item.image_item?.media,
        // 图片的 aeskey 有 hex / base64-ref 两种下发形态，统一成 base64。
        key: item.image_item?.aeskey === undefined
          ? item.image_item?.media?.aes_key
          : Buffer.from(item.image_item.aeskey, 'hex').toString('base64'),
        name: 'image.jpg',
      }
    case 3:
      return { kind: 'voice', ref: item.voice_item?.media, key: item.voice_item?.media?.aes_key, name: 'voice.silk' }
    case 4:
      return { kind: 'file', ref: item.file_item?.media, key: item.file_item?.media?.aes_key, name: safeFileName(item.file_item?.file_name ?? '', 'file.bin') }
    case 5:
      return { kind: 'video', ref: item.video_item?.media, key: item.video_item?.media?.aes_key, name: 'video.mp4' }
    default:
      return undefined
  }
}

/** 协议失败：携带 ret/errcode 供调用方区分错误类别（如 context_token 过期）。 */
export class ILinkProtocolError extends Error {
  constructor(readonly operation: string, readonly ret: number, readonly errcode: number, message: string) {
    super(message)
    this.name = 'ILinkProtocolError'
  }
}

/** context_token 失效的协议错误码：唯一允许「清 token 重发」的类别。 */
const ERRCODE_CONTEXT_EXPIRED = 41001

export class ILinkClient {
  readonly #token: string
  readonly #accountId: string
  readonly #apiBase: string
  readonly #cdnBase: string
  readonly #fetch: typeof globalThis.fetch
  readonly #onStateChange: ((state: ILinkState) => Promise<void> | void) | undefined
  readonly #requestTimeoutMs: number
  readonly #maxMediaBytes: number
  readonly #contextTokens = new Map<string, string>()
  /** 内存中的最新游标（poll 推进；落盘要等消费方 checkpoint，见 at-least-once 注释） */
  #updatesBuffer: string
  /** 已落盘的游标：崩溃重启从这里重放（上游 msg.id 去重），宁可重放不可丢消息 */
  #checkpointedBuffer: string

  constructor(options: ILinkClientOptions) {
    this.#token = options.token
    this.#accountId = options.accountId ?? ''
    this.#apiBase = options.apiBase.replace(/\/$/, '')
    this.#cdnBase = (options.cdnBase ?? 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onStateChange = options.onStateChange
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 90_000
    this.#maxMediaBytes = options.maxMediaBytes ?? 100 * 1024 * 1024
    this.#updatesBuffer = options.state?.updatesBuffer ?? ''
    this.#checkpointedBuffer = this.#updatesBuffer
    validateApiBase(this.#apiBase)
    validateApiBase(this.#cdnBase)
    for (const [chatId, token] of Object.entries(options.state?.contextTokens ?? {})) this.#contextTokens.set(chatId, token)
  }

  /**
   * 长轮询一次，返回本轮收到的新消息（服务端无更新时会阻塞到超时）。
   *
   * 投递语义 at-least-once：本方法只推进内存游标、不落盘；调用方把返回的消息
   * 全部处理完后必须调 checkpoint() 落盘。中途崩溃重启会从上次 checkpoint 重放
   * （调用方按 msg.id 去重），而不是把已收到未处理的消息永久丢掉。
   */
  async poll(signal: AbortSignal): Promise<InboundMessage[]> {
    const result = await this.#post<ApiResponse>('/ilink/bot/getupdates', {
      get_updates_buf: this.#checkpointedBuffer,
      base_info: baseInfo(),
    }, signal)
    this.#assertSuccess(result, 'getupdates')
    if (result.get_updates_buf !== undefined) this.#updatesBuffer = result.get_updates_buf
    const messages: InboundMessage[] = []
    for (const message of result.msgs ?? []) {
      const userId = message.from_user_id ?? ''
      if (userId === '' || userId === this.#accountId) continue
      const text = (message.item_list ?? [])
        .filter(item => item.type === 1)
        .map(item => item.text_item?.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim()
      const downloaded = await this.#downloadItems(message.item_list ?? [], signal)
      if (text === '' && downloaded.media.length === 0 && downloaded.errors.length === 0) continue
      const roomId = message.room_id || message.chat_room_id
      const group = roomId !== undefined && roomId !== ''
      const chatId = group ? roomId : userId
      // context_token 与会话绑定，回复时必须带回，失效则清除重试。
      // token 落盘失败不阻塞消息批次（token 可从后续任意入站消息重新取得）。
      if (message.context_token !== undefined && message.context_token !== '') {
        this.#contextTokens.set(chatId, message.context_token)
        await this.#notifyStateChange().catch(() => {})
      }
      messages.push({ id: String(message.message_id ?? ''), chatId, userId, group, text, media: downloaded.media, mediaErrors: downloaded.errors })
    }
    return messages
  }

  /** 消费方确认本轮消息已处理：把内存游标（连同会话 token）落盘。 */
  async checkpoint(): Promise<void> {
    this.#checkpointedBuffer = this.#updatesBuffer
    await this.#notifyStateChange()
  }

  /** 发送一条纯文本。 */
  async sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.#sendItems(chatId, [{ type: 1, text_item: { text } }], signal)
  }

  /** 设置/清除「正在输入」状态（需要先换取 per-chat ticket）。 */
  async sendTyping(chatId: string, typing: boolean, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(Math.min(this.#requestTimeoutMs, 5_000))
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const config = await this.#post<ConfigResponse>('/ilink/bot/getconfig', {
      ilink_user_id: chatId,
      ...this.#contextOptional(chatId),
      base_info: baseInfo(),
    }, requestSignal)
    this.#assertSuccess(config, 'getconfig')
    if (config.typing_ticket === undefined || config.typing_ticket === '') throw new Error('getconfig 未返回 typing_ticket')
    const result = await this.#post<ApiResponse>('/ilink/bot/sendtyping', {
      ilink_user_id: chatId,
      typing_ticket: config.typing_ticket,
      status: typing ? 1 : 2,
      base_info: baseInfo(),
    }, requestSignal)
    this.#assertSuccess(result, 'sendtyping')
  }

  /** 加密并上传一个本地文件，然后作为原生媒体消息发出。 */
  async sendMedia(chatId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (data.byteLength > this.#maxMediaBytes) throw new Error(`微信媒体超过 ${this.#maxMediaBytes} 字节限制`)
    const kind = classifyOutbound(name)
    const filekey = randomBytes(16).toString('hex')
    const key = randomBytes(16)
    const ciphertext = encryptMedia(data, key)
    const upload = await this.#post<UploadResponse>('/ilink/bot/getuploadurl', {
      filekey,
      media_type: uploadMediaType(kind),
      to_user_id: chatId,
      rawsize: data.byteLength,
      rawfilemd5: createHash('md5').update(data).digest('hex'),
      filesize: paddedSize(data.byteLength),
      no_need_thumb: true,
      aeskey: key.toString('hex'),
      base_info: baseInfo(),
    }, signal)
    this.#assertSuccess(upload, 'getuploadurl')
    const uploadUrl = upload.upload_full_url?.trim()
      || (upload.upload_param === undefined ? '' : `${this.#cdnBase}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`)
    if (uploadUrl === '') throw new Error('getuploadurl 未返回上传地址')
    this.#assertCdnOrigin(uploadUrl)
    const response = await this.#fetch(uploadUrl, {
      method: 'POST', signal: this.#cdnSignal(signal), redirect: 'error', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(ciphertext),
    })
    if (!response.ok) throw new Error(`微信 CDN 上传失败 HTTP ${response.status}`)
    const downloadParam = response.headers.get('x-encrypted-param')
    if (downloadParam === null || downloadParam === '') throw new Error('微信 CDN 上传未返回 x-encrypted-param')
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }
    const item = kind === 'image'
      ? { type: 2, image_item: { media, mid_size: ciphertext.byteLength } }
      : kind === 'video'
        ? { type: 5, video_item: { media, video_size: ciphertext.byteLength } }
        : { type: 4, file_item: { media, file_name: safeFileName(name, 'file.bin'), len: String(data.byteLength) } }
    await this.#sendItems(chatId, [item], signal)
  }

  #contextOptional(chatId: string): { context_token?: string } {
    const token = this.#contextTokens.get(chatId)
    return token === undefined ? {} : { context_token: token }
  }

  async #sendItems(chatId: string, items: unknown[], signal?: AbortSignal): Promise<void> {
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `weishub-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: items,
      ...this.#contextOptional(chatId),
    }
    const result = await this.#post<ApiResponse>('/ilink/bot/sendmessage', {
      base_info: baseInfo(),
      msg: message,
    }, signal)
    try {
      this.#assertSuccess(result, 'sendmessage')
    } catch (error) {
      // 仅 context_token 失效（41001）这一种失败允许「清 token 重发一次」：
      // 其他失败（限流、内容被拒等）可能是消息已部分送达，盲发会重复投递，
      // 删掉的有效 token 还会让后续回复无 token 可带。
      if (
        !(error instanceof ILinkProtocolError)
        || error.errcode !== ERRCODE_CONTEXT_EXPIRED
        || !this.#contextTokens.has(chatId)
      ) throw error
      this.#contextTokens.delete(chatId)
      await this.#notifyStateChange().catch(() => {})
      await this.#sendItems(chatId, items, signal)
    }
  }

  async #downloadItems(items: WireItem[], signal: AbortSignal): Promise<{ media: InboundMedia[]; errors: string[] }> {
    const media: InboundMedia[] = []
    const errors: string[] = []
    for (const item of items) {
      const spec = downloadSpec(item)
      if (spec === undefined || spec.ref === undefined) continue
      try {
        if (spec.key === undefined) throw new Error('媒体缺少 AES 密钥')
        const url = spec.ref.full_url?.trim()
          || (spec.ref.encrypt_query_param === undefined ? '' : `${this.#cdnBase}/download?encrypted_query_param=${encodeURIComponent(spec.ref.encrypt_query_param)}`)
        if (url === '') throw new Error('媒体缺少下载地址')
        this.#assertCdnOrigin(url)
        const response = await this.#fetch(url, { signal: this.#cdnSignal(signal), redirect: 'error' })
        if (!response.ok) throw new Error(`CDN 下载失败 HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > this.#maxMediaBytes + 16) throw new Error(`媒体超过 ${this.#maxMediaBytes} 字节限制`)
        const encrypted = new Uint8Array(await response.arrayBuffer())
        if (encrypted.byteLength > this.#maxMediaBytes + 16) throw new Error(`媒体超过 ${this.#maxMediaBytes} 字节限制`)
        const data = decryptMedia(encrypted, spec.key)
        if (data.byteLength > this.#maxMediaBytes) throw new Error(`媒体超过 ${this.#maxMediaBytes} 字节限制`)
        media.push({ kind: spec.kind, name: spec.name, mediaType: mediaTypeForName(spec.name, spec.kind), data })
      } catch (error) {
        if (signal.aborted) throw error
        errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { media, errors }
  }

  /** 媒体 URL 必须与配置的 CDN 同源，防止响应里夹带任意外链。 */
  #assertCdnOrigin(value: string): void {
    const parsed = new URL(value)
    const cdn = new URL(this.#cdnBase)
    if (parsed.protocol !== cdn.protocol || parsed.hostname !== cdn.hostname || parsed.port !== cdn.port) {
      throw new Error('微信媒体地址不在配置的 CDN 源内')
    }
  }

  /**
   * CDN 直连请求的信号：在调用方信号之上叠加请求超时——挂死的 CDN 连接
   * 不能卡死整条消息管道（API 请求在 #post 里已有同样的超时叠加）。
   */
  #cdnSignal(signal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs)
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  }

  async #notifyStateChange(): Promise<void> {
    await this.#onStateChange?.({ updatesBuffer: this.#checkpointedBuffer, contextTokens: Object.fromEntries(this.#contextTokens) })
  }

  async #post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const uin = randomBytes(4).readUInt32BE().toString()
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method: 'POST',
      signal: requestSignal,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorizationtype: 'ilink_bot_token',
        authorization: `Bearer ${this.#token}`,
        'x-wechat-uin': Buffer.from(uin).toString('base64'),
        'ilink-app-id': 'bot',
        'ilink-app-clientversion': String(CLIENT_VERSION),
      },
      body: JSON.stringify(payload),
    })
    const responseText = await cappedText(response, MAX_RESPONSE_CHARS)
    if (!response.ok) throw new Error(`微信 HTTP ${response.status}: ${responseText.slice(0, 500)}`)
    try {
      return JSON.parse(responseText) as T
    } catch {
      // 网关/代理返回 HTML 等非 JSON 200 时给出可诊断的错误，而不是裸 SyntaxError
      //（那条「Unexpected token '<'」既看不出来源，也会在轮询侧被静默吞掉）。
      throw new Error(`微信响应不是有效 JSON（HTTP ${response.status}）：${responseText.slice(0, 120)}`)
    }
  }

  #assertSuccess(result: ApiResponse, operation: string): void {
    if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
      throw new ILinkProtocolError(
        operation,
        result.ret ?? 0,
        result.errcode ?? 0,
        `${operation} 失败 (ret=${result.ret ?? 0}, errcode=${result.errcode ?? 0}): ${result.errmsg ?? '未知错误'}`,
      )
    }
  }
}

/** 流式读取响应体，超过 cap 字节立即中止——限制的是内存而非仅 JSON.parse 成本。 */
async function cappedText(response: Response, capBytes: number): Promise<string> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > capBytes) {
      await reader.cancel()
      throw new Error(`微信响应超过 ${Math.floor(capBytes / 1024 / 1024)} MiB`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}
