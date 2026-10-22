// Capture service: everything that arrives from outside the app (the HTTP capture API, the
// Telegram bot, and later email, iOS Shortcuts, Raycast…) goes through these functions. Each
// captured item is logged in today's daily note as a callout carrying the channel icon and time.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  NutritionError,
  appendCapture,
  applyCaptureLine,
  describeCapture,
  findType,
  foodLineAnswer,
  logFoodLine,
  type FoodLineAnswer,
  objectFromLine,
  type LineContext,
  type LineObject,
  type ParsedLine,
  BODY_PROPERTY_ID,
  builtinTypeId,
  type CaptureInfo,
  type Doc,
  type DocNode,
  type Id,
  type IsoDateTime,
  type MediaInfo,
  type ObjectRecord,
  type ObjectType,
  type PropertyValue,
  type SystemTypeKey,
} from '@vasta/core'
import type { MediaStore } from '@vasta/core/media'
import type { NodeStore } from '@vasta/core/node'
import { findOrCreateDailyNote, isValidDay, localDay } from './daily.ts'
import type { ChangeFeed } from './events.ts'
import { imageSize } from './image-size.ts'
import { findUrls, textToBlocks, type TextSpan } from '@vasta/core'
import type { FetchPageMeta } from './web-meta.ts'
import { currentActor } from './actor.ts'
import { WeblinkError, WeblinkService } from './weblinks.ts'

export class CaptureError extends Error {}

/** Fields every capture accepts. */
export interface CaptureBase {
  /** Channel key shown on the daily-note block; defaults to "api". */
  channel?: string
  /** Space to capture into; defaults to the configured capture space. */
  spaceId?: Id
}

export interface NoteInput extends CaptureBase {
  text: string
  /** Formatting for `text` (UTF-16 offsets). Without it, URLs in the text are linked. */
  spans?: TextSpan[]
  /** Save each URL in the text as a weblink object too (default true). */
  saveLinks?: boolean
}

export interface WeblinkInput extends CaptureBase {
  url: string
  title?: string
  /** A note written next to the link, in the daily note and the weblink's body. */
  note?: string
}

export interface TaskInput extends CaptureBase {
  /** Required unless `line` gives one. */
  title?: string
  /** A first line to read the title and properties from, e.g. "Buy coffee due:friday priority:high" (capture-props.ts). */
  line?: string
  note?: string
  /** "YYYY-MM-DD" or an ISO date-time. */
  due?: string
  priority?: 'high' | 'medium' | 'low'
}

export interface ObjectInput extends CaptureBase {
  /** Type id, built-in key ("page", "task"…), or type name / plural name (case and accents ignored). */
  type: string
  title?: string
  /** A first line to read the title and properties from, e.g. `Dune author:"Frank Herbert" rating:5` (capture-props.ts). */
  line?: string
  /** Body text. */
  text?: string
  props?: Record<Id, PropertyValue>
}

export interface FoodInput extends Omit<CaptureBase, 'channel'> {
  /** What was eaten, as after /food: "2 slices of bread, coffee 200 ml at breakfast" (core's nutrition.ts). */
  text: string
}

export interface FileInput extends CaptureBase {
  data: Uint8Array
  name: string
  mimeType?: string
  caption?: string
  captionSpans?: TextSpan[]
}

export interface CaptureResult {
  dailyNote: ObjectRecord
  /** Id of the callout block added to the daily note. */
  blockId: Id
  /** Objects the capture created or reused (weblinks, tasks, media…). */
  objects: ObjectRecord[]
  /** What a task or object capture understood, for a channel's reply: "Task “Buy coffee”, due Fri 24 Oct, priority High". */
  summary?: string
  /** Properties in the line whose values could not be read (they stayed in the title). */
  unreadable?: string[]
}

export interface CaptureOptions {
  store: NodeStore
  media: MediaStore
  feed?: ChangeFeed
  now?: () => IsoDateTime
  /** IANA time zone that decides which day "today" is. */
  timeZone: string
  /** Space used when a capture names none; defaults to the first space. */
  defaultSpaceId?: Id
  /** Saves captured links; without it, links are saved with `fetchMeta` and nothing in the background. */
  weblinks?: WeblinkService
  fetchMeta?: FetchPageMeta
  /** Also save a readable copy of each newly captured page (in the background). */
  saveReadable?: boolean
  /** Spaces captures may go to; any space when missing. */
  allowSpace?: (spaceId: Id) => boolean
  /** The user captures are made for (runAs), when the caller does not already run as them. */
  actor?: Id
}

/** What differs between users of one capture service. */
export type CaptureScope = Pick<CaptureOptions, 'defaultSpaceId' | 'timeZone' | 'allowSpace' | 'actor'>

