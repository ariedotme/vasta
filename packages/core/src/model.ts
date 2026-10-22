// Vasta data model.
// Everything a user creates is an "object". Every object has exactly one type.
// Types define custom properties and the views used to browse their objects.
// See docs/data-model.md for the rationale behind each piece.

export type Id = string
/** ISO 8601 timestamp, always UTC. */
export type IsoDateTime = string

export type Icon = { kind: 'emoji'; value: string } | { kind: 'icon'; value: string } // value: Iconify name, e.g. "ph:bookmark"

export type ColorName =
  | 'gray' | 'red' | 'orange' | 'amber' | 'yellow' | 'lime' | 'green' | 'emerald' | 'teal' | 'cyan'
  | 'sky' | 'blue' | 'indigo' | 'violet' | 'purple' | 'fuchsia' | 'pink' | 'rose'

// ---------------------------------------------------------------------------
// Spaces and sidebar

export interface Space {
  id: Id
  name: string
  icon?: Icon
  /** Ordered sidebar sections. The first one is conventionally "Pinned". */
  sidebar: SidebarSection[]
  /** Food tracking in this space (nutrition.ts); absent until it is turned on. */
  nutrition?: NutritionSettings
  /** Sprints in this space (sprints.ts); absent until they are turned on. */
  sprints?: SprintSettings
  createdAt: IsoDateTime
}

/** A space's food tracking: on or off (turning it off hides it and keeps the data) and its meals. */
export interface NutritionSettings {
  enabled: boolean
  /** In the order of the day. */
  meals: Meal[]
}

/** A space's sprints: on or off, and the word the space uses for them ("Sprint", "Rodada"…). */
export interface SprintSettings {
  enabled: boolean
  name: string
  pluralName: string
}

export interface Meal {
  id: Id
  name: string
  /** Usual time, "HH:MM": an entry logged without a meal goes to the one nearest its time. */
  time?: string
}

export interface SidebarSection {
  id: Id
  name: string
  icon?: Icon
  /** Type ids or object ids, in display order. An id may also be in other sections. */
  items: Id[]
}

// ---------------------------------------------------------------------------
// Accounts and sharing

/**
 * A person who logs in. Spaces are the unit of access: a user sees the spaces they are a member
 * of, and every object, type and calendar inside them.
 */
export interface User {
  id: Id
  /** Login name, unique ignoring case. */
  username: string
  /** Shown in the app. */
  name: string
  /** IANA zone deciding which day captures land on; the server's zone when unset. */
  timeZone?: string
  /** Space captures go to when a channel names none; the user's first space when unset. */
  captureSpaceId?: Id
  /** Telegram user whose messages to the bot are captured for this user. */
  telegramUserId?: number
  /** How the inbox shows items marked as dealt with (Settings › Inbox). */
  inbox?: InboxPreferences
  createdAt: IsoDateTime
}

/** The word for a capture marked as dealt with ("Reviewed" when unset), and whether those fade. */
export interface InboxPreferences {
  reviewedLabel?: string
  fadeReviewed?: boolean
}

/** A member of a space as person values show them (`PersonPropertyDef`). */
export interface Person {
  id: Id
  username: string
  name: string
}

/** Owners can share the space with others (and later delete it); editors can change everything in it. */
export type SpaceRole = 'owner' | 'editor'

export interface SpaceMember {
  spaceId: Id
  userId: Id
  role: SpaceRole
  createdAt: IsoDateTime
}

/**
 * What a bearer token may call: only the capture API, the whole API (scripts, tests), or only the
 * stream of reminders a desktop app shows as notifications (`notify`, made by the app itself).
 */
export type TokenScope = 'capture' | 'api' | 'notify'

export interface ApiToken {
  id: Id
  userId: Id
  name: string
  scope: TokenScope
  createdAt: IsoDateTime
  lastUsedAt?: IsoDateTime
}

