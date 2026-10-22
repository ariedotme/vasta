// SQLite schema shared by every Vasta store (server, desktop, browser via sqlite-wasm).
// JSON columns hold the parts of the model that are always read and written whole.

export const SCHEMA_VERSION = 4

/**
 * Columns added after a table was first created. They are checked on every open and added when
 * missing, so an upgrade does not depend on the recorded schema version being accurate.
 */
export const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'types', column: 'deleted_at', definition: 'TEXT' },
  { table: 'objects', column: 'date_rrule', definition: 'TEXT' },
  { table: 'objects', column: 'date_tz', definition: 'TEXT' },
  { table: 'objects', column: 'date_exceptions', definition: 'TEXT' },
  { table: 'sessions', column: 'last_seen_at', definition: 'TEXT' },
  // Deleted spaces wait 30 days in the trash before they are purged (AccountService.deleteSpace).
  { table: 'spaces', column: 'deleted_at', definition: 'TEXT' },
  // Sync (docs/sync-plan.md): the global revision of the row's last write, and per-field HLCs (JSON).
  ...['spaces', 'types', 'objects', 'calendar_sources'].flatMap((table) => [
    { table, column: 'rev', definition: 'INTEGER' },
    { table, column: 'clock', definition: 'TEXT' },
  ]),
  // A hash of a subscribed calendar's iCalendar data, so replicas know when to download it again.
  { table: 'calendar_sources', column: 'data_hash', definition: 'TEXT' },
  // An object's own color and the object it sits under (tags: color-coding and nested tags).
  { table: 'objects', column: 'color', definition: 'TEXT' },
  { table: 'objects', column: 'parent_id', definition: 'TEXT' },
  // JSON InboxPreferences (Settings › Inbox).
  { table: 'users', column: 'inbox', definition: 'TEXT' },
  // JSON NutritionSettings: food tracking turned on, and the space's meals.
  { table: 'spaces', column: 'nutrition', definition: 'TEXT' },
  // JSON SprintSettings: sprints turned on, and what the space calls them.
  { table: 'spaces', column: 'sprints', definition: 'TEXT' },
  // Who made an object and who changed it last (user ids; ObjectRecord.createdBy, updatedBy).
  { table: 'objects', column: 'created_by', definition: 'TEXT' },
  { table: 'objects', column: 'updated_by', definition: 'TEXT' },
]

