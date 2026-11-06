// What agents (Claude Code, Codex, the Claude app…) can do in Vasta, as one user: the tools of the
// MCP endpoint (mcp.ts), which the remote CLI calls too. Rich text goes in and out as Markdown
// (@vasta/core/markdown). Every write goes through the store and the change feed like the HTTP
// routes, so open apps and synced devices see it. See docs/agents.md.
import { randomUUID } from 'node:crypto'
import type { ColorName, DateValue, Doc, Filter, FilterOperator, FormulaValue, Icon, Id, ObjectRecord, ObjectSummary, ObjectType, PropertyDef, PropertyValue, QueryDef, User } from '@vasta/core'
import {
  BODY_PROPERTY_ID,
  COLOR_NAMES,
  childTag,
  isColorName,
  tagPath,
  tagPathParts,
  addDays,
  applyTemplate,
  defaultTemplate,
  findTemplate,
  templateAsks,
  typeTemplates,
  builtinTypeId,
  writeDailyText,
  CommentError,
  addComment,
  commentsOf,
  evaluateFormula,
  findPerson,
  formulaText,
  formulaToNames,
  habitDayValue,
  habitDoneKey,
  habitRemindAt,
  habitStats,
  habitTarget,
  habitUnit,
  habitValue,
  habitWeekdays,
  isHabitDone,
  isHabitPaused,
  isHabitScheduled,
  newObject,
  parseProperties,
  querySpace,
  AmountError,
  NutritionError,
  dayEntries,
  entryLabel,
  dayTotals,
  deleteFoodEntry,
  foodBrand,
  foodLineAnswer,
  foodNutrients,
  foodPortions,
  habitFoodRule,
  habitsWithFood,
  goalForDay,
  groupByMeal,
  isDayCounted,
  isFood,
  isNutritionOn,
  isRecipe,
  logFood,
  logFoodLine,
  portionsValue,
  readGoals,
  recipeFacts,
  recipeIngredients,
  sourceUsage,
  weekBudget,
  DEFAULT_MEALS,
  type FoodEntry,
  type FoodPortion,
  type Nutrients,
} from '@vasta/core'
import {
  ARROW_HEADS,
  ARROW_PATHS,
  CARD_VIEWS,
  CanvasError,
  MermaidError,
  NODE_SIZE,
  addBoardElements,
  boardToJsonCanvas,
  graphToElements,
  gridBoxes,
  isAttached,
  isPlaced,
  isShapeName,
  jsonCanvasToElements,
  parseMermaidFlowchart,
  readBoard,
  removeBoardElements,
  sendToBack,
  spotAfter,
  updateBoardElements,
  type BoardElement,
  type ArrowHeads,
  type ArrowPath,
  type BoardPatch,
  type CardView,
  type NewBoardElement,
} from '@vasta/core'
import { docToMarkdown, markdownToDoc } from '@vasta/core/markdown'
import type { NodeStore } from '@vasta/core/node'
import { Y, checkDoc } from '@vasta/editor-schema/yjs'
import type { AccountService } from './accounts.ts'
import type { CaptureService } from './capture.ts'
import { isValidDay } from './daily.ts'
import type { ChangeFeed } from './events.ts'
import { parseIcon } from './icons.ts'
import { listInbox } from './inbox.ts'

export class AgentError extends Error {}

/** An element an agent adds to a whiteboard; "ref" names it for arrows in the same edit. */
export interface BoardAddInput {
  ref?: string
  kind: 'card' | 'text' | 'sticky' | 'shape' | 'frame'
  object?: string
  text?: string
  shape?: string
  title?: string
  color?: string
  x?: number
  y?: number
  w?: number
  h?: number
}
/** An arrow's look as agents give it. */
export interface ArrowStyleInput {
  path?: string
  heads?: string
  dashed?: boolean
}

/** An arrow's look checked; defaults ("straight", "end", not dashed) are left out (or cleared, for a change). */
function arrowStyle(input: ArrowStyleInput, clearing = false): { path?: ArrowPath | undefined; heads?: ArrowHeads | undefined; dashed?: true | undefined } {
  const out: { path?: ArrowPath | undefined; heads?: ArrowHeads | undefined; dashed?: true | undefined } = {}
  if (input.path !== undefined) {
    if (!ARROW_PATHS.includes(input.path as ArrowPath)) throw new AgentError(`unknown arrow path "${input.path}" (${ARROW_PATHS.join(', ')})`)
    if (input.path !== 'straight' || clearing) out.path = input.path === 'straight' ? undefined : (input.path as ArrowPath)
  }
  if (input.heads !== undefined) {
    if (!ARROW_HEADS.includes(input.heads as ArrowHeads)) throw new AgentError(`unknown arrow heads "${input.heads}" (${ARROW_HEADS.join(', ')})`)
    if (input.heads !== 'end' || clearing) out.heads = input.heads === 'end' ? undefined : (input.heads as ArrowHeads)
  }
  if (input.dashed !== undefined && (input.dashed || clearing)) out.dashed = input.dashed ? true : undefined
  return out
}

/** What an agent may change in an element. */
export interface BoardPatchInput extends ArrowStyleInput {
  x?: number
  y?: number
  w?: number
  h?: number
  text?: string
  title?: string
  shape?: string
  label?: string
  color?: string | null
  view?: string
}

export interface AgentOptions {
  store: NodeStore
  accounts: AccountService
  feed: ChangeFeed
  now: () => string
  user: User
  /** The web app's address, for links to objects. */
  webUrl: string
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

export class AgentTools {
  private readonly options: AgentOptions
  private readonly captures: CaptureService

  constructor(options: AgentOptions) {
    this.options = options
    this.captures = options.accounts.captureFor(options.user)
  }

  private get store() {
    return this.options.store
  }

  private url(id: Id) {
    return `${this.options.webUrl.replace(/\/$/, '')}/o/${id}`
  }

  private changed(object: ObjectRecord) {
    this.options.feed.emit({ kind: 'object', id: object.id, spaceId: object.spaceId, typeId: object.typeId, updatedAt: object.updatedAt })
  }

  /** A space of the user by id or name; their capture space when not given. */
  private space(query?: string) {
    const spaces = this.options.accounts.spacesOf(this.options.user)
    if (!query) {
      const id = this.options.accounts.captureSpaceId(this.options.user)
      const space = spaces.find((s) => s.id === id) ?? spaces[0]
      if (!space) throw new AgentError('you have no spaces')
      return space
    }
    const space = spaces.find((s) => s.id === query) ?? spaces.find((s) => fold(s.name) === fold(query))
    if (!space) throw new AgentError(`unknown space "${query}" (list_spaces shows yours)`)
    return space
  }

  private type(spaceId: Id, query: string): ObjectType {
    const type = this.captures.resolveType(spaceId, query)
    if (!type || type.deletedAt) throw new AgentError(`unknown type "${query}" (list_types shows the space's types)`)
    return type
  }

