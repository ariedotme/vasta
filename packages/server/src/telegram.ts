// Telegram bot channel. Long-polls the Bot API (no public URL needed, which suits a homelab) and
// turns each message from a known sender into a capture in that user's daily note. One bot serves
// every user: a Vasta user's `telegramUserId` says whose messages are theirs.
//   plain text       note (URLs in it are also saved as weblinks)
//   photo, voice, audio, video, document   media object, caption as its note
//   /task <title>    task; more lines become the task's notes
//   /new <type> <title>   object of any type; more lines become its body
//   /food            what was eaten, logged on today's note: /food 2 slices of bread at breakfast
//                    Both read properties from the first line: /task Buy coffee due:friday priority:high
//                    (capture-props.ts)
//   /today           link to today's daily note
//   /id              your user id and this chat's id
//   /link <code>     link this Telegram account to the Vasta user who got the code in settings
//                    (also sent by the t.me/<bot>?start=link-<code> deep link)
import type { DocMark } from '@vasta/core'
import type { NodeStore } from '@vasta/core/node'
import { runAs } from './actor.ts'
import { AccountError, type AccountService } from './accounts.ts'
import { CaptureError, type CaptureResult, type CaptureService } from './capture.ts'
import { ChannelSettings } from './channels.ts'
import type { TextSpan } from '@vasta/core'

interface TelegramEntity {
  type: string
  offset: number
  length: number
  url?: string
}

interface TelegramFile {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  /** `title` for groups and channels; names for a private chat. */
  chat: { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string }
  /** Sender; missing for messages sent on behalf of a channel. */
  from?: { id: number; first_name?: string; username?: string }
  date: number
  text?: string
  entities?: TelegramEntity[]
  caption?: string
  caption_entities?: TelegramEntity[]
  photo?: (TelegramFile & { width: number; height: number })[]
  document?: TelegramFile
  voice?: TelegramFile
  audio?: TelegramFile
  video?: TelegramFile
  video_note?: TelegramFile
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramSender {
  userId?: number
  chatId: number
  /** The chat's title or the person's name, to show in Settings when the chat is not allowed. */
  chatTitle?: string
}

export interface TelegramBotOptions {
  token: string
  /** The capture service of the user a message belongs to; undefined ignores the message. */
  captureFor: (sender: TelegramSender) => CaptureService | undefined
  /** Link the sender to the Vasta user holding `code`; returns the reply. */
  link?: (code: string, telegramUserId: number) => string
  /** While true, the bot replies to every message with the sender's ids and saves nothing. */
  setupMode?: () => boolean
  /** Stores the polling offset so a restart does not capture the same messages twice. */
  store: NodeStore
  /** Base URL of the web app, used to link to the daily note in replies. */
  webUrl?: string
  apiBase?: string
  fetch?: typeof fetch
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

/**
 * Who may capture through the bot. A sender linked to a Vasta user (Settings › Telegram, or
 * `vasta user telegram`) captures as that user. The chats the bot listens in are a setting
 * (channels.ts, Settings › Telegram; TELEGRAM_ALLOWED_CHAT_IDS seeds it): when it lists chats,
 * messages elsewhere are ignored and the chat is remembered so it can be allowed. A chat in the
 * list does not let strangers in: only linked accounts capture there. The older
 * TELEGRAM_ALLOWED_USER_IDS still names senders who capture as the oldest user.
 */
export function telegramAccess(options: { store: NodeStore; accounts: AccountService; channels?: ChannelSettings; allowedChatIds?: number[]; allowedUserIds?: number[]; now?: () => string }) {
  const { store, accounts } = options
  const channels = options.channels ?? new ChannelSettings(store)
  channels.seedAllowedChats(options.allowedChatIds ?? [])
  const legacyUsers = options.allowedUserIds ?? []
  const now = options.now ?? (() => new Date().toISOString())
  return {
    captureFor({ userId, chatId, chatTitle }: TelegramSender): CaptureService | undefined {
      const chats = channels.allowedChats().map((c) => c.id)
      if (chats.length && !chats.includes(chatId)) {
        channels.noteIgnoredChat({ id: chatId, ...(chatTitle ? { title: chatTitle } : {}) }, now())
        return undefined
      }
      const linked = userId === undefined ? undefined : store.findUserByTelegram(userId)
      const legacy = userId !== undefined && legacyUsers.includes(userId)
      const user = linked ?? (legacy ? store.listUsers()[0] : undefined)
      return user && accounts.captureFor(user)
    },
    link(code: string, telegramUserId: number): string {
      try {
        const user = accounts.linkTelegram(code, telegramUserId)
        return `Linked to ${user.name} (${user.username}) in Vasta. What you send me now goes into your daily note.`
      } catch (error) {
        if (error instanceof AccountError) return `Not linked: ${error.message}.`
        throw error
      }
    },
    setupMode: () => !legacyUsers.length && !store.listUsers().some((u) => u.telegramUserId !== undefined),
  }
}

/** A group's title, or the person's name in a private chat. */
const chatName = (chat: TelegramMessage['chat']) => chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : undefined))