/** Indexes on added columns; run after ADDED_COLUMNS, since an older table may lack them before. */
export const ADDED_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS spaces_rev ON spaces(rev);
CREATE INDEX IF NOT EXISTS types_rev ON types(space_id, rev);
CREATE INDEX IF NOT EXISTS objects_rev ON objects(space_id, rev);
CREATE INDEX IF NOT EXISTS calendar_sources_rev ON calendar_sources(space_id, rev);
`

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,           -- JSON Icon
  sidebar    TEXT NOT NULL,  -- JSON SidebarSection[]
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS types (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  system      TEXT,
  name        TEXT NOT NULL,
  plural_name TEXT NOT NULL,
  description TEXT,
  icon        TEXT,          -- JSON Icon
  color       TEXT,
  properties  TEXT NOT NULL, -- JSON PropertyDef[]
  views       TEXT NOT NULL, -- JSON ViewDef[]
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS types_space_system ON types(space_id, system) WHERE system IS NOT NULL;

CREATE TABLE IF NOT EXISTS objects (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL REFERENCES spaces(id),
  type_id        TEXT NOT NULL REFERENCES types(id),
  title          TEXT NOT NULL,
  description    TEXT,
  icon           TEXT,          -- JSON Icon
  cover_url      TEXT,
  aliases        TEXT NOT NULL, -- JSON string[]
  tag_ids        TEXT NOT NULL, -- JSON Id[]
  collection_ids TEXT NOT NULL, -- JSON Id[]
  props          TEXT NOT NULL, -- JSON Record<Id, PropertyValue>
  content        TEXT NOT NULL, -- JSON Record<Id, Doc>
  date_start     TEXT,
  date_end       TEXT,
  date_res       TEXT,
  date_rrule     TEXT,
  date_tz        TEXT,
  date_exceptions TEXT,         -- JSON Record<IsoDateTime, DateException>
  query          TEXT,          -- JSON QueryDef
  media          TEXT,          -- JSON MediaInfo
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS objects_type ON objects(type_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS objects_date ON objects(date_start) WHERE date_start IS NOT NULL;
CREATE INDEX IF NOT EXISTS objects_created ON objects(space_id, created_at);
-- What reads many objects without needing their rows (search by title, counts per type, the
-- trash's count) reads these instead: on a replica every page of the table is a read of OPFS, and
-- the rows carry the rich text.
CREATE INDEX IF NOT EXISTS objects_updated ON objects(space_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS objects_titles ON objects(space_id, deleted_at, type_id, title, aliases);

-- Derived from objects: every reference from one object to another, for backlinks.
CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  kind    TEXT NOT NULL, -- mention | embed | relation | tag | collection
  via     TEXT NOT NULL, -- property id for relations, content field id for mentions/embeds, '' otherwise
  PRIMARY KEY (from_id, to_id, kind, via)
);
CREATE INDEX IF NOT EXISTS links_to ON links(to_id);

-- Derived from objects: full-text search over titles and rich text.
CREATE VIRTUAL TABLE IF NOT EXISTS objects_fts USING fts5(
  object_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- The rowid of each object's row in objects_fts: its object_id is not indexed, so writes and joins
-- find the row through here instead of scanning the index.
CREATE TABLE IF NOT EXISTS search_rows (
  id        INTEGER PRIMARY KEY,
  object_id TEXT NOT NULL UNIQUE
);

-- What users did to objects (activity.ts); the server records it, apps read it over HTTP.
CREATE TABLE IF NOT EXISTS activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id  TEXT NOT NULL,
  object_id TEXT NOT NULL,
  at        TEXT NOT NULL,
  actor     TEXT,           -- user id
  kind      TEXT NOT NULL,  -- created | changed | trashed | restored
  field     TEXT,           -- for changed: title, typeId, date or a property id
  before    TEXT,           -- JSON
  after     TEXT            -- JSON
);
CREATE INDEX IF NOT EXISTS activity_object ON activity(object_id, at);
CREATE INDEX IF NOT EXISTS activity_space ON activity(space_id, at);

-- What a user is told about others' work (server notifications.ts): assigned, mentioned, a comment.
CREATE TABLE IF NOT EXISTS notifications (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL,
  space_id  TEXT NOT NULL,
  object_id TEXT NOT NULL,
  at        TEXT NOT NULL,
  actor     TEXT,
  kind      TEXT NOT NULL,  -- assigned | mentioned | comment
  ref       TEXT,           -- the comment, for mentions and comments
  text      TEXT,           -- the comment's text
  read_at   TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, at);

-- People who log in. Access is per space, through space_members.
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL,
  password_hash    TEXT NOT NULL,  -- "scrypt$N$r$p$salt$hash" (base64)
  time_zone        TEXT,
  capture_space_id TEXT,
  telegram_user_id INTEGER UNIQUE,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,  -- SpaceRole
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS space_members_user ON space_members(user_id);

-- Logged-in browsers. The cookie holds a random secret; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,  -- hex SHA-256 of the cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

-- Failed logins per username, so the throttle survives a restart. \`until\` is epoch ms.
CREATE TABLE IF NOT EXISTS login_failures (
  name       TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  until      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bearer tokens for capture channels and scripts; only their SHA-256 is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL,  -- TokenScope
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- Links that let someone make an account (Settings › Server accounts); only their SHA-256 is stored.
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  hash       TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id   TEXT,
  role       TEXT,     -- SpaceRole
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Read-only calendars subscribed by URL. \`data\` is the last iCalendar text fetched.
CREATE TABLE IF NOT EXISTS calendar_sources (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  color       TEXT,
  username    TEXT,
  password    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  data        TEXT,
  etag        TEXT,
  event_count INTEGER,
  synced_at   TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL
);

-- Synced rows deleted for good (purged), so clients learn they are gone. \`kind\` is the table.
CREATE TABLE IF NOT EXISTS sync_tombstones (
  kind     TEXT NOT NULL,
  id       TEXT NOT NULL,
  space_id TEXT NOT NULL,
  rev      INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS sync_tombstones_rev ON sync_tombstones(space_id, rev);

-- Rich text of an object as one Yjs document (one XmlFragment per rich-text field). objects.content
-- is derived from it. \`rev\` is the object's rev when the two last matched: a row written by a
-- version without Yjs (a rollback) is converted again on open. No foreign key: objects are written
-- with INSERT OR REPLACE, which would cascade.
CREATE TABLE IF NOT EXISTS object_docs (
  object_id TEXT PRIMARY KEY,
  ydoc      BLOB NOT NULL,
  vector    BLOB NOT NULL,
  rev       INTEGER
);

-- Original records kept verbatim by importers, so imports can be re-mapped later without data loss.
CREATE TABLE IF NOT EXISTS import_sources (
  object_id TEXT NOT NULL,
  source    TEXT NOT NULL, -- e.g. "capacities"
  source_id TEXT NOT NULL,
  raw       TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
`
