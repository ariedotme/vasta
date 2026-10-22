// Reading Capacities' local database.
//
// The Capacities desktop app keeps a SQLite database inside Chromium's Origin Private
// File System, using sqlite-wasm's "opfs-sahpool" VFS. Each pooled file starts with a
// 4096-byte header whose first bytes are the logical file name (e.g. "/capacities-db-v1.sqlite3");
// the SQLite database follows the header.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SAH_HEADER_SIZE = 4096
const SQLITE_MAGIC = 'SQLite format 3\0'

export const DEFAULT_CAPACITIES_DIR = path.join(homedir(), 'Library', 'Application Support', 'Capacities')

export interface PooledDatabase {
  file: string
  logicalName: string
  bytes: number
}

function readHead(file: string, length: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function* walkFiles(dir: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else if (entry.isFile()) yield full
  }
}

/** Find Capacities databases stored in the OPFS pool of the desktop app. */
export function findPooledDatabases(capacitiesDir = DEFAULT_CAPACITIES_DIR): PooledDatabase[] {
  const found: PooledDatabase[] = []
  for (const file of walkFiles(path.join(capacitiesDir, 'File System'))) {
    const { size } = statSync(file)
    if (size <= SAH_HEADER_SIZE) continue
    const head = readHead(file, SAH_HEADER_SIZE + SQLITE_MAGIC.length)
    const logicalName = head.subarray(0, 256).toString('utf8').split('\0')[0] ?? ''
    if (!logicalName.startsWith('/capacities-db')) continue
    if (head.subarray(SAH_HEADER_SIZE).toString('latin1') !== SQLITE_MAGIC) continue
    found.push({ file, logicalName, bytes: size - SAH_HEADER_SIZE })
  }
  return found.sort((a, b) => b.bytes - a.bytes)
}

/**
 * Copy a database to a temporary plain SQLite file, stripping the pool header if present.
 * Copying keeps the app's live file untouched and gives us a stable snapshot to read.
 */
export function snapshotDatabase(file: string): string {
  const data = readFileSync(file)
  const pooled = data.subarray(SAH_HEADER_SIZE, SAH_HEADER_SIZE + SQLITE_MAGIC.length).toString('latin1') === SQLITE_MAGIC
  const plain = data.subarray(0, SQLITE_MAGIC.length).toString('latin1') === SQLITE_MAGIC
  if (!pooled && !plain) throw new Error(`${file} is not a SQLite database`)
  const out = path.join(tmpdir(), `capacities-snapshot-${process.pid}-${Date.now()}.sqlite3`)
  writeFileSync(out, pooled ? data.subarray(SAH_HEADER_SIZE) : data)
  return out
}

/** One row of Capacities' `components` table. */
export interface ComponentRow {
  id: string
  spaceId: string | null
  structureId: string | null
  title: string | null
  createdAt: string
  lastUpdated: string
  deleteRequested: number
  dateResolution: string | null
  startTime: string | null
  endTime: string | null
  component: CapComponent
}

/** The JSON document Capacities stores for every object. Only the fields we read are typed. */
export interface CapComponent {
  id: string
  type: string
  structureId: string
  createdAt?: string
  deleteRequested?: boolean
  properties?: Record<string, { val?: unknown } | undefined>
  data?: Record<string, unknown> & { blocks?: Record<string, CapBlock[]> }
  databases?: { id: string }[]
  local?: { loadingError?: string }
}

export interface CapBlock {
  id: string
  type: string
  [key: string]: unknown
}

export function readComponents(sqliteFile: string): ComponentRow[] {
  const db = new DatabaseSync(sqliteFile, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT id, spaceId, structureId, title, createdAt, lastUpdated, deleteRequested,
                dateResolution, startTime, endTime, component
           FROM components`
      )
      .all() as (Omit<ComponentRow, 'component'> & { component: string | null })[]
    return rows
      .filter((row) => row.component)
      .map((row) => ({ ...row, component: JSON.parse(row.component!) as CapComponent }))
  } finally {
    db.close()
  }
}
