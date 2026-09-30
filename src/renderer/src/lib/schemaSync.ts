import type {
  ColumnDetail,
  DatabaseStructure,
  DbType,
  ForeignKeyDetail,
  IndexDetail,
  TableStructure
} from '../../../shared/types'
import { mysqlExistingDefault, mysqlExtraClause, quoteIdent, sqlString } from './ddl'

/**
 * Structure diff + sync script generation.
 *
 * Direction is always "make DESTINATION look like SOURCE":
 *   missing = exists in source only  → will be created in destination
 *   extra   = exists in destination only → can be dropped
 *   changed = exists in both but differs → destination is altered
 */
export type DiffStatus = 'missing' | 'extra' | 'changed' | 'same'

export interface ColumnDiff {
  name: string
  status: DiffStatus
  source?: ColumnDetail
  dest?: ColumnDetail
  /** "destination → source" descriptions, for status 'changed'. */
  changes: string[]
}

export interface IndexDiff {
  name: string
  status: DiffStatus
  source?: IndexDetail
  dest?: IndexDetail
  changes: string[]
}

export interface ForeignKeyDiff {
  name: string
  status: DiffStatus
  source?: ForeignKeyDetail
  dest?: ForeignKeyDetail
  changes: string[]
}

export interface TableDiff {
  /** MySQL: table name. PostgreSQL: `schema.table`. */
  key: string
  schema: string
  name: string
  status: DiffStatus
  source?: TableStructure
  dest?: TableStructure
  columns: ColumnDiff[]
  indexes: IndexDiff[]
  foreignKeys: ForeignKeyDiff[]
}

export interface StructureDiff {
  dbType: DbType
  /** Database names on each side (MySQL FKs into their own database get remapped). */
  sourceDb: string
  destDb: string
  tables: TableDiff[]
  counts: { missing: number; extra: number; changed: number }
  identical: boolean
}

// ---------------------------------------------------------------------------
// Normalization — hide cosmetic differences between server versions
// ---------------------------------------------------------------------------

