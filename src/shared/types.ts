// Shared types between main, preload, and renderer.

export type DbType = 'mysql' | 'postgres'

/** Connection config as stored on disk (password stored separately, encrypted). */
export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  host: string
  port: number
  user: string
  /** Default database/schema to connect to (optional). */
  database?: string
  ssl?: boolean
  /** True when an encrypted password is stored for this connection. */
  hasPassword?: boolean
}

/** Payload sent from the form to save a connection (includes plaintext password). */
export interface ConnectionInput {
  id?: string
  name: string
  type: DbType
  host: string
  port: number
  user: string
  password?: string
  database?: string
  ssl?: boolean
}

/** A single column's metadata within a table. */
export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
}

export interface TableInfo {
  database: string
  name: string
  columns: ColumnInfo[]
}

/** Full schema snapshot used for the tree + autocomplete. */
export interface SchemaSnapshot {
  databases: string[]
  tables: TableInfo[]
}

/** Detailed column info for the table-structure view/designer. */
export interface ColumnDetail {
  name: string
  /** Full type incl. length/precision, e.g. `varchar(100)`, `numeric(10,2)`. */
  type: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
  /** e.g. `auto_increment` (MySQL), `identity by default` (PG); empty otherwise. */
  extra: string
  /** Column comment, or null when none. */
  comment?: string | null
}

export interface IndexDetail {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  type: string
  /** MySQL prefix lengths per column (null = whole column). */
  subParts?: (number | null)[]
  /** PostgreSQL: full `CREATE INDEX` statement from pg_get_indexdef. */
  definition?: string
}

export interface ForeignKeyDetail {
  name: string
  columns: string[]
  /** Database (MySQL) or schema (PostgreSQL) of the referenced table. */
  refSchema: string
  refTable: string
  refColumns: string[]
  /** CASCADE | SET NULL | SET DEFAULT | RESTRICT | NO ACTION */
  onUpdate: string
  onDelete: string
  /** PostgreSQL only: '' | 'DEFERRABLE' | 'DEFERRABLE INITIALLY DEFERRED' */
  deferrable?: string
}

export interface TableStructure {
  database: string
  table: string
  columns: ColumnDetail[]
  indexes: IndexDetail[]
  foreignKeys?: ForeignKeyDetail[]
}

/** Every base table of one database (MySQL) or of all schemas in a database (PG). */
export interface DatabaseStructure {
  dbType: DbType
  database: string
  tables: TableStructure[]
}

/** Outcome of running a sync script against a destination. */
export interface ScriptResult {
  total: number
  /** Statements that ran successfully (0 after a PostgreSQL rollback). */
  executed: number
  /** True when PostgreSQL rolled the whole script back after an error. */
  rolledBack: boolean
  error?: { index: number; message: string }
}

/** Returned after connecting or switching the active database. */
export interface ConnectResult {
  schema: SchemaSnapshot
  /** All databases available on the server (for the DB picker). */
  databases: string[]
  /** The currently active database, or null when browsing all (MySQL). */
  currentDatabase: string | null
}

/** Result of running a query. */
export interface QueryResult {
  /** Column names in order (empty for non-SELECT statements). */
  columns: string[]
  /** Row objects keyed by column name. */
  rows: Record<string, unknown>[]
  rowCount: number
  durationMs: number
  /** Populated for non-SELECT statements (INSERT/UPDATE/DDL). */
  affectedRows?: number
  message?: string
  /** Which columns can be edited inline and where they are stored (null = read-only). */
  editable?: EditableMeta | null
}

/** One source table of a result set that can be written back to. */
export interface EditableTable {
  /** Database (MySQL) or schema (PostgreSQL). */
  database: string
  table: string
  /** Short name for the UI, e.g. the alias used in the query. */
  label: string
  primaryKey: string[]
  /** Result column holding each primary-key value, aligned with `primaryKey`. */
  pkColumns: string[]
}

/** Where an editable result column is stored. */
export interface EditableColumn {
  /** Index into EditableMeta.tables. */
  table: number
  /** Real column name in that table. */
  column: string
}

/**
 * Metadata that enables inline editing of a result set — also for joins: every
 * source table whose full primary key is part of the result is editable.
 */