function mediaKind(mimeType: string | undefined, name: string): SystemTypeKey {
  const mime = mimeType ?? ''
  const extension = path.extname(name).toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

const bodyDoc = (blocks: DocNode[]): Record<Id, Doc> => (blocks.length ? { [BODY_PROPERTY_ID]: { type: 'doc', content: blocks } } : {})

const isEmptyParagraph = (node: DocNode) => node.type === 'paragraph' && !node.content?.length

export class CaptureService {
  private readonly store: NodeStore
  private readonly media: MediaStore
  private readonly feed: ChangeFeed | undefined
  private readonly now: () => IsoDateTime
  readonly timeZone: string
  private readonly defaultSpaceId: Id | undefined
  private readonly weblinks: WeblinkService
  private readonly saveReadable: boolean
  private readonly options: CaptureOptions
  readonly actor: Id | undefined

  constructor(options: CaptureOptions) {
    this.options = options
    this.actor = options.actor
    this.store = options.store
    this.media = options.media
    this.feed = options.feed
    this.now = options.now ?? (() => new Date().toISOString())
    this.timeZone = options.timeZone
    this.defaultSpaceId = options.defaultSpaceId
    this.weblinks = options.weblinks ?? new WeblinkService({ store: this.store, media: this.media, now: this.now, ...(options.feed ? { feed: options.feed } : {}), ...(options.fetchMeta ? { fetchMeta: options.fetchMeta } : {}) })
    this.saveReadable = options.saveReadable ?? false
  }

  /** The same service for one user: their default space and time zone, only their spaces. */
  scoped(scope: Partial<CaptureScope>): CaptureService {
    return new CaptureService({ ...this.options, ...scope, weblinks: this.weblinks })
  }

  /** The space a capture goes to. */
  spaceId(requested?: Id): Id {
    const allowed = (id: Id) => !this.options.allowSpace || this.options.allowSpace(id)
    const id = requested ?? this.defaultSpaceId ?? this.store.listSpaces().find((s) => allowed(s.id))?.id
    if (!id || !this.store.getSpace(id) || !allowed(id)) throw new CaptureError(requested ? `unknown space ${requested}` : 'no space to capture into')
    return id
  }

  today(): string {
    return localDay(this.now(), this.timeZone)
  }

  /** Today's daily note (in the capture time zone), created if needed. */
  todayNote(spaceId?: Id): ObjectRecord {
    const space = this.spaceId(spaceId)
    const { note, created } = findOrCreateDailyNote(this.store, space, this.today(), this.now())
    if (created) this.changed(note)
    return note
  }

  /** Free text into today's daily note. URLs in it are saved as weblinks and shown below the text. */
  async note(input: NoteInput): Promise<CaptureResult> {
    const text = input.text ?? ''
    if (!text.trim()) throw new CaptureError('text is required')
    const spaceId = this.spaceId(input.spaceId)
    const linked = (input.spans ?? []).flatMap((span) => (span.mark.type === 'link' ? [span.mark.attrs.href] : []))
    const urls = input.saveLinks === false ? [] : [...new Set([...findUrls(text), ...linked])].filter((url) => /^https?:\/\//i.test(url))
    const links = await Promise.all(urls.map((url) => this.prepareWeblink(spaceId, { url })))
    // A message that is only a link shows just the link card.
    const onlyLink = urls.length === 1 && text.trim() === urls[0]
    const blocks = [
      ...(onlyLink ? [] : textToBlocks(text, input.spans)),
      ...links.map((link) => this.embed(link.id, 'wide-card')),
    ]
    return this.commit(spaceId, input.channel, links, blocks)
  }

  async weblink(input: WeblinkInput): Promise<CaptureResult> {
    const url = input.url?.trim()
    if (!url || !/^https?:\/\//i.test(url)) throw new CaptureError('a http(s) url is required')
    const spaceId = this.spaceId(input.spaceId)
    const link = await this.prepareWeblink(spaceId, { ...input, url })
    const blocks = [...(input.note?.trim() ? textToBlocks(input.note) : []), this.embed(link.id, 'wide-card')]
    return this.commit(spaceId, input.channel, [link], blocks)
  }

  async task(input: TaskInput): Promise<CaptureResult> {
    const spaceId = this.spaceId(input.spaceId)
    const type = this.store.getType(builtinTypeId(spaceId, 'task'))
    if (!type) throw new CaptureError('this space has no task type')
    const props: Record<Id, PropertyValue> = {}
    if (input.due) {
      const day = input.due.length === 10
      if (day ? !isValidDay(input.due) : Number.isNaN(Date.parse(input.due))) throw new CaptureError('due must be YYYY-MM-DD or an ISO date-time')
      props.due = { kind: 'date', value: day ? { start: `${input.due}T00:00:00.000Z`, resolution: 'day' } : { start: new Date(input.due).toISOString(), resolution: 'time' } }
    }
    if (input.priority) {
      if (!['high', 'medium', 'low'].includes(input.priority)) throw new CaptureError('priority must be high, medium or low')
      props.priority = { kind: 'select', value: [input.priority] }
    }
    // Fields given on their own win over the line.
    const made = this.fromLine(type, { ...input, props, ...(input.note ? { text: input.note } : {}) })
    if (!made.object.title) throw new CaptureError('title is required')
    return this.commitLine(spaceId, input.channel, type, made)
  }

  async object(input: ObjectInput): Promise<CaptureResult> {
    const spaceId = this.spaceId(input.spaceId)
    const type = this.resolveType(spaceId, input.type ?? '')
    if (!type) throw new CaptureError(`unknown type "${input.type}"`)
    if (type.system === 'daily-note') throw new CaptureError('use the note capture for daily notes')
    return this.commitLine(spaceId, input.channel, type, this.fromLine(type, input))
  }

  /**
   * Log a line of food on the day's note (core's logFoodLine); not an inbox item, so no callout.
   * `summary` is the reply for a channel.
   */
  food(input: FoodInput): FoodLineAnswer {
    const spaceId = this.spaceId(input.spaceId)
    try {
      const result = logFoodLine(this.store, spaceId, String(input.text ?? ''), { today: this.today(), timeZone: this.timeZone }, this.now())
      for (const food of result.created) this.changed(food)
      if (result.note) this.changed(result.note)
      return foodLineAnswer(result, this.today())
    } catch (error) {
      if (error instanceof NutritionError) throw new CaptureError(error.message)
      throw error
    }
  }

  /**
   * Make what a parsed line needs (capture-line.ts): new select options are added to the type,
   * relation titles become the matching objects of the space or new ones (returned in `related`,
   * to be written).
   */
  applyLine(spaceId: Id, type: ObjectType, parsed: ParsedLine): { props: Record<Id, PropertyValue>; related: ObjectRecord[] } {
    const { props, related, type: updated } = applyCaptureLine(this.store, spaceId, type, parsed, this.now(), this.lineContext(spaceId))
    if (updated) this.writeType(type, updated)
    return { props, related }
  }

  /** Match a type by id, built-in key, or (folded) name or plural name. */
  resolveType(spaceId: Id, query: string): ObjectType | undefined {
    return findType(this.store.listTypes(spaceId), query)
  }

  private fromLine(type: ObjectType, input: { title?: string; line?: string; text?: string; props?: Record<Id, PropertyValue> }): LineObject {
    const { title, line, text, props } = input
    return objectFromLine(this.store, { type, title, line, text, props, at: this.now(), context: this.lineContext(type.spaceId) })
  }

  /** What capture lines are read against: today, the zone, and the space's members (`assignee:ana`). */
  lineContext(spaceId: Id): LineContext {
    const me = this.actor ?? currentActor()
    return { today: this.today(), timeZone: this.timeZone, people: this.store.people(spaceId), ...(me ? { me } : {}) }
  }

  private commitLine(spaceId: Id, channel: string | undefined, type: ObjectType, made: LineObject): CaptureResult {
    if (made.type) this.writeType(type, made.type)
    const result = this.commit(spaceId, channel, [made.object, ...made.related], [this.embed(made.object.id, 'inline')], true)
    const titles = new Map(result.objects.map((o) => [o.id, o.title]))
    const summary = describeCapture(type, made.object, made.parsed, this.timeZone, (id) => titles.get(id) ?? this.store.getObject(id)?.title ?? '?', (id) => this.store.getUser(id)?.name ?? '?')
    return { ...result, summary, ...(made.parsed?.errors.length ? { unreadable: made.parsed.errors } : {}) }
  }

  private writeType(type: ObjectType, updated: ObjectType) {
    this.store.putType(updated)
    Object.assign(type, updated)
    this.feed?.emit({ kind: 'type', id: type.id, spaceId: type.spaceId })
  }

  /** A file (photo, voice message, document…) stored in the media store as an object of the matching type. */
  async file(input: FileInput): Promise<CaptureResult> {
    const spaceId = this.spaceId(input.spaceId)
    const { object, kind } = await this.mediaObject(spaceId, input)
    const blocks = [...(input.caption?.trim() ? textToBlocks(input.caption, input.captionSpans) : []), this.embed(object.id, kind === 'image' ? 'card' : 'inline')]
    return this.commit(spaceId, input.channel, [object], blocks, true)
  }

  /** Store a file as a new image/PDF/audio/video/file object in a space, without a daily-note entry (uploads from the editor). */
  async upload(spaceId: Id, input: Omit<FileInput, 'channel' | 'spaceId'>): Promise<ObjectRecord> {
    const { object } = await this.mediaObject(spaceId, input)
    this.store.putObject(object)
    this.changed(object)
    return object
  }

  private async mediaObject(spaceId: Id, input: Omit<FileInput, 'channel' | 'spaceId'>) {
    if (!input.data?.byteLength) throw new CaptureError('file is empty')
    const stored = await this.media.put(input.data, input.name, input.mimeType)
    const kind = mediaKind(input.mimeType, input.name)
    const size = kind === 'image' ? imageSize(input.data) : undefined
    const media: MediaInfo = { file: stored, sizeBytes: stored.sizeBytes, ...(input.mimeType ? { mimeType: input.mimeType } : {}), ...size }
    const object = this.newObject(spaceId, builtinTypeId(spaceId, kind), {
      title: '',
      media,
      content: bodyDoc(input.caption ? textToBlocks(input.caption, input.captionSpans) : []),
    })
    return { object, kind }
  }

  // -------------------------------------------------------------------------

  private newObject(spaceId: Id, typeId: Id, data: Partial<ObjectRecord>): ObjectRecord {
    const at = this.now()
    return { aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, title: '', ...data, id: randomUUID(), spaceId, typeId, createdAt: at, updatedAt: at }
  }

  /** The weblink object for a URL: the one saved before, or a new one with the page's metadata. */
  private async prepareWeblink(spaceId: Id, input: WeblinkInput): Promise<ObjectRecord> {
    try {
      return (await this.weblinks.prepare(spaceId, input)).object
    } catch (error) {
      if (error instanceof WeblinkError) throw new CaptureError(`invalid url ${input.url}`)
      throw error
    }
  }

  private embed(objectId: Id, display: 'inline' | 'card' | 'wide-card'): DocNode {
    return { type: 'objectEmbed', attrs: { objectId, display } }
  }

  /**
   * Write the new objects and append the capture block to today's daily note. Runs without
   * awaiting, so concurrent captures cannot interleave between reading and writing the note.
   */
  private commit(spaceId: Id, channel = 'api', objects: ObjectRecord[], blocks: DocNode[], alwaysNew = false): CaptureResult {
    const at = this.now()
    const capture: CaptureInfo = { id: randomUUID(), channel, at }
    const created: ObjectRecord[] = []
    const result = this.store.transaction(() => {
      for (const object of objects) {
        // Reused weblinks already exist; only new objects (or ones the caller marks new) are written.
        if (alwaysNew || !this.store.getObject(object.id)) (this.store.putObject(object), created.push(object))
      }
      const dailyNote = appendCapture(this.store, spaceId, localDay(at, this.timeZone), capture, blocks)
      return { dailyNote, blockId: capture.id, objects }
    })
    for (const object of objects) this.changed(object)
    this.changed(result.dailyNote)
    for (const object of created) if (object.typeId === builtinTypeId(spaceId, 'weblink')) this.weblinks.enrich(object.id, { readable: this.saveReadable })
    return result
  }

  private changed(object: ObjectRecord) {
    this.feed?.emit({ kind: 'object', id: object.id, spaceId: object.spaceId, typeId: object.typeId, updatedAt: object.updatedAt })
  }
}

/**
 * Keep items captured while a client was editing an older copy of an object: top-level capture
 * blocks in the stored version that are newer than the client's copy and missing from it are
 * appended to the client's version, and rich-text fields missing from the client's copy are kept.
 * Returns the merged object, or the incoming one unchanged.
 */
export function mergeCaptures(stored: ObjectRecord, incoming: ObjectRecord): ObjectRecord {
  if (!incoming.updatedAt || incoming.updatedAt >= stored.updatedAt) return incoming
  let merged = incoming
  for (const [field, doc] of Object.entries(stored.content)) {
    // A field the server added since (e.g. a weblink's readable text) is kept whole.
    if (!(field in incoming.content)) {
      merged = { ...merged, content: { ...merged.content, [field]: doc } }
      continue
    }
    const target = incoming.content[field]
    const present = new Set((target?.content ?? []).map((node) => captureOf(node)?.id).filter(Boolean))
    const missing = doc.content.filter((node) => {
      const capture = captureOf(node)
      return capture && capture.at > incoming.updatedAt && !present.has(capture.id)
    })
    if (!missing.length) continue
    const content = [...(target?.content ?? [])]
    while (content.length && isEmptyParagraph(content.at(-1)!)) content.pop()
    content.push(...missing, { type: 'paragraph' })
    merged = { ...merged, content: { ...merged.content, [field]: { type: 'doc', content } } }
  }
  return merged
}

function captureOf(node: DocNode): CaptureInfo | undefined {
  const capture = node.type === 'callout' ? (node.attrs?.capture as CaptureInfo | undefined) : undefined
  return capture && typeof capture.id === 'string' ? capture : undefined
}