function normType(dbType: DbType, type: string): string {
  let t = type.trim().toLowerCase().replace(/\s+/g, ' ')
  if (dbType === 'mysql') {
    // MySQL 8.0.19+ drops integer display widths (int(11) → int); tinyint(1) is kept.
    t = t.replace(/^(smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1')
    t = t.replace(/^tinyint\((?!1\))\d+\)/, 'tinyint')
    t = t.replace(/^integer\b/, 'int')
  }
  return t
}

function normDefault(dbType: DbType, c: ColumnDetail): string | null {
  if (c.default === null) return null
  const d = c.default.trim()
  if (dbType === 'mysql') {
    // MySQL: CURRENT_TIMESTAMP, MariaDB: current_timestamp()
    const fn = d.match(/^(current_timestamp|now)(\((\d*)\))?$/i)
    if (fn) return fn[3] ? `current_timestamp(${fn[3]})` : 'current_timestamp'
  }
  return d
}

/** Only the attributes we can sync: auto_increment / on update (MySQL), identity (PG). */
function normExtra(dbType: DbType, c: ColumnDetail): string {
  if (dbType === 'postgres') return c.extra.toLowerCase()
  const parts: string[] = []
  if (/auto_increment/i.test(c.extra)) parts.push('auto_increment')
  const onUpdate = c.extra.match(/on update (\S+)/i)
  if (onUpdate) parts.push('on update ' + onUpdate[1].toLowerCase().replace(/\(\)$/, ''))
  return parts.join(' ')
}

function columnChanges(dbType: DbType, dest: ColumnDetail, src: ColumnDetail): string[] {
  const out: string[] = []
  if (normType(dbType, dest.type) !== normType(dbType, src.type)) {
    out.push(`type: ${dest.type} → ${src.type}`)
  }
  if (dest.nullable !== src.nullable) {
    out.push(`nullable: ${dest.nullable ? 'YES' : 'NO'} → ${src.nullable ? 'YES' : 'NO'}`)
  }
  if (normDefault(dbType, dest) !== normDefault(dbType, src)) {
    out.push(`default: ${dest.default ?? 'none'} → ${src.default ?? 'none'}`)
  }
  if (normExtra(dbType, dest) !== normExtra(dbType, src)) {
    out.push(`extra: ${normExtra(dbType, dest) || 'none'} → ${normExtra(dbType, src) || 'none'}`)
  }
  if ((dest.comment ?? '') !== (src.comment ?? '')) {
    out.push(`comment: ${dest.comment ? `“${dest.comment}”` : 'none'} → ${src.comment ? `“${src.comment}”` : 'none'}`)
  }
  return out
}

function describeIndex(ix: IndexDetail): string {
  const cols = ix.columns.map((c, i) => (ix.subParts?.[i] ? `${c}(${ix.subParts[i]})` : c))
  const kind = ix.primary ? 'PRIMARY' : ix.unique ? 'UNIQUE' : 'INDEX'
  const method = ix.type && !/^btree$/i.test(ix.type) ? ` ${ix.type.toLowerCase()}` : ''
  return `${kind}${method} (${cols.join(', ') || 'expression'})`
}

/** Name-independent signature: two indexes with the same signature are equivalent. */
function indexSignature(dbType: DbType, ix: IndexDetail): string {
  if (dbType === 'postgres' && ix.definition) {
    const on = ix.definition.indexOf(' ON ')
    return `${ix.unique}|${on >= 0 ? ix.definition.slice(on) : ix.definition}`
  }
  const cols = ix.columns.map((c, i) => `${c}:${ix.subParts?.[i] ?? ''}`).join(',')
  return `${ix.primary}|${ix.unique}|${ix.type.toUpperCase()}|${cols}`
}

/** MySQL treats RESTRICT and NO ACTION identically (and reports either). */
function normRule(dbType: DbType, rule: string): string {
  const r = rule.toUpperCase()
  return dbType === 'mysql' && r === 'RESTRICT' ? 'NO ACTION' : r
}

/** What an FK links, independent of its name. `ownDb` = database the FK lives in (MySQL). */
function fkShape(fk: ForeignKeyDetail, ownDb: string | null): string {
  const ref = fk.refSchema === ownDb ? '' : fk.refSchema
  return `${fk.columns.join(',')}>${ref}.${fk.refTable}(${fk.refColumns.join(',')})`
}

function fkRules(dbType: DbType, fk: ForeignKeyDetail): string {
  return `${normRule(dbType, fk.onUpdate)}|${normRule(dbType, fk.onDelete)}|${fk.deferrable ?? ''}`
}

function describeFk(dbType: DbType, fk: ForeignKeyDetail, ownDb: string | null): string {
  const ref = fk.refSchema === ownDb ? '' : `${fk.refSchema}.`
  let s = `(${fk.columns.join(', ')}) → ${ref}${fk.refTable}(${fk.refColumns.join(', ')})`
  if (normRule(dbType, fk.onDelete) !== 'NO ACTION') s += ` ON DELETE ${fk.onDelete}`
  if (normRule(dbType, fk.onUpdate) !== 'NO ACTION') s += ` ON UPDATE ${fk.onUpdate}`
  if (fk.deferrable) s += ` ${fk.deferrable}`
  return s
}

/** MySQL compares references into "its own" database; PG keys already carry the schema. */
function ownDb(dbType: DbType, db: string): string | null {
  return dbType === 'mysql' ? db : null
}

/**
 * Pairs FKs by name first, then by shape — auto-generated names such as
 * `orders_ibfk_1` often differ between servers even when the FK is identical.
 */
function diffForeignKeys(
  dbType: DbType,
  src: ForeignKeyDetail[],
  dst: ForeignKeyDetail[],
  srcDb: string,
  dstDb: string
): ForeignKeyDiff[] {
  const sOwn = ownDb(dbType, srcDb)
  const dOwn = ownDb(dbType, dstDb)
  const unmatched = new Set(dst)
  const out: ForeignKeyDiff[] = []
  for (const s of src) {
    const shape = fkShape(s, sOwn)
    const d =
      dst.find((x) => unmatched.has(x) && x.name === s.name && fkShape(x, dOwn) === shape) ??
      dst.find((x) => unmatched.has(x) && fkShape(x, dOwn) === shape)
    if (!d) {
      out.push({ name: s.name, status: 'missing', source: s, changes: [] })
      continue
    }
    unmatched.delete(d)
    const same = fkRules(dbType, d) === fkRules(dbType, s)
    out.push({
      name: s.name,
      status: same ? 'same' : 'changed',
      source: s,
      dest: d,
      changes: same ? [] : [`${describeFk(dbType, d, dOwn)} → ${describeFk(dbType, s, sOwn)}`]
    })
  }
  for (const d of dst) {
    if (unmatched.has(d)) out.push({ name: d.name, status: 'extra', dest: d, changes: [] })
  }
  return out
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function tableKey(dbType: DbType, t: TableStructure): string {
  return dbType === 'postgres' ? `${t.database}.${t.table}` : t.table
}

/** Primary keys are matched by role, not name (PG names them `<table>_pkey`). */
function indexKey(ix: IndexDetail): string {
  return ix.primary ? '\u0000PRIMARY' : ix.name
}

export function diffStructures(source: DatabaseStructure, dest: DatabaseStructure): StructureDiff {
  const dbType = source.dbType
  const srcMap = new Map(source.tables.map((t) => [tableKey(dbType, t), t]))
  const dstMap = new Map(dest.tables.map((t) => [tableKey(dbType, t), t]))
  const keys = [...new Set([...srcMap.keys(), ...dstMap.keys()])].sort((a, b) => a.localeCompare(b))

  const tables: TableDiff[] = []
  const counts = { missing: 0, extra: 0, changed: 0 }

  for (const key of keys) {
    const src = srcMap.get(key)
    const dst = dstMap.get(key)
    const any = (src ?? dst)!
    const base = { key, schema: any.database, name: any.table, source: src, dest: dst }

    if (src && !dst) {
      counts.missing++
      tables.push({
        ...base,
        status: 'missing',
        columns: src.columns.map((c) => ({ name: c.name, status: 'missing', source: c, changes: [] })),
        indexes: src.indexes.map((i) => ({ name: i.name, status: 'missing', source: i, changes: [] })),
        foreignKeys: (src.foreignKeys ?? []).map((f) => ({ name: f.name, status: 'missing', source: f, changes: [] }))
      })
      continue
    }
    if (!src && dst) {
      counts.extra++
      tables.push({
        ...base,
        status: 'extra',
        columns: dst.columns.map((c) => ({ name: c.name, status: 'extra', dest: c, changes: [] })),
        indexes: dst.indexes.map((i) => ({ name: i.name, status: 'extra', dest: i, changes: [] })),
        foreignKeys: (dst.foreignKeys ?? []).map((f) => ({ name: f.name, status: 'extra', dest: f, changes: [] }))
      })
      continue
    }

    const s = src!
    const d = dst!
    // Columns: source order first, then destination-only columns.
    const dCols = new Map(d.columns.map((c) => [c.name, c]))
    const sColNames = new Set(s.columns.map((c) => c.name))
    const columns: ColumnDiff[] = s.columns.map((sc) => {
      const dc = dCols.get(sc.name)
      if (!dc) return { name: sc.name, status: 'missing', source: sc, changes: [] }
      const changes = columnChanges(dbType, dc, sc)
      return { name: sc.name, status: changes.length ? 'changed' : 'same', source: sc, dest: dc, changes }
    })
    for (const dc of d.columns) {
      if (!sColNames.has(dc.name)) columns.push({ name: dc.name, status: 'extra', dest: dc, changes: [] })
    }

    const dIdx = new Map(d.indexes.map((i) => [indexKey(i), i]))
    const sIdxKeys = new Set(s.indexes.map(indexKey))
    const indexes: IndexDiff[] = s.indexes.map((si) => {
      const di = dIdx.get(indexKey(si))
      if (!di) return { name: si.name, status: 'missing', source: si, changes: [] }
      const same = indexSignature(dbType, si) === indexSignature(dbType, di)
      return {
        name: si.name,
        status: same ? 'same' : 'changed',
        source: si,
        dest: di,
        changes: same ? [] : [`${describeIndex(di)} → ${describeIndex(si)}`]
      }
    })
    for (const di of d.indexes) {
      if (!sIdxKeys.has(indexKey(di))) indexes.push({ name: di.name, status: 'extra', dest: di, changes: [] })
    }

    const foreignKeys = diffForeignKeys(
      dbType,
      s.foreignKeys ?? [],
      d.foreignKeys ?? [],
      source.database,
      dest.database
    )

    const changed = [...columns, ...indexes, ...foreignKeys].some((x) => x.status !== 'same')
    if (changed) counts.changed++
    tables.push({ ...base, status: changed ? 'changed' : 'same', columns, indexes, foreignKeys })
  }

  return {
    dbType,
    sourceDb: source.database,
    destDb: dest.database,
    tables,
    counts,
    identical: counts.missing === 0 && counts.extra === 0 && counts.changed === 0
  }
}

// ---------------------------------------------------------------------------
// Sync items
// ---------------------------------------------------------------------------

export type SyncKind =
  | 'create-table'
  | 'drop-table'
  | 'add-column'
  | 'modify-column'
  | 'drop-column'
  | 'add-index'
  | 'drop-index'
  | 'replace-index'
  | 'add-fk'
  | 'drop-fk'
  | 'replace-fk'

export interface SyncItem {
  id: string
  tableKey: string
  kind: SyncKind
  /** Short human label, e.g. "ADD COLUMN qty". */
  label: string
  /** Loses data or structure (drop / primary-key replacement). Unchecked by default. */
  destructive: boolean
  /** Something the user should know before running it. */
  warning?: string
  /** MySQL: clauses merged into one ALTER TABLE per table. */
  clauses?: string[]
  /** Standalone statements (CREATE/DROP TABLE, all PostgreSQL items). */
  statements?: string[]
  /** MySQL add-column: preceding source columns, nearest first (for AFTER …). */
  after?: string[]
  /** Column affected by add-column / drop-column. */
  column?: string
  /** FK items: MySQL clause / PG statement, run before every other change. */
  fkDrop?: string
  /** FK items: MySQL clause / PG statement, run once all tables and columns exist. */
  fkAdd?: string
}

/** Execution order inside one table (drops of indexes first, new indexes last). */
const KIND_ORDER: Record<SyncKind, number> = {
  'create-table': 0,
  'drop-index': 1,
  'replace-index': 2,
  'modify-column': 3,
  'add-column': 4,
  'drop-column': 5,
  'add-index': 6,
  'drop-fk': 7,
  'replace-fk': 7,
  'add-fk': 7,
  'drop-table': 9
}

const FK_KINDS = new Set<SyncKind>(['add-fk', 'drop-fk', 'replace-fk'])

function qt(dbType: DbType, schema: string, table: string): string {
  return `${quoteIdent(dbType, schema)}.${quoteIdent(dbType, table)}`
}

// ---- MySQL ----

function mysqlColumnDef(c: ColumnDetail): string {
  const def = mysqlExistingDefault(c)
  return (
    `${quoteIdent('mysql', c.name)} ${c.type} ${c.nullable ? 'NULL' : 'NOT NULL'}` +
    (def !== null ? ` DEFAULT ${def}` : '') +
    mysqlExtraClause(c)
  )
}

function mysqlIndexCols(ix: IndexDetail): string {
  return ix.columns
    .map((c, i) => quoteIdent('mysql', c) + (ix.subParts?.[i] ? `(${ix.subParts[i]})` : ''))
    .join(', ')
}

function mysqlAddIndex(ix: IndexDetail): string {
  if (ix.primary) return `ADD PRIMARY KEY (${mysqlIndexCols(ix)})`
  const t = ix.type.toUpperCase()
  const kind = t === 'FULLTEXT' ? 'FULLTEXT ' : t === 'SPATIAL' ? 'SPATIAL ' : ix.unique ? 'UNIQUE ' : ''
  return `ADD ${kind}INDEX ${quoteIdent('mysql', ix.name)} (${mysqlIndexCols(ix)})`
}

function mysqlDropIndex(ix: IndexDetail): string {
  return ix.primary ? 'DROP PRIMARY KEY' : `DROP INDEX ${quoteIdent('mysql', ix.name)}`
}

/** Fallback when SHOW CREATE TABLE is unavailable. */
function mysqlCreateTable(db: string, t: TableStructure): string {
  const lines = t.columns.map((c) => '  ' + mysqlColumnDef(c))
  for (const ix of t.indexes) lines.push('  ' + mysqlAddIndex(ix).replace(/^ADD /, ''))
  return `CREATE TABLE ${qt('mysql', db, t.table)} (\n${lines.join(',\n')}\n)`
}

/**
 * SHOW CREATE TABLE output, qualified with the destination database, without the
 * AUTO_INCREMENT counter and without FOREIGN KEY lines (those become separate items).
 */
function mysqlQualifyCreate(db: string, table: string, ddl: string): string {
  const lines = ddl
    .replace(/^CREATE TABLE `(?:[^`]|``)+`/, `CREATE TABLE ${qt('mysql', db, table)}`)
    .replace(/\s+AUTO_INCREMENT=\d+/, '')
    .split('\n')
    .filter((l) => !/^\s*CONSTRAINT `(?:[^`]|``)+` FOREIGN KEY /.test(l))
  // The last definition line before ") ENGINE=…" must not end with a comma.
  const close = lines.findIndex((l) => l.startsWith(')'))
  if (close > 0) lines[close - 1] = lines[close - 1].replace(/,$/, '')
  return lines.join('\n')
}

// ---- PostgreSQL ----

const SERIAL_TYPES: Record<string, string> = {
  integer: 'serial',
  bigint: 'bigserial',
  smallint: 'smallserial'
}

/** Column type + attributes for CREATE TABLE / ADD COLUMN (sequence defaults become serial). */
function pgColumnDef(c: ColumnDetail): string {
  let type = c.type
  let def = c.default
  if (def && /^nextval\('.*'::regclass\)$/.test(def) && SERIAL_TYPES[c.type]) {
    type = SERIAL_TYPES[c.type]
    def = null
  }
  let s = `${quoteIdent('postgres', c.name)} ${type}`
  if (c.extra === 'identity always') s += ' GENERATED ALWAYS AS IDENTITY'
  else if (c.extra === 'identity by default') s += ' GENERATED BY DEFAULT AS IDENTITY'
  if (def !== null) s += ` DEFAULT ${def}`
  if (!c.nullable) s += ' NOT NULL'
  return s
}

function pgComment(schema: string, table: string, c: ColumnDetail): string {
  return `COMMENT ON COLUMN ${qt('postgres', schema, table)}.${quoteIdent('postgres', c.name)} IS ${
    c.comment ? sqlString('postgres', c.comment) : 'NULL'
  }`
}

function pgCreateTable(t: TableStructure): string[] {
  const lines = t.columns.map((c) => '  ' + pgColumnDef(c))
  const pk = t.indexes.find((i) => i.primary)
  if (pk) {
    lines.push(
      `  CONSTRAINT ${quoteIdent('postgres', pk.name)} PRIMARY KEY (${pk.columns
        .map((c) => quoteIdent('postgres', c))
        .join(', ')})`
    )
  }
  const out = [`CREATE TABLE ${qt('postgres', t.database, t.table)} (\n${lines.join(',\n')}\n)`]
  for (const ix of t.indexes) if (!ix.primary && ix.definition) out.push(ix.definition)
  for (const c of t.columns) if (c.comment) out.push(pgComment(t.database, t.table, c))
  return out
}

function pgAddIndex(schema: string, table: string, ix: IndexDetail): string {
  if (ix.primary) {
    const cols = ix.columns.map((c) => quoteIdent('postgres', c)).join(', ')
    return `ALTER TABLE ${qt('postgres', schema, table)} ADD CONSTRAINT ${quoteIdent('postgres', ix.name)} PRIMARY KEY (${cols})`
  }
  return ix.definition ?? ''
}

function pgDropIndex(schema: string, table: string, ix: IndexDetail): string {
  return ix.primary
    ? `ALTER TABLE ${qt('postgres', schema, table)} DROP CONSTRAINT ${quoteIdent('postgres', ix.name)}`
    : `DROP INDEX ${qt('postgres', schema, ix.name)}`
}

function pgModifyColumn(schema: string, table: string, src: ColumnDetail, dst: ColumnDetail): string[] {
  const t = qt('postgres', schema, table)
  const col = quoteIdent('postgres', src.name)
  const out: string[] = []
  if (normType('postgres', src.type) !== normType('postgres', dst.type)) {
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${src.type} USING ${col}::${src.type}`)
  }
  if (src.nullable !== dst.nullable) {
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${src.nullable ? 'DROP' : 'SET'} NOT NULL`)
  }
  if ((src.default ?? null) !== (dst.default ?? null)) {
    out.push(
      src.default === null
        ? `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`
        : `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${src.default}`
    )
  }
  if ((src.comment ?? '') !== (dst.comment ?? '')) out.push(pgComment(schema, table, src))
  return out
}

// ---- Foreign keys ----

function fkActions(fk: ForeignKeyDetail): string {
  let s = ''
  if (fk.onDelete.toUpperCase() !== 'NO ACTION') s += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate.toUpperCase() !== 'NO ACTION') s += ` ON UPDATE ${fk.onUpdate}`
  if (fk.deferrable) s += ` ${fk.deferrable}`
  return s
}