const OFFSET_KEY = 'telegram.offset'
const CHANNEL = 'telegram'

const HELP = `Send me anything and it goes into today's daily note in Vasta.

• Text, links, photos, voice messages and files are saved as they are; links also become weblinks.
• /task Buy coffee — saves a task (more lines become its notes)
• /new Book Dune — creates an object of any type (more lines become its body)
• /food 2 slices of bread, coffee 200 ml at breakfast — logs what you ate ("yesterday" at the end for yesterday)
• Properties go in the first line as name:value — /task Buy coffee due:friday 3pm priority:high, /new Book Dune author:"Frank Herbert" rating:5. Dates: today, tomorrow, friday, 2026-10-25, with an optional time (3pm, 9:30). Use quotes for values with spaces.
• /today — link to today's note
• /id — your user id and this chat's id
• /link <code> — link this Telegram account to your Vasta user (the code is in Vasta's settings)`

/** "Saved: Task “Buy coffee”, due Fri 24 Oct, priority High", and what could not be read. */
function savedReply(result: CaptureResult): string {
  const unreadable = result.unreadable?.length ? `\nCould not read ${result.unreadable.join(', ')}; it stayed in the title.` : ''
  return `Saved: ${result.summary ?? result.objects[0]?.title ?? ''}${unreadable}`
}