/** A link that lets someone make an account on the server, once, until it expires. */
export interface Invite {
  id: Id
  createdBy: Id
  /** The space the new account joins, and as what. */
  spaceId?: Id
  role?: SpaceRole
  createdAt: IsoDateTime
  expiresAt: IsoDateTime
}

// ---------------------------------------------------------------------------
// Types

/** Built-in types the app has special behavior for. Custom types have no system key. */
export type SystemTypeKey =
  | 'page' | 'daily-note' | 'tag' | 'collection' | 'query' | 'task'
  | 'weblink' | 'date' | 'image' | 'pdf' | 'audio' | 'video' | 'file' | 'quote' | 'habit'
  | 'food' | 'recipe' | 'nutrition-goal' | 'sprint'

export interface ObjectType {
  id: Id
  spaceId: Id
  system?: SystemTypeKey
  name: string
  pluralName: string
  description?: string
  icon?: Icon
  color?: ColorName
  properties: PropertyDef[]
  views: ViewDef[]
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
  /** Set when the type is in the trash; its objects are trashed with it. */
  deletedAt?: IsoDateTime
}

export type PropertyDef =
  | TextPropertyDef
  | RichTextPropertyDef
  | NumberPropertyDef
  | CheckboxPropertyDef
  | UrlPropertyDef
  | DatePropertyDef
  | RelationPropertyDef
  | SelectPropertyDef
  | PersonPropertyDef
  | FormulaPropertyDef

interface PropertyDefBase {
  id: Id
  name: string
  description?: string
  icon?: Icon
  hideWhenEmpty?: boolean
}

export interface TextPropertyDef extends PropertyDefBase { kind: 'text' }
/** A rich text field. Its content lives in ObjectRecord.content[id]. Most types have one, the body. */
export interface RichTextPropertyDef extends PropertyDefBase { kind: 'rich-text' }
export interface NumberPropertyDef extends PropertyDefBase { kind: 'number'; format?: string }
export interface CheckboxPropertyDef extends PropertyDefBase { kind: 'checkbox' }
export interface UrlPropertyDef extends PropertyDefBase { kind: 'url' }
export interface DatePropertyDef extends PropertyDefBase { kind: 'date'; withTime?: boolean; allowRange?: boolean }
export interface RelationPropertyDef extends PropertyDefBase {
  kind: 'relation'
  /** Allowed target type ids. Empty means any type. */
  targetTypeIds: Id[]
  multiple: boolean
}
export interface SelectPropertyDef extends PropertyDefBase {
  kind: 'select'
  options: SelectOption[]
  multiple: boolean
}
/** Members of the object's space (user ids): an assignee, a reviewer. */
export interface PersonPropertyDef extends PropertyDefBase { kind: 'person'; multiple: boolean }
/**
 * A value computed from the object's other fields (formula.ts), never stored in `props`. The
 * expression keeps field ids in braces: `{price} * {qty}`, `{author.country}`.
 */
export interface FormulaPropertyDef extends PropertyDefBase { kind: 'formula'; expression: string }
export interface SelectOption {
  id: Id
  label: string
  color?: ColorName
  /** When set, the option behaves as a status (used by tasks and kanban). */
  status?: 'todo' | 'doing' | 'done'
}

// ---------------------------------------------------------------------------
// Objects

export interface DateValue {
  start: IsoDateTime
  /** Inclusive: a day range ends on its last day, a time range at its end time. */
  end?: IsoDateTime
  resolution: 'day' | 'time'
  /**
   * Makes the date repeat: an RFC 5545 RRULE value without the "RRULE:" prefix, e.g.
   * "FREQ=WEEKLY;BYDAY=MO". `start` (and `end`) describe the first occurrence.
   */
  rrule?: string
  /** IANA zone whose wall clock a repeating time follows across DST changes. */
  timeZone?: string
  /**
   * Occurrences of a repeating date changed on their own, keyed by the start the rule gives them
   * (as `CalendarEntry.occurrence`): moved or resized to other times, or cancelled.
   */
  exceptions?: Record<IsoDateTime, DateException>
}