/** ADD CONSTRAINT clause; `refSchema` is already mapped to the destination side. */
function fkAddClause(dbType: DbType, fk: ForeignKeyDetail, refSchema: string): string {
  const cols = (xs: string[]): string => xs.map((c) => quoteIdent(dbType, c)).join(', ')
  return (
    `ADD CONSTRAINT ${quoteIdent(dbType, fk.name)} FOREIGN KEY (${cols(fk.columns)}) ` +
    `REFERENCES ${qt(dbType, refSchema, fk.refTable)} (${cols(fk.refColumns)})${fkActions(fk)}`
  )
}

function fkDropClause(dbType: DbType, fk: ForeignKeyDetail): string {
  return `${dbType === 'mysql' ? 'DROP FOREIGN KEY' : 'DROP CONSTRAINT'} ${quoteIdent(dbType, fk.name)}`
}

function fkItems(
  diff: StructureDiff,
  destDb: string,
  t: TableDiff,
  fks: ForeignKeyDiff[]
): SyncItem[] {
  const dbType = diff.dbType
  const table = qt(dbType, dbType === 'postgres' ? t.schema : destDb, t.name)
  // MySQL FKs into the source database must point at the destination database.
  const refSchema = (fk: ForeignKeyDetail): string =>
    dbType === 'mysql' && fk.refSchema === diff.sourceDb ? destDb : fk.refSchema
  // PostgreSQL: full statement; MySQL: clause merged into one ALTER TABLE per table.
  const sql = (clause: string): string => (dbType === 'postgres' ? `ALTER TABLE ${table} ${clause}` : clause)
  const sOwn = ownDb(dbType, diff.sourceDb)
  const dOwn = ownDb(dbType, diff.destDb)
  const items: SyncItem[] = []

  for (const fk of fks) {
    const id = `${t.key}::fk:${fk.name}`
    if (fk.status === 'missing' && fk.source) {
      items.push({
        id,
        tableKey: t.key,
        kind: 'add-fk',
        label: `ADD FOREIGN KEY ${fk.name} ${describeFk(dbType, fk.source, sOwn)}`,
        destructive: false,
        warning:
          t.status === 'missing' ? undefined : 'Fails if existing rows point to parent rows that do not exist',
        fkAdd: sql(fkAddClause(dbType, fk.source, refSchema(fk.source)))
      })
    } else if (fk.status === 'changed' && fk.source && fk.dest) {
      items.push({
        id,
        tableKey: t.key,
        kind: 'replace-fk',
        label: `REPLACE FOREIGN KEY ${fk.name} — ${fk.changes.join(', ')}`,
        destructive: false,
        warning: 'Drops and re-creates the constraint; rows are kept',
        fkDrop: sql(fkDropClause(dbType, fk.dest)),
        fkAdd: sql(fkAddClause(dbType, fk.source, refSchema(fk.source)))
      })
    } else if (fk.status === 'extra' && fk.dest) {
      items.push({
        id,
        tableKey: t.key,
        kind: 'drop-fk',
        label: `DROP FOREIGN KEY ${fk.dest.name} ${describeFk(dbType, fk.dest, dOwn)}`,
        destructive: true,
        warning: 'Removes the referential check; rows are kept',
        fkDrop: sql(fkDropClause(dbType, fk.dest))
      })
    }
  }
  return items
}