  /** An object the user can reach (not in the trash). */
  private object(id: Id): ObjectRecord {
    const object = this.store.getObject(id)
    if (!object || object.deletedAt || !this.options.accounts.canUse(this.options.user.id, object.spaceId)) throw new AgentError(`no object ${id}`)
    return object
  }

  private context(spaceId?: Id) {
    return spaceId ? this.captures.lineContext(spaceId) : { today: this.captures.today(), timeZone: this.captures.timeZone }
  }

  private titleOf = (id: Id) => this.store.getObjectSummaries([id])[0]?.title

  /** A person as agents see them: "Name (username)". */
  private personName = (id: Id) => {
    const user = this.store.getUser(id)
    return user ? `${user.name} (${user.username})` : id
  }

  // Reading -------------------------------------------------------------------

  spaces() {
    const captureSpace = this.options.accounts.captureSpaceId(this.options.user)
    return this.options.accounts.spacesOf(this.options.user).map((s) => ({ id: s.id, name: s.name, ...(s.id === captureSpace ? { default: true } : {}) }))
  }

  types(spaceQuery?: string) {
    const space = this.space(spaceQuery)
    const all = this.store.listTypes(space.id)
    const typeNames = new Map(all.map((t) => [t.id, t.name]))
    const counts = this.store.typeCounts(space.id)
    return this.store
      .listTypes(space.id)
      .filter((t) => !t.deletedAt)
      .map((t) => ({
        id: t.id,
        name: t.name,
        plural: t.pluralName,
        ...(t.system ? { builtIn: t.system } : {}),
        ...(t.description ? { description: t.description } : {}),
        objects: counts[t.id] ?? 0,
        properties: t.properties.map((p) => describeProperty(p, typeNames, t, all)),
      }))
  }

  private summary(object: ObjectSummary) {
    const type = this.store.getType(object.typeId)
    return {
      id: object.id,
      title: object.title,
      type: type?.name ?? '',
      updatedAt: object.updatedAt,
      ...(object.date ? { date: dateText(object.date) } : {}),
      ...(object.preview ? { preview: object.preview } : {}),
      url: this.url(object.id),
    }
  }

  search(text: string, options: { space?: string; limit?: number } = {}) {
    const space = this.space(options.space)
    return this.store.search(space.id, text, Math.min(Math.max(options.limit ?? 20, 1), 100)).map((o) => this.summary(o))
  }

  /** An object with its properties in words and its text as Markdown. */
  private coverUrl(value: string): string {
    const url = URL.parse(value.trim())
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw new AgentError('coverUrl must be an HTTP(S) URL')
    return url.href
  }

  private icon(value: string): Icon {
    const icon = parseIcon(value)
    if ('error' in icon) throw new AgentError(icon.error)
    return icon
  }

  private color(value: string): ColorName {
    const color = value.trim().toLowerCase()
    if (!isColorName(color)) throw new AgentError(`unknown color "${value}": use ${COLOR_NAMES.join(', ')} (null for the default)`)
    return color
  }

  /** Icon and color as given (null clears one), onto an object. */
  private looks(object: ObjectRecord, input: { icon?: string | null; color?: string | null }) {
    if (input.icon === null) delete object.icon
    else if (input.icon !== undefined) object.icon = this.icon(input.icon)
    if (input.color === null) delete object.color
    else if (input.color !== undefined) object.color = this.color(input.color)
  }

  /**
   * The ids of the tags paths name ("recipe/breakfast"), level by level as the app does; missing
   * levels are made (into `made`, to be saved with the object) unless `made` is not given, when a
   * path that names no tag is left out.
   */
  private tagIds(spaceId: Id, paths: string[], made?: ObjectRecord[]): Id[] {
    const tagType = this.store.getType(builtinTypeId(spaceId, 'tag'))
    if (!tagType) throw new AgentError('this space has no tags')
    const tags: Pick<ObjectRecord, 'id' | 'title' | 'parentId'>[] = [...this.store.listObjects(tagType.id), ...(made ?? [])]
    const ids: Id[] = []
    for (const path of paths) {
      const parts = tagPathParts(path)
      if (!parts.length) throw new AgentError(`"${path}" is not a tag`)
      let parentId: Id | undefined
      for (const title of parts) {
        let tag = childTag(tags, parentId, title)
        if (!tag && made) {
          const created = newObject(tagType, { title, ...(parentId ? { parentId } : {}) }, randomUUID(), this.options.now())
          made.push(created)
          tags.push(created)
          tag = created
        }
        parentId = tag?.id
        if (!tag) break
      }
      if (parentId && !ids.includes(parentId)) ids.push(parentId)
    }
    return ids
  }

  /** An object's tags after a change: added, removed or replaced by paths. */
  private retag(object: ObjectRecord, paths: string[], mode: 'add' | 'remove' | 'replace', made: ObjectRecord[]): Id[] {
    if (mode === 'replace') return this.tagIds(object.spaceId, paths, made)
    if (mode === 'add') return [...new Set([...object.tagIds, ...this.tagIds(object.spaceId, paths, made)])]
    // A one-part path also removes a nested tag of that title ("breakfast" for recipe/breakfast).
    const titles = new Set(paths.map(tagPathParts).filter((p) => p.length === 1).map((p) => p[0]!.toLowerCase()))
    const gone = new Set(this.tagIds(object.spaceId, paths))
    return object.tagIds.filter((id) => !gone.has(id) && !titles.has((this.titleOf(id) ?? '').trim().toLowerCase()))
  }

  setPinned(id: Id, pinned: boolean) {
    const object = this.object(id)
    const space = this.store.getSpace(object.spaceId)!
    const alreadyPinned = space.sidebar.some((section) => section.items.includes(id))
    if (pinned && !alreadyPinned) {
      const section = space.sidebar[0] ?? { id: randomUUID(), name: 'Pinned', items: [] }
      if (!space.sidebar.length) space.sidebar.push(section)
      section.items.push(id)
    } else if (!pinned && alreadyPinned) {
      for (const section of space.sidebar) section.items = section.items.filter((item) => item !== id)
    }
    if (pinned !== alreadyPinned) {
      this.store.putSpace(space)
      this.options.feed.emit({ kind: 'space', id: space.id, spaceId: space.id })
    }
    return this.getObject(id)
  }