export interface EditableMeta {
  tables: EditableTable[]
  /** Result column name → where it is stored. Columns not listed are read-only. */
  columns: Record<string, EditableColumn>
}

/** A single cell change staged for an inline update. */
export interface CellChange {
  /** Index into EditableMeta.tables. */
  table: number
  /** Values of that table's primary-key columns identifying the row. */
  pk: Record<string, unknown>
  /** Real column name in that table. */
  column: string
  value: unknown
}

export interface UpdateTarget {
  database?: string
  table: string
  primaryKey: string[]
  changes: { pk: Record<string, unknown>; column: string; value: unknown }[]
}

/** Updates for one or more tables, applied in a single transaction. */
export interface UpdatePayload {
  targets: UpdateTarget[]
}

export interface UpdateResult {
  updatedRows: number
}

export interface HistoryEntry {
  id: string
  connectionId: string
  connectionName: string
  sql: string
  ts: number
  ok: boolean
  rowCount?: number
  durationMs?: number
  error?: string
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
  dbType?: DbType
  ts: number
}

export type ExportFormat = 'csv' | 'json' | 'xlsx'

export interface ExportPayload {
  format: ExportFormat
  columns: string[]
  rows: Record<string, unknown>[]
  suggestedName?: string
}

/** Generic wrapper so IPC calls never throw across the boundary. */
export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

// ---- Backup / restore ----

export interface BackupOptions {
  /** false = structure only. */
  includeData: boolean
  /** Write .sql.gz instead of .sql. */
  compress: boolean
  /** 'ask' shows a save dialog; 'auto' writes to Documents/ConnectD Backups. */
  target: 'ask' | 'auto'
}

export interface JobProgress {
  jobId: string
  phase: 'schema' | 'data' | 'objects' | 'restore'
  /** Table currently being dumped. */
  table?: string
  tablesDone?: number
  tablesTotal?: number
  rows?: number
  /** Backup: bytes written (uncompressed). Restore: bytes of the file read so far. */
  bytes: number
  /** Restore: file size. */
  totalBytes?: number
  statements?: number
}

export interface BackupResult {
  filePath: string
  tables: number
  rows: number
  bytes: number
  durationMs: number
}

export interface BackupFileInfo {
  filePath: string
  size: number
  compressed: boolean
  /** Engine the file was made for, when it can be detected. */
  engine: DbType | null
  database: string | null
  createdAt: string | null
  source: 'connectd' | 'mysqldump' | 'pg_dump' | 'unknown'
}

export interface RestoreOptions {
  /** Create the target database first. */
  createDatabase: boolean
  /** PostgreSQL: all-or-nothing in one transaction. */
  singleTransaction: boolean
  /** Log failing statements and keep going instead of stopping. */
  continueOnError: boolean
}

export interface RestoreError {
  index: number
  message: string
  sql: string
}

export interface RestoreResult {
  statements: number
  /** USE / CREATE DATABASE / psql meta-commands that were ignored. */
  skipped: number
  errors: RestoreError[]
  /** Set when the restore stopped (error without continueOnError, or cancelled). */
  failed: boolean
  cancelled: boolean
  /** PostgreSQL single-transaction restore was rolled back. */
  rolledBack: boolean
  durationMs: number
}

// ---- Connection export / import ----

export interface ConnectionExportResult {
  saved: boolean
  path?: string
  count?: number
  /** Number of passwords written (encrypted with the passphrase). */
  passwords?: number
}

export interface ImportPreviewItem {
  name: string
  type: DbType
  host: string
  port: number
  user: string
  database?: string
  hasPassword: boolean
  /** Name of an already saved connection with the same server/user/database. */
  existingName?: string
}

export interface ImportPreview {
  filePath: string
  exportedAt?: string
  /** True when the file carries passphrase-encrypted passwords. */
  encrypted: boolean
  items: ImportPreviewItem[]
}

export interface ImportOptions {
  /** Indexes into the preview's items to import. */
  indexes: number[]
  /** What to do with items matching a saved connection. */
  duplicates: 'skip' | 'replace' | 'copy'
  /** Needed to import passwords; without it passwords are left out. */
  passphrase?: string
}

export interface ImportResult {
  added: number
  replaced: number
  skipped: number
  passwords: number
  /** Passwords that could not be stored (OS encryption unavailable). */
  passwordsNotStored: number
}