/** One occurrence of a repeating date: its own start (and end), or cancelled. */
export type DateException = { start: IsoDateTime; end?: IsoDateTime } | { cancelled: true }

export type PropertyValue =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'url'; value: string }
  | { kind: 'date'; value: DateValue }
  | { kind: 'relation'; value: Id[] }
  | { kind: 'select'; value: Id[] }
  /** User ids. */
  | { kind: 'person'; value: Id[] }
  // Structured values the app writes without a property definition (nutrition.ts).
  | { kind: 'food-entry'; value: FoodEntry }
  | { kind: 'portions'; value: FoodPortion[] }
  | { kind: 'ingredients'; value: RecipeIngredient[] }
  /** A card's place in a board's manual order (rank.ts). */
  | { kind: 'rank'; value: string }
  /** A comment on the object (comments.ts), keyed `comment:<id>`. */
  | { kind: 'comment'; value: Comment }

/** A comment on an object: who wrote it, when, and what (plain text; @username mentions a member). */
export interface Comment {
  author: Id
  at: IsoDateTime
  text: string
  editedAt?: IsoDateTime
}

/** Calories (kcal) and grams of each macronutrient. */
export interface Nutrients {
  kcal: number
  protein: number
  carbs: number
  fat: number
  fiber?: number
}

/** A named amount of a food: "slice" = 30 g. */
export interface FoodPortion {
  name: string
  grams: number
}

/** A food or recipe in a recipe, by weight. */
export interface RecipeIngredient {
  id: Id
  grams: number
}

/**
 * Something eaten, a prop of the day's daily note (`food:<entry id>`). It keeps a snapshot of the
 * name and nutrients for its grams, so changing the food later does not rewrite the past.
 */
export interface FoodEntry {
  /** The food or recipe logged. */
  sourceId?: Id
  name: string
  /** As typed: "150 g", "2 slices", "1 serving". */
  amount: string
  grams: number
  /** A meal of the space's NutritionSettings. */
  meal?: Id
  /** When it was eaten. */
  at: IsoDateTime
  /** For `grams`; absent while the food has no nutrition data. */
  nutrients?: Nutrients
  /**
   * Logged by its numbers alone ("muffin ~350 kcal"), without a food: no source, no grams, and
   * only the nutrients given count (the others are 0).
   */
  quick?: boolean
}

export interface ObjectRecord {
  id: Id
  spaceId: Id
  typeId: Id
  title: string
  description?: string
  icon?: Icon
  coverUrl?: string
  /** A color of its own: a tag's chips (nested tags color-code what they tag). */
  color?: ColorName
  /** The object this one sits under, of the same type: a tag's parent tag (#recipe for #recipe/breakfast). */
  parentId?: Id
  aliases: string[]
  tagIds: Id[]
  collectionIds: Id[]
  /** Custom property values, keyed by PropertyDef.id. Rich text lives in `content`. */
  props: Record<Id, PropertyValue>
  /** Rich text documents, keyed by the id of a rich-text PropertyDef. */
  content: Record<Id, Doc>
  /** Set for objects that live on the calendar: daily notes, date objects, events. */
  date?: DateValue
  /** Only for objects of the system type "query". */
  query?: QueryDef
  /** Only for system types that carry media or links (weblink, image, pdf…). */
  media?: MediaInfo
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
  deletedAt?: IsoDateTime
  /**
   * Who made it and who changed it last (user ids). Like the times, not fields of their own: set
   * where a user's write is applied (Store.actor), absent for writes nobody made (imports, the
   * server's own jobs).
   */
  createdBy?: Id
  updatedBy?: Id
}

/** An object without its rich text, plus a short plain-text preview. Used by lists and views. */
export type ObjectSummary = Omit<ObjectRecord, 'content'> & { preview: string }