  getObject(id: Id) {
    const object = this.object(id)
    const type = this.store.getType(object.typeId)
    const titles = (ids: Id[]) => ids.map((i) => ({ id: i, title: this.titleOf(i) ?? '' }))
    const properties: Record<string, unknown> = {}
    const text: Record<string, string> = {}
    const types = new Map(this.store.listTypes(object.spaceId).map((t) => [t.id, t]))
    for (const def of type?.properties ?? []) {
      if (def.kind === 'formula') {
        const related = (id: Id) => this.store.getObjectSummaries([id]).find((o) => o.spaceId === object.spaceId)
        const value = evaluateFormula(object, def, { types, related, personName: (id) => this.store.getUser(id)?.name, ...this.context() })
        if (value.kind !== 'empty') properties[def.name] = formulaOutput(value, this.captures.timeZone)
        continue
      }
      if (def.kind === 'rich-text') {
        const markdown = docToMarkdown(object.content[def.id], { titleOf: this.titleOf })
        if (markdown.trim()) text[def.name] = markdown
        continue
      }
      const value = object.props[def.id]
      if (value) properties[def.name] = valueOf(def, value, titles, this.personName)
    }
    const backlinks = this.store
      .backlinks(object.id)
      .filter((b) => this.options.accounts.canUse(this.options.user.id, b.object.spaceId) && !b.object.deletedAt)
      .map((b) => ({ id: b.object.id, title: b.object.title, kind: b.kind }))
    return {
      id: object.id,
      title: object.title,
      type: type?.name ?? '',
      space: this.store.getSpace(object.spaceId)?.name ?? '',
      url: this.url(object.id),
      coverUrl: object.coverUrl ?? null,
      icon: object.icon?.value ?? null,
      color: object.color ?? null,
      pinned: this.store.getSpace(object.spaceId)?.sidebar.some((section) => section.items.includes(id)) ?? false,
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
      ...(object.createdBy ? { createdBy: this.personName(object.createdBy) } : {}),
      ...(object.updatedBy ? { updatedBy: this.personName(object.updatedBy) } : {}),
      ...(object.date ? { date: dateText(object.date) } : {}),
      ...(object.tagIds.length ? { tags: object.tagIds.map((id) => tagPath(id, (at) => this.store.getObjectSummaries([at])[0])) } : {}),
      ...(object.media?.url ? { link: object.media.url } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(commentsOf(object).length ? { comments: commentsOf(object).map((c) => ({ by: this.personName(c.author), at: c.at, text: c.text })) } : {}),
      ...this.foodFacts(object),
      text,
      ...(type?.system === 'whiteboard' ? { board: `${readBoard(this.store.loadText(object.id) ?? new Y.Doc()).length} elements; read them with get_board, change them with edit_board` } : {}),
      ...(backlinks.length ? { backlinks } : {}),
    }
  }

  // Whiteboards ---------------------------------------------------------------------------------
  // A board's elements live in its Y.Doc (core board.ts); agents read and write them as nodes and
  // arrows with ids, and the change syncs like an edit made on a device.

  private whiteboard(id: Id) {
    const object = this.object(id)
    if (this.store.getType(object.typeId)?.system !== 'whiteboard') throw new AgentError(`"${object.title}" is not a whiteboard`)
    return object
  }

  /** An object of the board's space by id, link or exact title. */
  private boardObject(spaceId: Id, query: string): Id {
    const link = /\/o\/([^/?#\s]+)/.exec(query)?.[1]
    const byId = this.store.getObject(link ? decodeURIComponent(link) : query)
    if (byId && !byId.deletedAt && byId.spaceId === spaceId) return byId.id
    const found = this.store.search(spaceId, query, 20).find((o) => fold(o.title) === fold(query))
    if (!found) throw new AgentError(`no object "${query}" in the board's space (search finds objects; use its id)`)
    return found.id
  }

  /** What an agent sees of an element (a stroke's ink left out; boxes in board coordinates). */
  private boardElement(element: BoardElement, all: Map<Id, BoardElement>) {
    if (element.kind === 'arrow') {
      const { id, from, to, label, color, relation, path, heads, dashed, mentioned } = element
      return { id, kind: 'arrow', from, to, ...{ label, color, relation, path, heads, ...(dashed ? { dashed } : {}), ...(mentioned ? { mentioned } : {}) } }
    }
    let box = { x: element.x, y: element.y, w: element.w, h: element.h }
    if (isAttached(element)) {
      const parent = all.get(element.parent)
      if (parent && isPlaced(parent)) box = { x: parent.x + element.x * parent.w, y: parent.y + element.y * parent.h, w: element.w * parent.w, h: element.h * parent.h }
    }
    const rounded = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }
    const base = { id: element.id, kind: element.kind, ...rounded, ...(element.color ? { color: element.color } : {}) }
    switch (element.kind) {
      case 'card':
        return { ...base, object: { id: element.objectId, title: this.titleOf(element.objectId) ?? '(deleted)' }, ...(element.view ? { view: element.view } : {}) }
      case 'text':
      case 'sticky':
        return { ...base, text: element.text }
      case 'shape':
        return { ...base, shape: element.shape, text: element.text }
      case 'frame':
        return { ...base, ...(element.title ? { title: element.title } : {}) }
      case 'stroke':
        return { ...base, ...(element.parent ? { drawnOn: element.parent } : {}), ...(element.highlight ? { highlight: true } : {}) }
    }
  }

  /** A board's elements and arrows; "canvas" gives it as a JSON Canvas (jsoncanvas.org) instead. */
  getBoard(id: Id, format: 'elements' | 'canvas' = 'elements') {
    const object = this.whiteboard(id)
    const elements = readBoard(this.store.loadText(id) ?? new Y.Doc())
    if (format === 'canvas') return boardToJsonCanvas(elements, (objectId) => (this.titleOf(objectId) !== undefined ? { title: this.titleOf(objectId)!, url: this.url(objectId) } : undefined))
    const all = new Map(elements.map((e) => [e.id, e]))
    return {
      id: object.id,
      title: object.title,
      url: this.url(object.id),
      elements: elements.filter((e) => e.kind !== 'arrow').map((e) => this.boardElement(e, all)),
      arrows: elements.filter((e) => e.kind === 'arrow').map((e) => this.boardElement(e, all)),
    }
  }

  /**
   * Change a board in one step: add elements (placed where given, else in a grid to the right of
   * what is there) and arrows between new ("ref") or existing elements, change or remove
   * elements, add a Mermaid flowchart or a JSON Canvas. Returns the board, and the ids given to refs.
   */
  editBoard(input: {
    id: Id
    add?: BoardAddInput[]
    arrows?: ({ from: string; to: string; label?: string; color?: string } & ArrowStyleInput)[]
    update?: (BoardPatchInput & { id: Id })[]
    remove?: Id[]
    mermaid?: string
    canvas?: unknown
  }) {
    const object = this.whiteboard(input.id)
    const doc = this.store.loadText(object.id) ?? new Y.Doc()
    const existing = readBoard(doc)
    const known = new Map(existing.map((e) => [e.id, e]))
    const refs: Record<string, Id> = {}
    const color = (value: string | undefined | null) => {
      if (value === undefined || value === null) return undefined
      if (!isColorName(value)) throw new AgentError(`unknown color "${value}" (${COLOR_NAMES.join(', ')})`)
      return value
    }

    // New elements: their boxes where given, else laid out together after the board's content.
    const additions: (NewBoardElement & { id: Id })[] = []
    const unplaced: { element: NewBoardElement & { id: Id }; size: { w: number; h: number } }[] = []
    for (const item of input.add ?? []) {
      const id = randomUUID()
      if (item.ref) {
        if (refs[item.ref]) throw new AgentError(`ref "${item.ref}" is used twice`)
        refs[item.ref] = id
      }
      const usual = item.kind === 'sticky' ? { w: 180, h: 180 } : item.kind === 'frame' ? { w: 640, h: 420 } : item.kind === 'text' ? { w: 240, h: 40 } : item.kind === 'card' ? { w: 260, h: 150 } : NODE_SIZE
      const size = { w: Math.max(24, Math.round(item.w ?? usual.w)), h: Math.max(24, Math.round(item.h ?? usual.h)) }
      const look = color(item.color) ? { color: color(item.color)! } : {}
      let element: NewBoardElement & { id: Id }
      const box = { x: Math.round(item.x ?? 0), y: Math.round(item.y ?? 0), ...size }
      if (item.kind === 'card') {
        if (!item.object) throw new AgentError('a card needs "object" (an object id or exact title)')
        element = { id, kind: 'card', objectId: this.boardObject(object.spaceId, item.object), ...box }
      } else if (item.kind === 'shape') {
        if (item.shape !== undefined && !isShapeName(item.shape)) throw new AgentError(`unknown shape "${item.shape}"`)
        element = { id, kind: 'shape', shape: item.shape ?? 'rectangle', text: item.text ?? '', ...box, ...look }
      } else if (item.kind === 'frame') element = { id, kind: 'frame', ...box, ...look, ...(item.title ? { title: item.title } : {}) }
      else if (item.kind === 'sticky' || item.kind === 'text') element = { id, kind: item.kind, text: item.text ?? '', ...box, ...look }
      else throw new AgentError(`unknown kind "${String((item as { kind: unknown }).kind)}" (card, text, sticky, shape, frame)`)
      additions.push(element)
      if (item.x === undefined || item.y === undefined) unplaced.push({ element, size })
    }
    const spots = gridBoxes(unplaced.map((u) => u.size), spotAfter([...existing, ...additions.filter((a) => !unplaced.some((u) => u.element === a))] as BoardElement[]))
    unplaced.forEach((u, i) => Object.assign(u.element, spots[i]))

    const resolve = (key: string) => {
      const id = refs[key] ?? (known.has(key) ? key : undefined)
      if (!id) throw new AgentError(`no element "${key}" (an id from get_board, or a ref of an added element)`)
      return id
    }
    for (const arrow of input.arrows ?? []) {
      const from = resolve(arrow.from)
      const to = resolve(arrow.to)
      if (from === to) throw new AgentError('an arrow needs two different elements')
      additions.push({ id: randomUUID(), kind: 'arrow', from, to, ...(arrow.label ? { label: arrow.label } : {}), ...(color(arrow.color) ? { color: color(arrow.color)! } : {}), ...arrowStyle(arrow) })
    }

    // A flowchart or a canvas goes after everything else.
    const after = () => spotAfter([...existing, ...additions] as BoardElement[])
    if (input.mermaid) {
      try {
        const graph = parseMermaidFlowchart(input.mermaid)
        additions.push(...graphToElements(graph, after(), randomUUID, (label) => this.store.search(object.spaceId, label, 10).find((o) => fold(o.title) === fold(label) && o.id !== object.id)?.id))
      } catch (error) {
        if (error instanceof MermaidError) throw new AgentError(error.message)
        throw error
      }
    }
    if (input.canvas !== undefined) {
      try {
        const canvas = typeof input.canvas === 'string' ? JSON.parse(input.canvas) : input.canvas
        const linked = (text: string) => {
          const match = /^\[[^\]]*\]\(([^)]+)\)$|^(\S+)$/.exec(text)
          const target = match?.[1] ?? match?.[2]
          if (!target || !/\/o\//.test(target)) return undefined
          try {
            return this.boardObject(object.spaceId, target)
          } catch {
            return undefined
          }
        }
        // The canvas's own corner goes where new content goes.
        const at = after()
        const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
        const minX = Math.min(0, ...nodes.map((n: { x?: number }) => n.x ?? 0))
        const minY = Math.min(0, ...nodes.map((n: { y?: number }) => n.y ?? 0))
        additions.push(...jsonCanvasToElements(canvas, randomUUID, linked, { x: at.x - minX, y: at.y - minY }))
      } catch (error) {
        if (error instanceof CanvasError || error instanceof SyntaxError) throw new AgentError(`canvas: ${error.message}`)
        throw error
      }
    }

    const patches: Record<Id, BoardPatch> = {}
    for (const change of input.update ?? []) {
      const element = known.get(change.id)
      if (!element) throw new AgentError(`no element "${change.id}" on the board`)
      const patch: BoardPatch = {}
      if (element.kind === 'arrow') {
        if (change.label !== undefined) patch.label = change.label || undefined
        Object.assign(patch, arrowStyle(change, true))
      } else {
        for (const key of ['x', 'y', 'w', 'h'] as const) if (change[key] !== undefined && !isAttached(element)) patch[key] = Math.round(change[key])
        if (change.text !== undefined && 'text' in element) patch.text = change.text
        if (change.title !== undefined && element.kind === 'frame') patch.title = change.title || undefined
        if (change.view !== undefined && element.kind === 'card') {
          if (!CARD_VIEWS.includes(change.view as CardView)) throw new AgentError(`unknown card view "${change.view}" (${CARD_VIEWS.join(', ')})`)
          patch.view = change.view === 'card' ? undefined : (change.view as CardView)
        }
        if (change.shape !== undefined && element.kind === 'shape') {
          if (!isShapeName(change.shape)) throw new AgentError(`unknown shape "${change.shape}"`)
          patch.shape = change.shape
        }
      }
      if (change.color !== undefined && element.kind !== 'card') patch.color = change.color === null ? undefined : color(change.color)
      patches[change.id] = patch
    }
    for (const id of input.remove ?? []) if (!known.has(id)) throw new AgentError(`no element "${id}" on the board`)

    doc.transact(() => {
      const ids = addBoardElements(doc, additions)
      const frames = additions.filter((a) => a.kind === 'frame').map((a) => a.id)
      if (frames.length) sendToBack(doc, frames)
      if (Object.keys(patches).length) updateBoardElements(doc, patches)
      if (input.remove?.length) removeBoardElements(doc, input.remove)
      return ids
    })
    const saved = this.store.putObject({ ...object, updatedAt: this.options.now() }, undefined, doc)
    this.changed(saved)
    return { ...this.getBoard(saved.id), ...(Object.keys(refs).length ? { refs } : {}) }
  }

  /** A day's note ("YYYY-MM-DD", today by default, in the user's calendar). */
  dailyNote(options: { day?: string; space?: string } = {}) {
    const space = this.space(options.space)
    const day = options.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const note = this.store.findObjectOnDay(builtinTypeId(space.id, 'daily-note'), day)
    return note ? { day, ...this.getObject(note.id) } : { day, id: null }
  }

  writeDailyNote(markdown: string, spaceQuery?: string, day = this.captures.today()) {
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const blocks = this.doc(markdown).content
    if (!blocks.some((block) => block.type !== 'paragraph' || block.content?.length)) throw new AgentError('daily note text is required')
    const note = writeDailyText(this.store, this.space(spaceQuery).id, day, this.options.now(), blocks)
    this.changed(note)
    return { day, ...this.getObject(note.id) }
  }

  /**
   * Objects of some types (names or ids; all types when empty), filtered and sorted like a query
   * in the app. Fields are property names (or ids), a relation's field as "Author.Country", or
   * built-in fields: title, tags, createdAt, updatedAt, createdBy, updatedBy, date, type. Select values
   * are option labels; people are usernames or names ("me": the user).
   */
  query(options: { space?: string; types?: string[]; where?: AgentFilter[]; match?: 'all' | 'any'; sort?: { field: string; direction?: 'asc' | 'desc' }[]; limit?: number } = {}) {
    const space = this.space(options.space)
    const types = (options.types ?? []).map((t) => this.type(space.id, t))
    const all = this.store.listTypes(space.id).filter((t) => !t.deletedAt)
    const field = (name: string) => resolveField(name, types.length ? types : all, all)
    const query: QueryDef = {
      typeIds: types.map((t) => t.id),
      ...(options.where?.length
        ? {
            filter: {
              kind: 'group',
              operator: options.match === 'any' ? 'or' : 'and',
              items: options.where.map((w): Filter => {
                const { path, def } = field(w.field)
                const person = def?.kind === 'person' || path === 'createdBy' || path === 'updatedBy'
                const value = def?.kind === 'select' ? selectValue(def, w.value) : person ? this.personValue(space.id, w.value) : w.value
                return { kind: 'filter', field: path, operator: w.operator, ...(value !== undefined ? { value: { kind: 'literal', value } } : {}) }
              }),
            },
          }
        : {}),
      ...(options.sort?.length ? { sort: options.sort.map((r) => ({ field: field(r.field).path, direction: r.direction ?? 'asc' })) } : {}),
    }
    const rows = querySpace(this.store, space.id, { query, today: this.captures.today(), timeZone: this.captures.timeZone, me: this.options.user.id, people: this.store.people(space.id) }, this.options.now())
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
    return { total: rows.length, objects: rows.slice(0, limit).map((o) => this.summary(o)) }
  }

  /** Usernames or names (or "me") as the user ids a person filter compares; unknown ones stay as given. */
  private personValue(spaceId: Id, value: AgentFilter['value']) {
    if (value === undefined) return value
    const people = this.store.people(spaceId)
    const id = (name: string) => findPerson(people, name, this.options.user.id)?.id ?? name
    return Array.isArray(value) ? value.map(id) : [id(String(value))]
  }

  /** What was captured in the last days (newest first), with the objects in each item. */
  inbox(options: { space?: string; days?: number; includeDone?: boolean } = {}) {
    const space = this.space(options.space)
    const items = listInbox(this.store, space.id, this.captures.today(), Math.min(Math.max(options.days ?? 7, 1), 365)).filter((i) => options.includeDone || !i.done)
    return items.map((item) => ({
      id: item.id,
      day: item.day,
      at: item.at,
      channel: item.channel,
      done: item.done,
      dailyNoteId: item.noteId,
      text: docToMarkdown({ type: 'doc', content: item.content }, { titleOf: this.titleOf }),
      objects: item.objectIds.map((id) => ({ id, title: this.titleOf(id) ?? '' })),
    }))
  }

  // Writing -------------------------------------------------------------------

  private doc(markdown: string): Doc {
    try {
      return checkDoc(markdownToDoc(markdown) as never) as Doc
    } catch (error) {
      throw new AgentError(`the Markdown does not make a valid document: ${(error as Error).message}`)
    }
  }

  /** Values by property name; select options and related objects are created when missing. */
  private props(type: ObjectType, values: Record<string, unknown>) {
    const toClear = Object.entries(values).flatMap(([key, value]) => (value === null || value === '' ? [key] : []))
    const parsed = parseProperties(type, Object.fromEntries(Object.entries(values).filter(([key]) => !toClear.includes(key))), this.context(type.spaceId))
    if (parsed.errors.length) throw new AgentError(`could not set ${parsed.errors.join('; ')}`)
    const cleared = toClear.map((key) => {
      const def = type.properties.find((p) => p.id === key || fold(p.name) === fold(key))
      if (!def) throw new AgentError(`could not set ${key}: no such property`)
      return def.id
    })
    const { props, related } = this.captures.applyLine(type.spaceId, type, parsed)
    return { props, related, cleared }
  }

  private textField(type: ObjectType, field?: string): Id {
    const fields = type.properties.filter((p) => p.kind === 'rich-text')
    if (!field) return fields[0]?.id ?? BODY_PROPERTY_ID
    const def = fields.find((p) => p.id === field || fold(p.name) === fold(field))
    if (!def) throw new AgentError(`${type.name} has no text field "${field}" (it has ${fields.map((p) => p.name).join(', ') || 'none'})`)
    return def.id
  }

  /** The space's templates (by type) and snippets, with the questions each asks. */
  templates(spaceQuery?: string) {
    const space = this.space(spaceQuery)
    const typeNames = new Map(this.store.listTypes(space.id).map((t) => [t.id, t.name]))
    return this.store.listTemplates(space.id).map((t) => ({
      id: t.id,
      name: t.template!.name,
      kind: t.template!.kind,
      ...(t.template!.kind === 'template' ? { type: typeNames.get(t.typeId) ?? '', ...(t.template!.default ? { default: true } : {}) } : {}),
      ...(t.template!.kind === 'snippet' && t.template!.trigger ? { trigger: t.template!.trigger } : {}),
      asks: templateAsks(t),
    }))
  }

  /**
   * A new object. It starts from the type's default template, or the one `template` names
   * ("blank" for none), its questions answered by `answers`; the given title, properties and
   * Markdown win over the template's (the Markdown goes after its text).
   */
  createObject(input: { type: string; coverUrl?: string; title?: string; space?: string; properties?: Record<string, unknown>; markdown?: string; template?: string; answers?: Record<string, string>; tags?: string[]; icon?: string | null; color?: string | null }) {
    const space = this.space(input.space)
    const type = this.type(space.id, input.type)
    if (type.system === 'daily-note') throw new AgentError('daily notes are written by write_daily_note')
    const { props: given, related } = this.props(type, input.properties ?? {})
    const templates = this.store.listTemplates(space.id)
    const wanted = input.template?.trim()
    const template = wanted?.toLowerCase() === 'blank' ? undefined : wanted ? findTemplate(templates, type.id, wanted) : defaultTemplate(templates, type.id)
    if (wanted && wanted.toLowerCase() !== 'blank' && !template) {
      const names = typeTemplates(templates, type.id).map((t) => t.template!.name)
      throw new AgentError(`${type.name} has no template “${wanted}”${names.length ? ` (it has ${names.join(', ')})` : ''}`)
    }
    const at = this.options.now()
    const made = template
      ? applyTemplate(template, type, {
          at,
          today: this.captures.today(),
          timeZone: this.captures.timeZone,
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          me: this.options.user.id,
          people: this.store.people(space.id),
          answers: input.answers ?? {},
          types: new Map(this.store.listTypes(space.id).map((t) => [t.id, t])),
        })
      : undefined
    const field = this.textField(type)
    const content = { ...made?.content }
    if (input.markdown?.trim()) content[field] = { type: 'doc' as const, content: [...(content[field]?.content ?? []), ...this.doc(input.markdown).content] }
    const props = { ...made?.props, ...given }
    const extra = template ? { tagIds: [...template.tagIds], ...(template.icon ? { icon: template.icon } : {}) } : {}
    const object = newObject(type, { ...extra, ...(input.coverUrl !== undefined ? { coverUrl: this.coverUrl(input.coverUrl) } : {}), title: made?.title ?? input.title?.trim() ?? '', props, content }, randomUUID(), at)
    this.looks(object, input)
    const tags: ObjectRecord[] = []
    if (input.tags?.length) object.tagIds = this.retag(object, input.tags, 'add', tags)
    const stored = this.store.transaction(() => {
      for (const other of [...tags, ...related]) this.store.putObject(other)
      return this.store.putObject(object)
    })
    for (const other of [...tags, ...related]) this.changed(other)
    this.changed(stored)
    return this.getObject(stored.id)
  }

  /**
   * Change an object: its title, properties (null clears one), and text: Markdown appended to a
   * text field (the first by default), put before it, or replacing it.
   */
  /** A comment on an object, as the user (@username mentions a member). */
  addComment(input: { id: Id; text: string }) {
    const existing = this.object(input.id)
    const object: ObjectRecord = { ...existing, props: { ...existing.props }, updatedAt: this.options.now() }
    try {
      addComment(object, this.options.user.id, input.text, this.options.now())
    } catch (error) {
      if (error instanceof CommentError) throw new AgentError(error.message)
      throw error
    }
    const saved = this.store.putObject(object)
    this.changed(saved)
    return { id: saved.id, comments: commentsOf(saved).length, url: this.url(saved.id) }
  }

  updateObject(input: {
    id: Id
    coverUrl?: string | null
    title?: string
    properties?: Record<string, unknown>
    markdown?: string
    mode?: 'append' | 'prepend' | 'replace'
    field?: string
    tags?: string[]
    tagsMode?: 'add' | 'remove' | 'replace'
    icon?: string | null
    color?: string | null
  }) {
    const existing = this.object(input.id)
    const type = this.store.getType(existing.typeId)
    if (!type) throw new AgentError(`no type for ${input.id}`)
    const object: ObjectRecord = { ...existing, props: { ...existing.props }, content: { ...existing.content } }
    if (input.coverUrl === null) delete object.coverUrl
    else if (input.coverUrl !== undefined) object.coverUrl = this.coverUrl(input.coverUrl)
    if (input.title !== undefined) object.title = input.title.trim()
    this.looks(object, input)
    const tags: ObjectRecord[] = []
    if (input.tags) object.tagIds = this.retag(object, input.tags, input.tagsMode ?? 'add', tags)
    let related: ObjectRecord[] = []
    if (input.properties) {
      const changes = this.props(type, input.properties)
      Object.assign(object.props, changes.props)
      for (const id of changes.cleared) delete object.props[id]
      related = changes.related
    }
    if (input.markdown !== undefined) {
      const field = this.textField(type, input.field)
      const mode = input.mode ?? 'append'
      if (mode === 'replace') {
        if (input.markdown.trim()) object.content[field] = this.doc(input.markdown)
        else delete object.content[field]
      } else {
        const added = this.doc(input.markdown).content
        const current = [...(object.content[field]?.content ?? [])]
        // An empty last (or first) line is where the editor's cursor waits; the new text takes it.
        const blank = (node: (typeof current)[number] | undefined) => node?.type === 'paragraph' && !node.content?.length
        if (mode === 'append') while (blank(current.at(-1))) current.pop()
        else while (blank(current[0])) current.shift()
        object.content[field] = { type: 'doc', content: mode === 'append' ? [...current, ...added] : [...added, ...current] }
      }
    }
    object.updatedAt = this.options.now()
    related = [...tags, ...related]
    const stored = this.store.transaction(() => {
      for (const other of related) this.store.putObject(other)
      return this.store.putObject(object)
    })
    for (const other of related) this.changed(other)
    this.changed(stored)
    return this.getObject(stored.id)
  }

  // Habits --------------------------------------------------------------------

  /** A habit by id or title (accents and case ignored) in a space. */
  private habit(query: string, spaceId: Id): ObjectRecord {
    const byId = this.store.getObject(query)
    if (byId && !byId.deletedAt && byId.spaceId === spaceId && this.store.getType(byId.typeId)?.system === 'habit') return byId
    const type = this.store.getType(builtinTypeId(spaceId, 'habit'))
    const match = type ? this.store.listObjects(type.id).find((h) => fold(h.title) === fold(query)) : undefined
    if (!match) throw new AgentError(`no habit "${query}" (list_habits shows them)`)
    return this.object(match.id)
  }

  private habitInfo(habit: Pick<ObjectSummary, 'id' | 'title' | 'props' | 'createdAt'>, day: string, recent: number) {
    const stats = habitStats(habit, this.captures.today())
    const target = habitTarget(habit)
    const weekdays = habitWeekdays(habit)
    return {
      id: habit.id,
      title: habit.title,
      url: this.url(habit.id),
      ...(weekdays.length ? { repeatsOn: weekdays } : { repeatsOn: 'every day' }),
      ...(target ? { dailyGoal: target, unit: habitUnit(habit) || undefined } : {}),
      ...(habitFoodRule(habit) ? { fromFood: habitFoodRule(habit) } : {}),
      ...(habitRemindAt(habit) ? { remindAt: habitRemindAt(habit) } : {}),
      ...(isHabitPaused(habit) ? { paused: true } : {}),
      day: { day, scheduled: isHabitScheduled(habit, day), done: isHabitDone(habit, day), ...(target ? { amount: habitValue(habit, day) } : {}) },
      stats: {
        currentStreak: stats.current,
        bestStreak: stats.best,
        thisWeek: `${stats.weekDone}/${stats.weekScheduled}`,
        last30Days: `${Math.round(stats.rate30 * 100)}%`,
        timesDone: stats.total,
        ...(target ? { averagePerDay: Math.round(stats.average30 * 10) / 10 } : {}),
      },
      ...(recent > 0
        ? {
            recent: Array.from({ length: recent }, (_, i) => addDays(day, i - recent + 1)).map((d) =>
              target ? { day: d, amount: habitValue(habit, d), done: isHabitDone(habit, d) } : { day: d, done: isHabitDone(habit, d) }
            ),
          }
        : {}),
    }
  }

  /** The habits of a space with a day's state (today by default), streaks and rates, and the last `recent` days. */
  habits(options: { space?: string; day?: string; recent?: number } = {}) {
    const space = this.space(options.space)
    const day = options.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const type = this.store.getType(builtinTypeId(space.id, 'habit'))
    if (!type) return []
    const recent = Math.min(Math.max(options.recent ?? 7, 0), 60)
    const habits = habitsWithFood(this.store, space.id, this.store.listObjects(type.id), this.captures.today())
    return habits.sort((a, b) => a.title.localeCompare(b.title)).map((habit) => this.habitInfo(habit, day, recent))
  }

  /**
   * Log a habit on a day (today by default): done or not, or for a habit with a daily goal an
   * amount (set it, or `add` to what is there).
   */
  logHabit(input: { habit: string; space?: string; day?: string; done?: boolean; amount?: number; add?: number }) {
    const space = this.space(input.space)
    const day = input.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const habit = this.habit(input.habit, space.id)
    if (habitFoodRule(habit)) throw new AgentError(`"${habit.title}" is done from what is logged in Food; log food instead (log_food)`)
    const target = habitTarget(habit)
    let amount: number
    if (input.add !== undefined) amount = habitValue(habit, day) + input.add
    else if (input.amount !== undefined) amount = input.amount
    else amount = input.done === false ? 0 : (target ?? 1)
    if (!Number.isFinite(amount) || amount < 0) throw new AgentError('the amount must be 0 or more')
    if (!target) amount = amount > 0 ? 1 : 0
    const object: ObjectRecord = { ...habit, props: { ...habit.props }, updatedAt: this.options.now() }
    const value = habitDayValue(habit, amount)
    if (value) object.props[habitDoneKey(day)] = value
    else delete object.props[habitDoneKey(day)]
    const stored = this.store.putObject(object)
    this.changed(stored)
    return this.habitInfo(stored, day, 7)
  }

  // Nutrition -------------------------------------------------------------------

  /** A food's nutrients per 100 g and portions, or a recipe's ingredients and what it comes to, for get_object. */
  private foodFacts(object: ObjectRecord): Record<string, unknown> {
    if (isFood(object)) {
      const per100 = foodNutrients(object)
      return { nutrition: { per100g: per100 ?? 'no data yet', portions: foodPortions(object), ...(foodBrand(object) ? { brand: foodBrand(object) } : {}) } }
    }
    if (!isRecipe(object)) return {}
    const lookup = (id: Id) => this.store.getObjectSummaries([id])[0]
    const facts = recipeFacts(object, lookup)
    return {
      nutrition: {
        ingredients: recipeIngredients(object).map((i) => ({ id: i.id, title: this.titleOf(i.id) ?? '(deleted)', grams: i.grams })),
        grams: facts.grams,
        ...(facts.per100 ? { per100g: facts.per100 } : {}),
        ...(facts.servingGrams ? { servingGrams: facts.servingGrams } : {}),
        ...(facts.missing.length ? { missingData: facts.missing.map((id) => this.titleOf(id) ?? id) } : {}),
      },
    }
  }

  private nutritionSpace(query?: string) {
    const space = this.space(query)
    if (!isNutritionOn(space)) throw new AgentError(`${space.name} does not track food (Settings › Food tracking in the app turns it on)`)
    return space
  }

  /** A food or recipe by id or title (accents, case and plurals ignored). */
  private foodSource(query: string, spaceId: Id): ObjectSummary {
    const sources = [...this.store.listObjects(builtinTypeId(spaceId, 'food')), ...this.store.listObjects(builtinTypeId(spaceId, 'recipe'))].filter((s) => !s.deletedAt)
    const found = sources.find((s) => s.id === query) ?? sources.find((s) => fold(s.title) === fold(query))
    if (!found) throw new AgentError(`no food or recipe "${query}" (search for it, or save_food makes one)`)
    return found
  }

  /**
   * Log what was eaten: a line as after /food ("2 slices of bread, coffee 200 ml at breakfast"),
   * or one food or recipe with an amount. Today by default.
   */
  logFood(input: { text?: string; food?: string; amount?: string; meal?: string; day?: string; space?: string }) {
    const space = this.nutritionSpace(input.space)
    const today = this.captures.today()
    const day = input.day ?? today
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const now = this.options.now()
    try {
      if (input.food) {
        const meals = space.nutrition?.meals ?? DEFAULT_MEALS
        const meal = input.meal ? meals.find((m) => m.id === input.meal || fold(m.name) === fold(input.meal!)) : undefined
        if (input.meal && !meal) throw new AgentError(`no meal "${input.meal}" (${meals.map((m) => m.name).join(', ')})`)
        const source = this.foodSource(input.food, space.id)
        const result = logFood(this.store, space.id, { sourceId: source.id, amount: input.amount ?? '', day, ...(meal ? { meal: meal.id } : {}), timeZone: this.captures.timeZone }, now)
        this.changed(result.note)
        return { logged: [{ id: result.entryId, ...result.entry }], ...this.nutritionDay({ space: space.id, day }) }
      }
      if (!input.text?.trim()) throw new AgentError('give text (as after /food) or a food and an amount')
      const result = logFoodLine(this.store, space.id, input.text, { today: day, timeZone: this.captures.timeZone }, now)
      for (const food of result.created) this.changed(food)
      if (result.note) this.changed(result.note)
      const answer = foodLineAnswer(result, today)
      return { day: result.day, logged: answer.entries, created: answer.created, problems: answer.problems, summary: answer.summary }
    } catch (error) {
      if (error instanceof NutritionError || error instanceof AmountError) throw new AgentError(error.message)
      throw error
    }
  }

  /** A day of food: its meals with their entries, totals, the goal and the week's budget. Today by default. */
  nutritionDay(input: { day?: string; space?: string } = {}) {
    const space = this.nutritionSpace(input.space)
    const day = input.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const dailyType = builtinTypeId(space.id, 'daily-note')
    const noteOn = (d: string) => this.store.findObjectOnDay(dailyType, d)
    const note = noteOn(day)
    const entries = note ? dayEntries(note) : []
    const goals = readGoals(this.store.listObjects(builtinTypeId(space.id, 'nutrition-goal')))
    const goal = goalForDay(goals, day)
    const week = weekBudget(goals, day, (d) => {
      const n = noteOn(d)
      return n ? dayTotals(dayEntries(n)).kcal : 0
    })
    const entry = (id: Id, e: FoodEntry) => ({ id, name: entryLabel(e), amount: e.amount, grams: e.grams, ...(e.nutrients ? { nutrients: e.nutrients } : { needsData: true }), ...(e.sourceId ? { foodId: e.sourceId } : {}), ...(e.quick ? { quick: true } : {}) })
    return {
      day,
      ...(note ? { dailyNoteId: note.id, url: this.url(note.id) } : {}),
      counted: isDayCounted(note),
      totals: dayTotals(entries),
      ...(goal ? { goal } : {}),
      ...(week ? { week } : {}),
      meals: groupByMeal(entries, space.nutrition?.meals ?? DEFAULT_MEALS, this.captures.timeZone).map((g) => ({
        meal: g.meal.name,
        totals: g.totals,
        entries: g.entries.map((e) => entry(e.id, e.entry)),
      })),
    }
  }

  /** Take an entry off a day (its id from nutrition_day). */
  deleteFoodEntry(input: { day?: string; entry: string; space?: string }) {
    const space = this.nutritionSpace(input.space)
    const day = input.day ?? this.captures.today()
    const note = this.store.findObjectOnDay(builtinTypeId(space.id, 'daily-note'), day)
    const stored = note ? deleteFoodEntry(this.store, note.id, input.entry, this.options.now()) : undefined
    if (!stored) throw new AgentError(`no entry ${input.entry} on ${day} (nutrition_day lists them)`)
    this.changed(stored)
    return this.nutritionDay({ space: space.id, day })
  }

  /**
   * Make a food or change one (by id or title): nutrients as on a label, per `per` grams (100 by
   * default; kept per 100 g), its brand and portions. Portions given replace the ones it had.
   */
  saveFood(input: { food: string; space?: string; per?: number; nutrients?: Partial<Nutrients>; brand?: string; portions?: FoodPortion[] }) {
    const space = this.nutritionSpace(input.space)
    const type = this.store.getType(builtinTypeId(space.id, 'food'))!
    let existing: ObjectSummary | undefined
    try {
      existing = this.foodSource(input.food, space.id)
    } catch {}
    if (existing && !isFood(existing)) throw new AgentError(`"${existing.title}" is a recipe; edit its ingredients in the app`)
    const now = this.options.now()
    const object: ObjectRecord = existing ? { ...this.object(existing.id), updatedAt: now } : newObject(type, { title: input.food.trim() }, randomUUID(), now)
    object.props = { ...object.props }
    const per = input.per && input.per > 0 ? input.per : 100
    for (const [key, value] of Object.entries(input.nutrients ?? {})) {
      if (!['kcal', 'protein', 'carbs', 'fat', 'fiber'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
      object.props[key] = { kind: 'number', value: Math.round(((value * 100) / per) * 100) / 100 }
    }
    if (input.brand !== undefined) {
      if (input.brand.trim()) object.props.brand = { kind: 'text', value: input.brand.trim() }
      else delete object.props.brand
    }
    if (input.portions) {
      const portions = input.portions.filter((p) => p.name?.trim() && p.grams > 0).map((p) => ({ name: p.name.trim(), grams: p.grams }))
      if (portions.length) object.props.portions = portionsValue(portions)
      else delete object.props.portions
    }
    const stored = this.store.putObject(object)
    this.changed(stored)
    const usage = sourceUsage(this.store.listObjects(builtinTypeId(space.id, 'daily-note')), stored.id)
    return { ...this.getObject(stored.id), timesEaten: usage.count }
  }

  /** A note into today's daily note, like the quick capture (links in it are saved as weblinks). */
  async capture(input: { text: string; space?: string }) {
    const space = this.space(input.space)
    const result = await this.captures.note({ text: input.text, spaceId: space.id, channel: 'agent' })
    return { dailyNoteId: result.dailyNote!.id, url: this.url(result.dailyNote!.id), objects: result.objects.map((o) => ({ id: o.id, title: o.title })) }
  }
}

export interface AgentFilter {
  field: string
  operator: FilterOperator
  value?: string | number | boolean | string[]
}

const BUILT_IN_FIELDS = ['title', 'tags', 'collections', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'date', 'type']

/** A query field path from names: a property of `types`, or "Relation.Field" through a relation. */
function resolveField(name: string, types: ObjectType[], all: ObjectType[]): { path: string; def?: PropertyDef } {
  const find = (among: ObjectType[], wanted: string) =>
    among.flatMap((t) => t.properties).find((p) => p.id === wanted) ?? among.flatMap((t) => t.properties).find((p) => fold(p.name) === fold(wanted))
  const builtIn = BUILT_IN_FIELDS.find((f) => fold(f) === fold(name))
  if (builtIn) return { path: builtIn }
  const direct = find(types, name)
  if (direct) return { path: direct.id, def: direct }
  const dot = name.indexOf('.')
  if (dot > 0) {
    const relation = find(types, name.slice(0, dot))
    if (relation?.kind === 'relation') {
      const targets = relation.targetTypeIds.length ? all.filter((t) => relation.targetTypeIds.includes(t.id)) : all
      const rest = name.slice(dot + 1)
      const inner = BUILT_IN_FIELDS.find((f) => fold(f) === fold(rest))
      if (inner) return { path: `${relation.id}.${inner}` }
      const def = find(targets, rest)
      if (def) return { path: `${relation.id}.${def.id}`, def }
    }
  }
  throw new AgentError(`unknown field "${name}"`)
}

/** Option labels as the option ids a select filter compares. */
function selectValue(def: PropertyDef, value: AgentFilter['value']) {
  if (def.kind !== 'select' || value === undefined) return value
  const id = (label: string) => def.options.find((o) => o.id === label || fold(o.label) === fold(label))?.id ?? label
  return Array.isArray(value) ? value.map(id) : [id(String(value))]
}

function describeProperty(def: PropertyDef, typeNames: Map<Id, string>, type: ObjectType, types: ObjectType[]) {
  const base = { id: def.id, name: def.name, kind: def.kind }
  if (def.kind === 'formula') return { ...base, formula: formulaToNames(def.expression, type, types) }
  if (def.kind === 'select') return { ...base, multiple: def.multiple, options: def.options.map((o) => o.label) }
  if (def.kind === 'relation') return { ...base, multiple: def.multiple, ...(def.targetTypeIds.length ? { targets: def.targetTypeIds.map((id) => typeNames.get(id) ?? id) } : {}) }
  if (def.kind === 'person') return { ...base, multiple: def.multiple }
  if (def.kind === 'date') return { ...base, ...(def.withTime ? { withTime: true } : {}) }
  return base
}

export function dateText(date: DateValue): string {
  const one = (iso: string) => (date.resolution === 'day' ? iso.slice(0, 10) : iso)
  return [one(date.start), date.end ? ` – ${one(date.end)}` : '', date.rrule ? ` (repeats: ${date.rrule})` : ''].join('')
}

/** A formula's value for agents: numbers, booleans and lists as JSON, dates as text, errors said. */
function formulaOutput(value: FormulaValue, timeZone: string): unknown {
  switch (value.kind) {
    case 'number':
    case 'checkbox':
      return value.value
    case 'date':
      return dateText(value.value)
    case 'list':
      return value.value.map((item) => formulaOutput(item, timeZone))
    case 'error':
      return { error: value.message }
    default:
      return formulaText(value, timeZone)
  }
}

export function valueOf(def: PropertyDef, value: PropertyValue, titles: (ids: Id[]) => { id: Id; title: string }[], personName: (id: Id) => string): unknown {
  switch (value.kind) {
    case 'date':
      return dateText(value.value)
    case 'select': {
      const labels = value.value.map((id) => (def.kind === 'select' ? def.options.find((o) => o.id === id)?.label : undefined) ?? id)
      return def.kind === 'select' && def.multiple ? labels : labels[0]
    }
    case 'relation':
      return titles(value.value)
    case 'person': {
      const names = value.value.map(personName)
      return def.kind === 'person' && def.multiple ? names : names[0]
    }
    default:
      return value.value
  }
}