function entitySpans(text: string, entities: TelegramEntity[] | undefined): TextSpan[] | undefined {
  if (!entities?.length) return undefined
  const spans: TextSpan[] = []
  for (const entity of entities) {
    let mark: DocMark | undefined
    if (entity.type === 'bold') mark = { type: 'bold' }
    else if (entity.type === 'italic') mark = { type: 'italic' }
    else if (entity.type === 'strikethrough') mark = { type: 'strike' }
    else if (entity.type === 'code' || entity.type === 'pre') mark = { type: 'code' }
    else if (entity.type === 'text_link' && entity.url) mark = { type: 'link', attrs: { href: entity.url } }
    else if (entity.type === 'url') {
      const raw = text.slice(entity.offset, entity.offset + entity.length)
      mark = { type: 'link', attrs: { href: /^https?:\/\//i.test(raw) ? raw : `https://${raw}` } }
    }
    if (mark) spans.push({ offset: entity.offset, length: entity.length, mark })
  }
  return spans
}

/** Spans of the text after `cut` characters were removed from its start. */
const shiftSpans = (spans: TextSpan[] | undefined, cut: number) =>
  spans?.filter((s) => s.offset >= cut).map((s) => ({ ...s, offset: s.offset - cut }))

export class TelegramBot {
  private readonly options: TelegramBotOptions
  private readonly fetch: typeof fetch
  private readonly apiBase: string
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>
  private controller: AbortController | undefined
  /** The bot's @username, known once it started. */
  username: string | undefined

  constructor(options: TelegramBotOptions) {
    this.options = options
    this.fetch = options.fetch ?? fetch
    this.apiBase = options.apiBase ?? 'https://api.telegram.org'
    this.log = options.log ?? console
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.fetch(`${this.apiBase}/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const data = (await response.json()) as { ok: boolean; result: T; description?: string; error_code?: number }
    if (!data.ok) throw Object.assign(new Error(`Telegram ${method}: ${data.description ?? response.status}`), { code: data.error_code })
    return data.result
  }

  /** Poll until stop() is called. */
  async start() {
    this.controller = new AbortController()
    const { signal } = this.controller
    try {
      const me = await this.call<{ username: string }>('getMe', {}, signal)
      this.username = me.username
      this.log.info(`Telegram bot @${me.username} is listening`)
      await this.call('setMyCommands', {
        commands: [
          { command: 'task', description: 'Save a task' },
          { command: 'new', description: 'Create an object: /new <type> <title>' },
          { command: 'food', description: 'Log food: /food rice 150g at lunch' },
          { command: 'today', description: "Link to today's daily note" },
          { command: 'id', description: "Your user id and this chat's id" },
          { command: 'link', description: 'Link this account: /link <code from Vasta settings>' },
          { command: 'help', description: 'What this bot does' },
        ],
      }, signal).catch(() => {})
    } catch (error) {
      if (signal.aborted) return
      this.log.error(`Telegram bot could not start: ${(error as Error).message}`)
    }
    let delay = 1000
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal)
        delay = 1000
      } catch (error) {
        if (signal.aborted) break
        const conflict = (error as { code?: number }).code === 409
        this.log.warn(conflict ? 'Telegram: another process is polling this bot; retrying' : `Telegram polling failed: ${(error as Error).message}`)
        await new Promise((resolve) => setTimeout(resolve, conflict ? 10_000 : delay))
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  stop() {
    this.controller?.abort()
  }

  /** Fetch and handle one batch of updates. */
  async pollOnce(signal?: AbortSignal, timeout = 50) {
    const offset = Number(this.options.store.getMeta(OFFSET_KEY) ?? 0)
    const updates = await this.call<TelegramUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message'] }, signal)
    for (const update of updates) {
      try {
        if (update.message) await this.handle(update.message)
      } catch (error) {
        this.log.error(`Telegram update ${update.update_id} failed: ${(error as Error).message}`)
      }
      // Acknowledge each update once handled, even when it failed, so one bad message cannot block the queue.
      this.options.store.setMeta(OFFSET_KEY, String(update.update_id + 1))
    }
  }

  private ids(message: TelegramMessage): string {
    return `Your user id: ${message.from?.id ?? 'unknown'}\nThis chat's id: ${message.chat.id}`
  }

  async handle(message: TelegramMessage) {
    // Linking comes first: it is how a sender becomes known, even while nobody is linked yet.
    const link = /^\/(?:link(?:@\w+)?\s+|start(?:@\w+)?\s+link-)(\S+)\s*$/i.exec(message.text ?? '')
    if (link && this.options.link && message.from && message.chat.type === 'private') {
      await this.reply(message, this.options.link(link[1]!, message.from.id))
      return
    }
    // Nobody allowed yet: tell whoever writes their ids so they can be linked, and save nothing.
    if (this.options.setupMode?.()) {
      const id = message.from?.id ?? '<user id>'
      await this.reply(message, `${this.ids(message)}\n\nTo link this Telegram account, open Settings in Vasta and send me the code it shows (/link <code>), or run \`vasta user telegram <username> ${id}\` on the server. Nothing is saved until then.`)
      return
    }
    const chatTitle = chatName(message.chat)
    const capture = this.options.captureFor({ ...(message.from ? { userId: message.from.id } : {}), chatId: message.chat.id, ...(chatTitle ? { chatTitle } : {}) })
    if (!capture) {
      this.log.warn(`Telegram: ignored a message from user ${message.from?.id ?? 'unknown'} in chat ${message.chat.id} (not linked to a Vasta user, or a chat the bot does not listen in)`)
      return
    }
    try {
      await (capture.actor ? runAs(capture.actor, () => this.route(message, capture)) : this.route(message, capture))
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error
      await this.reply(message, `Not saved: ${error.message}`)
    }
  }

  private async route(message: TelegramMessage, capture: CaptureService) {
    const text = message.text ?? ''
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+|$)/i.exec(text)
    if (command) {
      const name = command[1]!.toLowerCase()
      const rest = text.slice(command[0].length)
      const [firstLine = '', ...more] = rest.split('\n')
      const note = more.join('\n').trim()
      if (name === 'start' || name === 'help') return this.reply(message, HELP)
      if (name === 'id') return this.reply(message, this.ids(message))
      if (name === 'today') {
        const day = capture.todayNote()
        const url = this.options.webUrl ? `${this.options.webUrl.replace(/\/$/, '')}/o/${day.id}` : undefined
        return this.reply(message, url ? `Today's note: ${url}` : `Today's note is ${capture.today()}. Set VASTA_WEB_URL to get a link.`)
      }
      if (name === 'task') {
        const result = await capture.task({ channel: CHANNEL, line: firstLine, ...(note ? { note } : {}) })
        return this.reply(message, savedReply(result))
      }
      if (name === 'new') return this.newObject(message, capture, firstLine, note)
      if (name === 'food') return this.reply(message, capture.food({ text: rest }).summary)
      if (name === 'note') {
        const spans = shiftSpans(entitySpans(text, message.entities), command[0].length)
        await capture.note({ channel: CHANNEL, text: rest, ...(spans ? { spans } : {}) })
        return this.react(message)
      }
      return this.reply(message, `Unknown command /${name}. Send /help to see what I can do.`)
    }

    const file = this.fileOf(message)
    if (file) {
      const data = await this.download(file.file_id)
      const caption = message.caption ?? ''
      const spans = entitySpans(caption, message.caption_entities)
      await capture.file({ channel: CHANNEL, data, name: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}), ...(caption ? { caption } : {}), ...(spans ? { captionSpans: spans } : {}) })
      return this.react(message)
    }

    if (text.trim()) {
      const spans = entitySpans(text, message.entities)
      await capture.note({ channel: CHANNEL, text, ...(spans ? { spans } : {}) })
      return this.react(message)
    }
    return this.reply(message, 'I can save text, links, photos, voice messages and files. This kind of message is not supported yet.')
  }

  /** "/new Book Dune": the longest leading run of words that names a type is the type. */
  private async newObject(message: TelegramMessage, capture: CaptureService, line: string, text: string) {
    const words = line.trim().split(/\s+/).filter(Boolean)
    const spaceId = capture.spaceId()
    for (let i = words.length; i >= 1; i--) {
      const type = capture.resolveType(spaceId, words.slice(0, i).join(' ').replace(/:$/, ''))
      if (!type) continue
      const result = await capture.object({ channel: CHANNEL, type: type.id, line: words.slice(i).join(' '), ...(text ? { text } : {}) })
      return this.reply(message, savedReply(result))
    }
    return this.reply(message, words.length ? `No type called “${words[0]}”. Usage: /new <type> <title>` : 'Usage: /new <type> <title>, e.g. /new Book Dune')
  }

  private fileOf(message: TelegramMessage): { file_id: string; name: string; mimeType?: string } | undefined {
    const id = message.message_id
    const photo = message.photo?.at(-1) // sizes are ordered smallest first
    if (photo) return { file_id: photo.file_id, name: `photo-${id}.jpg`, mimeType: 'image/jpeg' }
    const named = (file: TelegramFile | undefined, fallback: string, mime: string) =>
      file ? { file_id: file.file_id, name: file.file_name ?? fallback, mimeType: file.mime_type ?? mime } : undefined
    return (
      named(message.voice, `voice-${id}.ogg`, 'audio/ogg') ??
      named(message.audio, `audio-${id}.mp3`, 'audio/mpeg') ??
      named(message.video, `video-${id}.mp4`, 'video/mp4') ??
      named(message.video_note, `video-note-${id}.mp4`, 'video/mp4') ??
      (message.document ? { file_id: message.document.file_id, name: message.document.file_name ?? `file-${id}`, ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}) } : undefined)
    )
  }

  private async download(fileId: string): Promise<Uint8Array> {
    let file: { file_path?: string }
    try {
      file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    } catch (error) {
      // The Bot API only hands out files up to 20 MB.
      throw new CaptureError(/too big/i.test((error as Error).message) ? 'the file is larger than the 20 MB Telegram lets bots download' : (error as Error).message)
    }
    if (!file.file_path) throw new CaptureError('Telegram did not return the file')
    const response = await this.fetch(`${this.apiBase}/file/bot${this.options.token}/${file.file_path}`)
    if (!response.ok) throw new Error(`file download failed: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** A message to a chat, as the bot (reminders: a linked user's private chat has their user id). */
  async send(chatId: number, text: string) {
    await this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } })
  }

  private async reply(message: TelegramMessage, text: string) {
    await this.call('sendMessage', { chat_id: message.chat.id, text, reply_parameters: { message_id: message.message_id }, link_preview_options: { is_disabled: true } })
  }

  /** A 👍 on the message says it was saved without adding noise to the chat. */
  private async react(message: TelegramMessage) {
    try {
      await this.call('setMessageReaction', { chat_id: message.chat.id, message_id: message.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] })
    } catch {
      await this.reply(message, 'Saved ✓')
    }
  }
}