export interface Backlink {
  object: ObjectSummary
  kind: 'mention' | 'embed' | 'relation' | 'tag' | 'collection'
  /** Property or content field the reference comes from; '' for tags and collections. */
  via: string
}

export interface MediaInfo {
  /** The stored file, when Vasta holds a copy of the media. */
  file?: StoredFile
  url?: string
  mimeType?: string
  sizeBytes?: number
  width?: number
  height?: number
  host?: string
  embedUrl?: string
  previewImageUrl?: string
  /** A copy of `previewImageUrl` in the media store, so the preview survives the page going away. */
  previewImageFile?: StoredFile
  /** Metadata scraped from a web page (title, description, author, site name…). */
  meta?: Record<string, string | number | boolean | null>
}

/** A file in the media store. Files are content-addressed: `key` is "<sha256>.<extension>". */
export interface StoredFile {
  key: string
  name: string
  sizeBytes: number
  mimeType?: string
}

// ---------------------------------------------------------------------------
// Rich text
//
// Documents use the ProseMirror JSON format so they can be edited with TipTap
// and synced with y-prosemirror without conversion. Node and mark names below
// are the contract between the editor, the importer and the server.

export interface Doc { type: 'doc'; content: DocNode[] }

export interface DocNode {
  type: DocNodeType
  attrs?: Record<string, unknown>
  content?: DocNode[]
  text?: string
  marks?: DocMark[]
}

export type DocNodeType =
  | 'paragraph' | 'heading' | 'text' | 'hardBreak'
  | 'bulletList' | 'orderedList' | 'listItem' | 'taskList' | 'taskItem'
  | 'blockquote' | 'horizontalRule' | 'codeBlock'
  | 'callout'        // attrs: { icon?: Icon, capture?: CaptureInfo }
  | 'details' | 'detailsSummary' | 'detailsContent' // toggle; details attrs: { open: boolean, icon?: Icon }
  | 'group'          // colored container; attrs: { color?: ColorName }
  | 'columns' | 'column' // side-by-side layout; column attrs: { width?: number }
  | 'table' | 'tableRow' | 'tableHeader' | 'tableCell'
  | 'mention'        // inline object link; attrs: { objectId: Id, label: string }
  | 'objectEmbed'    // block-level object; attrs: { objectId: Id, display: 'inline' | 'card' | 'wide-card' | 'embed' | 'image' }
  | 'unsupported'    // block we could not convert; attrs: { source: string, raw: unknown }

/**
 * Marks a top-level callout as an item that arrived through a capture channel (Telegram, the
 * capture API…). The callout's icon is the channel's; the editor shows the capture time next to it.
 */
export interface CaptureInfo {
  id: Id
  /** Channel key, e.g. "telegram", "api", "shortcuts". */
  channel: string
  at: IsoDateTime
  /** Dealt with ("Reviewed", or the user's word for it): the inbox hides it until shown again. */
  done?: boolean
}

export type DocMark =
  | { type: 'bold' } | { type: 'italic' } | { type: 'strike' } | { type: 'code' }
  | { type: 'link'; attrs: { href: string } }
  /** With `quoteId`, the passage a quote object was made from (see createQuote); deleting the quote removes it. */
  | { type: 'highlight'; attrs: { color: ColorName; quoteId?: Id | null } }

// ---------------------------------------------------------------------------
// Queries and views

export interface QueryDef {
  /** Type ids to search in. Empty means all types. */
  typeIds: Id[]
  filter?: FilterGroup
  sort?: SortRule[]
  groupBy?: GroupRule[]
  /** How the results are displayed where the query is shown. */
  layout?: ViewLayout
  /** Columns of the table layout. */
  table?: TableSettings
  /** The board layout's settings. */
  board?: BoardSettings
}

export interface FilterGroup {
  kind: 'group'
  operator: 'and' | 'or'
  items: (Filter | FilterGroup)[]
}

export interface Filter {
  kind: 'filter'
  /** A PropertyDef id or a built-in field: title, tags, collections, createdAt, updatedAt, createdBy, updatedBy, date, type. */
  field: string
  operator: FilterOperator
  value?: FilterValue
}

