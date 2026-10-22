// Settings of the capture channels the server runs, kept in the database (meta) so the app can
// change them: the chats the Telegram bot listens in, and the chats it ignored lately (so one can
// be allowed with a click). TELEGRAM_ALLOWED_CHAT_IDS is only the first value: it seeds the list
// once, and Settings › Telegram changes it from then on.
import type { NodeStore } from '@vasta/core/node'

export interface TelegramChat {
  id: number
  /** The group's title, or the person's name in a private chat, when the bot has seen it. */
  title?: string
}

export interface IgnoredChat extends TelegramChat {
  /** When the bot last ignored a message there. */
  at: string
}

const ALLOWED_KEY = 'telegram.allowedChats'
const IGNORED_KEY = 'telegram.ignoredChats'
const IGNORED_KEPT = 10

export class ChannelSettings {
  private readonly store: NodeStore

  constructor(store: NodeStore) {
    this.store = store
  }

  /** Use the env list when the app never set one. */
  seedAllowedChats(ids: number[]) {
    if (this.store.getMeta(ALLOWED_KEY) === undefined && ids.length) this.setAllowedChats(ids.map((id) => ({ id })))
  }

  /** The chats the bot listens in; empty: any chat a linked account writes in. */
  allowedChats(): TelegramChat[] {
    return read<TelegramChat[]>(this.store.getMeta(ALLOWED_KEY)) ?? []
  }

  setAllowedChats(chats: TelegramChat[]) {
    const seen = new Set<number>()
    const clean = chats.flatMap((chat) => {
      const id = Number(chat.id)
      if (!Number.isInteger(id) || id === 0 || seen.has(id)) return []
      seen.add(id)
      const title = typeof chat.title === 'string' ? chat.title.trim().slice(0, 200) : ''
      return [{ id, ...(title ? { title } : {}) }]
    })
    this.store.setMeta(ALLOWED_KEY, JSON.stringify(clean))
    // An allowed chat is not "ignored" any more.
    this.store.setMeta(IGNORED_KEY, JSON.stringify(this.ignoredChats().filter((c) => !seen.has(c.id))))
    return clean
  }

  /** Chats whose messages the bot ignored because they are not in the list, latest first. */
  ignoredChats(): IgnoredChat[] {
    return read<IgnoredChat[]>(this.store.getMeta(IGNORED_KEY)) ?? []
  }

  noteIgnoredChat(chat: TelegramChat, at: string) {
    const rest = this.ignoredChats().filter((c) => c.id !== chat.id)
    this.store.setMeta(IGNORED_KEY, JSON.stringify([{ ...chat, at }, ...rest].slice(0, IGNORED_KEPT)))
  }
}

function read<T>(value: string | undefined): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}
