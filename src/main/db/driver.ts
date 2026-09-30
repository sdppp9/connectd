import type {
  DbType,
  SchemaSnapshot,
  ScriptResult,
  TableStructure,
  UpdatePayload
} from '../../shared/types'

/** The base-table column a result column was read from, as reported by the server. */
export interface ColumnOrigin {
  /** Database (MySQL) or schema (PostgreSQL). May be '' when the server omits it. */
  schema: string
  table: string
  column: string
  /**
   * Identifies one table reference in the query. MySQL reports the alias, so a
   * self-join gives two instances; PostgreSQL only reports the table, so it can't.
   */
  instance: string
  /** Alias used in the query, when known. */
  alias?: string
}

export interface QueryExecResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  /** Aligned with `columns`; null for expressions / computed columns. */
  origins?: (ColumnOrigin | null)[]
  /** Set for non-SELECT statements. */
  affectedRows?: number
  message?: string
}

/**
 * Result column names made unique so rows can be keyed by name: in
 * `SELECT * FROM a JOIN b` both `id`s would otherwise overwrite each other.
 * Repeated names become `qualifier.name`, then `name (2)`, `name (3)`…
 */
export function uniqueColumnNames(cols: { name: string; qualifier?: string }[]): string[] {
  const counts = new Map<string, number>()
  for (const c of cols) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  const used = new Set<string>()
  return cols.map((c) => {
    const base = (counts.get(c.name) ?? 0) > 1 && c.qualifier ? `${c.qualifier}.${c.name}` : c.name
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base} (${i})`
    used.add(name)
    return name
  })
}

/** Uniform interface implemented by each database driver. */
export interface Driver {
  readonly type: DbType
  connect(): Promise<void>
  query(sql: string): Promise<QueryExecResult>
  /** Introspect schema; when scopeDb is given, limit to that database (MySQL). */
  introspect(scopeDb?: string): Promise<SchemaSnapshot>
  /** Lists databases available on the server (for the DB picker). */
  listDatabases(): Promise<string[]>
  /** The database currently in use on this connection, or null. */
  currentDatabase(): Promise<string | null>
  /** Full column + index details for one table (structure designer). */
  describeTable(database: string, table: string): Promise<TableStructure>
  /**
   * Structure of every base table: MySQL → tables of `database`;
   * PostgreSQL → tables of all user schemas in the connected database.
   */
  describeDatabase(database: string): Promise<TableStructure[]>
  /** Native CREATE TABLE statements keyed by table name (MySQL only; PG returns {}). */
  showCreateTables(database: string, tables: string[]): Promise<Record<string, string>>
  /** Runs statements in order on one session, stopping at the first error. */
  executeScript(statements: string[]): Promise<ScriptResult>
  /** Runs staged cell changes inside a transaction, returns rows updated. */
  update(payload: UpdatePayload): Promise<number>
  close(): Promise<void>
}