export type FilterOperator =
  | 'is' | 'is-not' | 'contains' | 'not-contains' | 'starts-with'
  | 'is-empty' | 'is-not-empty' | 'is-checked' | 'is-not-checked'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'before' | 'after'

export type FilterValue =
  | { kind: 'literal'; value: string | number | boolean | Id[] }
  /**
   * Resolved at render time: the object the query is embedded in, the current date, the user
   * looking (`me`, for person fields: "assigned to me"), or the sprint whose dates hold today.
   * With `field`, the variable resolves to that field of the object (e.g. the parent's createdAt).
   * `offsetDays` shifts `today` (e.g. -7 for a week ago).
   */
  | { kind: 'variable'; name: 'parent' | 'today' | 'me' | 'current-sprint'; field?: string; offsetDays?: number }

export interface SortRule { field: string; direction: 'asc' | 'desc' }
export interface GroupRule { field: string }

export type ViewLayout = 'list' | 'grid' | 'wall' | 'table' | 'kanban' | 'gallery' | 'embed'

export interface ViewDef {
  id: Id
  name: string
  layout: ViewLayout
  filter?: FilterGroup
  sort?: SortRule[]
  groupBy?: GroupRule[]
  table?: TableSettings
  board?: BoardSettings
}

/**
 * The board layout's settings: which fields cards show, a second grouping in rows (swimlanes),
 * folded columns and the most cards a column should hold, by the group's key.
 */
export interface BoardSettings {
  /** Property ids, in order; unset: the first two with a value that are not the columns or lanes. */
  cardFields?: string[]
  /** A field to group cards in rows by, across the columns. */
  swimlanes?: string
  collapsed?: string[]
  wip?: Record<string, number>
}

/**
 * The table layout's columns, in order. A field is a property id or a built-in field (title, tags,
 * type, collections, createdAt, updatedAt, date, host); fields not listed (a property added later)
 * follow the listed ones. Width in pixels; `wrap` lets long values take several lines.
 */
export interface TableSettings { columns: TableColumn[]; wrap?: boolean }

export interface TableColumn { field: string; width?: number; hidden?: boolean; wrap?: boolean }

// ---------------------------------------------------------------------------
// Calendar

/**
 * One occurrence of something dated, as the calendar shows it: a daily note, an object's own date,
 * a date property (a task's due date, an event's time…) or an event from a subscribed calendar.
 */
export interface CalendarEntry {
  /** Unique within a response: source, field and occurrence start. */
  key: string
  kind: 'daily-note' | 'object' | 'property' | 'external'
  objectId?: Id
  /** Where the date comes from: a property id, or "date" for the object's own date. */
  field?: string
  start: IsoDateTime
  end?: IsoDateTime
  allDay: boolean
  /** First and last day the entry covers, in the viewer's zone. */
  startDay: string
  endDay: string
  /** Set on occurrences of a repeating date. */
  recurring?: boolean
  /** Objects' repeating dates: the start the rule gives this occurrence (it differs once moved). */
  occurrence?: IsoDateTime
  /** External events only. */
  sourceId?: Id
  title?: string
  location?: string
  description?: string
  url?: string
}

/** A read-only calendar subscribed by URL (an iCalendar feed: Google, iCloud, CalDAV servers…). */
export interface CalendarSource {
  id: Id
  spaceId: Id
  name: string
  url: string
  color?: ColorName
  /** HTTP basic auth, for private CalDAV/ICS links; the password is never sent back to clients. */
  username?: string
  hasPassword?: boolean
  enabled: boolean
  syncedAt?: IsoDateTime
  /** Last sync failure; cleared by the next successful sync. */
  error?: string
  eventCount?: number
  /** Changes when the fetched iCalendar data changes (a hash of it); replicas download it again then. */
  dataVersion?: string
  createdAt: IsoDateTime
}