// ---- Build items ----

/**
 * Builds selectable sync items that turn destination into source.
 * `destDb` is the destination database (MySQL); PostgreSQL uses each table's schema.
 * `createSql` holds SHOW CREATE TABLE output for missing MySQL tables.
 */
export function buildSyncItems(
  diff: StructureDiff,
  destDb: string,
  createSql: Record<string, string> = {}
): SyncItem[] {
  const dbType = diff.dbType
  const items: SyncItem[] = []
  const schemaOf = (t: TableDiff): string => (dbType === 'postgres' ? t.schema : destDb)
  const destSchemas = new Set(diff.tables.filter((t) => t.dest).map((t) => t.schema))

  for (const t of diff.tables) {
    const schema = schemaOf(t)
    const table = qt(dbType, schema, t.name)
    const id = (suffix: string): string => `${t.key}::${suffix}`

    if (t.status === 'missing' && t.source) {
      let statements: string[]
      if (dbType === 'postgres') {
        statements = pgCreateTable(t.source)
        if (!destSchemas.has(t.schema)) {
          statements.unshift(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent('postgres', t.schema)}`)
        }
      } else {
        const native = createSql[t.name]
        statements = [native ? mysqlQualifyCreate(schema, t.name, native) : mysqlCreateTable(schema, t.source)]
      }
      items.push({
        id: id('create'),
        tableKey: t.key,
        kind: 'create-table',
        label: `CREATE TABLE ${t.key}`,
        destructive: false,
        statements
      })
      // FKs are added after every new table exists, so creation order never matters.
      items.push(...fkItems(diff, destDb, t, t.foreignKeys))
      continue
    }

    if (t.status === 'extra') {
      items.push({
        id: id('drop'),
        tableKey: t.key,
        kind: 'drop-table',
        label: `DROP TABLE ${t.key}`,
        destructive: true,
        warning: 'Deletes the table and all of its rows',
        statements: [`DROP TABLE ${table}`]
      })
      continue
    }

    if (t.status !== 'changed' || !t.source) continue
    const srcCols = t.source.columns.map((c) => c.name)

    for (const c of t.columns) {
      if (c.status === 'missing' && c.source) {
        const pos = srcCols.indexOf(c.name)
        const warning =
          dbType === 'postgres' && !c.source.nullable && c.source.default === null && !c.source.extra
            ? 'NOT NULL without a default fails if the table already has rows'
            : undefined
        items.push({
          id: id(`addcol:${c.name}`),
          tableKey: t.key,
          kind: 'add-column',
          label: `ADD COLUMN ${c.name} ${c.source.type}`,
          destructive: false,
          warning,
          column: c.name,
          after: srcCols.slice(0, pos).reverse(),
          ...(dbType === 'postgres'
            ? {
                statements: [
                  `ALTER TABLE ${table} ADD COLUMN ${pgColumnDef(c.source)}`,
                  ...(c.source.comment ? [pgComment(schema, t.name, c.source)] : [])
                ]
              }
            : { clauses: [`ADD COLUMN ${mysqlColumnDef(c.source)}`] })
        })
      } else if (c.status === 'changed' && c.source && c.dest) {
        const typeChanged = c.changes.some((x) => x.startsWith('type:'))
        items.push({
          id: id(`modcol:${c.name}`),
          tableKey: t.key,
          kind: 'modify-column',
          label: `MODIFY ${c.name} — ${c.changes.join(', ')}`,
          destructive: false,
          warning: typeChanged
            ? 'Type change can truncate/convert existing values and may lock a large table'
            : undefined,
          ...(dbType === 'postgres'
            ? { statements: pgModifyColumn(schema, t.name, c.source, c.dest) }
            : { clauses: [`MODIFY COLUMN ${mysqlColumnDef(c.source)}`] })
        })
      } else if (c.status === 'extra') {
        items.push({
          id: id(`dropcol:${c.name}`),
          tableKey: t.key,
          kind: 'drop-column',
          label: `DROP COLUMN ${c.name}`,
          destructive: true,
          warning: 'Deletes the column and its data (renamed columns also show up as drop + add)',
          column: c.name,
          ...(dbType === 'postgres'
            ? { statements: [`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(dbType, c.name)}`] }
            : { clauses: [`DROP COLUMN ${quoteIdent(dbType, c.name)}`] })
        })
      }
    }

    for (const ix of t.indexes) {
      const label = ix.source?.primary || ix.dest?.primary ? 'PRIMARY KEY' : `INDEX ${ix.name}`
      if (ix.status === 'missing' && ix.source) {
        items.push({
          id: id(`addidx:${ix.name}`),
          tableKey: t.key,
          kind: 'add-index',
          label: `ADD ${label} ${describeIndex(ix.source).replace(/^\S+ /, '')}`,
          destructive: false,
          warning: ix.source.unique ? 'Fails if existing rows contain duplicates' : undefined,
          ...(dbType === 'postgres'
            ? { statements: [pgAddIndex(schema, t.name, ix.source)] }
            : { clauses: [mysqlAddIndex(ix.source)] })
        })
      } else if (ix.status === 'changed' && ix.source && ix.dest) {
        items.push({
          id: id(`repidx:${ix.name}`),
          tableKey: t.key,
          kind: 'replace-index',
          label: `REBUILD ${label} — ${ix.changes.join(', ')}`,
          destructive: Boolean(ix.dest.primary),
          warning: ix.dest.primary ? 'Replaces the primary key' : undefined,
          ...(dbType === 'postgres'
            ? {
                statements: [
                  pgDropIndex(schema, t.name, ix.dest),
                  pgAddIndex(schema, t.name, ix.source)
                ]
              }
            : { clauses: [mysqlDropIndex(ix.dest), mysqlAddIndex(ix.source)] })
        })
      } else if (ix.status === 'extra' && ix.dest) {
        items.push({
          id: id(`dropidx:${ix.name}`),
          tableKey: t.key,
          kind: 'drop-index',
          label: `DROP ${label}`,
          destructive: true,
          warning: ix.dest.primary ? 'Removes the primary key' : 'Queries relying on it may slow down',
          ...(dbType === 'postgres'
            ? { statements: [pgDropIndex(schema, t.name, ix.dest)] }
            : { clauses: [mysqlDropIndex(ix.dest)] })
        })
      }
    }

    items.push(...fkItems(diff, destDb, t, t.foreignKeys))
  }
  return items
}

/**
 * Turns the selected items into an ordered list of statements:
 *   1. drop foreign keys   (so columns/indexes/tables they pin can change)
 *   2. create tables
 *   3. per-table alters    (MySQL: one ALTER TABLE per table)
 *   4. add foreign keys    (every referenced table/column now exists)
 *   5. drop tables
 */
export function buildSyncScript(
  diff: StructureDiff,
  destDb: string,
  items: SyncItem[]
): string[] {
  const dbType = diff.dbType
  const sorted = [...items].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  const creates = sorted.filter((i) => i.kind === 'create-table').flatMap((i) => i.statements ?? [])
  const drops = sorted.filter((i) => i.kind === 'drop-table').flatMap((i) => i.statements ?? [])
  const fkDrops: string[] = []
  const fkAdds: string[] = []
  const alters: string[] = []

  for (const t of diff.tables) {
    const fks = sorted.filter((i) => i.tableKey === t.key && FK_KINDS.has(i.kind))
    const drop = fks.flatMap((i) => (i.fkDrop ? [i.fkDrop] : []))
    const add = fks.flatMap((i) => (i.fkAdd ? [i.fkAdd] : []))
    if (dbType === 'postgres') {
      fkDrops.push(...drop)
      fkAdds.push(...add)
    } else {
      // MySQL can't drop and re-add an FK of the same name in one ALTER, so they stay apart.
      const table = qt(dbType, destDb, t.name)
      if (drop.length) fkDrops.push(`ALTER TABLE ${table}\n  ${drop.join(',\n  ')}`)
      if (add.length) fkAdds.push(`ALTER TABLE ${table}\n  ${add.join(',\n  ')}`)
    }

    const own = sorted.filter(
      (i) =>
        i.tableKey === t.key &&
        i.kind !== 'create-table' &&
        i.kind !== 'drop-table' &&
        !FK_KINDS.has(i.kind)
    )
    if (own.length === 0) continue

    if (dbType === 'postgres') {
      for (const i of own) alters.push(...(i.statements ?? []))
      continue
    }

    // MySQL: merge into a single ALTER TABLE (one table rebuild instead of many).
    const destCols = new Set(t.dest?.columns.map((c) => c.name) ?? [])
    const dropped = new Set(own.filter((i) => i.kind === 'drop-column').map((i) => i.column))
    const present = new Set([...destCols].filter((c) => !dropped.has(c)))
    const clauses: string[] = []
    for (const i of own) {
      if (i.kind === 'add-column' && i.clauses) {
        const anchor = i.after?.find((c) => present.has(c))
        clauses.push(i.clauses[0] + (anchor ? ` AFTER ${quoteIdent(dbType, anchor)}` : ' FIRST'))
        if (i.column) present.add(i.column)
      } else {
        clauses.push(...(i.clauses ?? []))
      }
    }
    alters.push(`ALTER TABLE ${qt(dbType, destDb, t.name)}\n  ${clauses.join(',\n  ')}`)
  }

  return [...fkDrops, ...creates, ...alters, ...fkAdds, ...drops]
}
