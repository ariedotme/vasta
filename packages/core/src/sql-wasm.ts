// The store's SQL calls on sqlite-wasm (@sqlite.org/sqlite-wasm's oo1 API), for the browser's
// local replica. Statements are prepared once per SQL text and kept (the most recently used few
// hundred): preparing is a good part of a call's cost in wasm. Each call resets its statement
// before returning, so none is left running.
import type { Database, PreparedStatement } from '@sqlite.org/sqlite-wasm'
import type { Row, SqlDatabase, SqlValue } from './store.ts'

const KEPT_STATEMENTS = 256

export function wasmDatabase(db: Database): SqlDatabase {
  const statements = new Map<string, PreparedStatement>()
  const use = <T>(sql: string, params: SqlValue[], fn: (statement: PreparedStatement) => T): T => {
    let statement = statements.get(sql)
    if (statement) statements.delete(sql)
    else statement = db.prepare(sql)
    statements.set(sql, statement)
    if (statements.size > KEPT_STATEMENTS) {
      const [oldest, unused] = statements.entries().next().value!
      statements.delete(oldest)
      unused.finalize()
    }
    try {
      // sqlite-wasm refuses an empty binding for a statement without parameters.
      if (params.length) statement.bind(params)
      return fn(statement)
    } finally {
      statement.reset(true)
    }
  }
  return {
    exec: (sql) => {
      db.exec(sql)
    },
    prepare: (sql) => ({
      all: (...params) =>
        use(sql, params, (statement) => {
          const rows: Row[] = []
          while (statement.step()) rows.push(statement.get({}) as Row)
          return rows
        }),
      get: (...params) => use(sql, params, (statement) => (statement.step() ? (statement.get({}) as Row) : undefined)),
      run: (...params) => {
        use(sql, params, (statement) => {
          while (statement.step());
        })
      },
    }),
    close: () => {
      for (const statement of statements.values()) statement.finalize()
      statements.clear()
      db.close()
    },
  }
}
