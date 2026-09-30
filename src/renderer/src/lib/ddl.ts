import type { ColumnDetail, DbType } from '../../../shared/types'
import { qualifiedTable } from './browse'

/** Editable column fields in the structure designer. */
export interface ColumnDraft {
  name: string
  type: string
  nullable: boolean
  /** Raw SQL default expression (e.g. `0`, `'abc'`, `CURRENT_TIMESTAMP`); '' = none. */
  default: string
}

export function quoteIdent(dbType: DbType | null, name: string): string {
  const q = dbType === 'postgres' ? '"' : '`'
  return q + name.split(q).join(q + q) + q
}

/** SQL string literal; MySQL also treats backslash as an escape character. */
export function sqlString(dbType: DbType | null, value: string): string {
  let v = value.replace(/'/g, "''")
  if (dbType !== 'postgres') v = v.replace(/\\/g, '\\\\')
  return `'${v}'`
}

const sameType = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

function nullClause(nullable: boolean): string {
  return nullable ? 'NULL' : 'NOT NULL'
}

function defaultClause(expr: string): string {
  return expr.trim() ? ` DEFAULT ${expr.trim()}` : ''
}

// ---- Columns ----

export function buildAddColumn(
  dbType: DbType | null,
  database: string,
  table: string,
  d: ColumnDraft
): string {
  const t = qualifiedTable(dbType, database, table)
  const nul = dbType === 'postgres' ? (d.nullable ? '' : ' NOT NULL') : ` ${nullClause(d.nullable)}`
  return `ALTER TABLE ${t} ADD COLUMN ${quoteIdent(dbType, d.name)} ${d.type.trim()}${nul}${defaultClause(d.default)}`
}

export function buildDropColumn(
  dbType: DbType | null,
  database: string,
  table: string,
  name: string
): string {
  return `ALTER TABLE ${qualifiedTable(dbType, database, table)} DROP COLUMN ${quoteIdent(dbType, name)}`
}

/**
 * Re-emits an existing MySQL default so `CHANGE COLUMN` doesn't drop it.
 * information_schema returns string defaults unquoted, so we re-quote them.
 */
export function mysqlExistingDefault(col: ColumnDetail): string | null {
  const def = col.default
  if (def === null) return null
  const upper = def.toUpperCase()
  const isTimestampFn = /^CURRENT_TIMESTAMP(\(\d*\))?$/.test(upper) || /^NOW\(\d*\)$/.test(upper)
  if (isTimestampFn) return def
  if (/DEFAULT_GENERATED/i.test(col.extra)) {
    // MySQL 8 expression default, e.g. uuid()
    return def.startsWith('(') ? def : `(${def})`
  }
  const numericType = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|bool|boolean|year)\b/i
  if (numericType.test(col.type) && /^-?\d+(\.\d+)?$/.test(def)) return def
  return sqlString('mysql', def)
}

/** Keeps MySQL column attributes (auto_increment, on update, comment) across CHANGE COLUMN. */
export function mysqlExtraClause(col: ColumnDetail): string {
  const parts: string[] = []
  if (/auto_increment/i.test(col.extra)) parts.push('AUTO_INCREMENT')
  const onUpdate = col.extra.match(/on update (\S+)/i)
  if (onUpdate) parts.push(`ON UPDATE ${onUpdate[1]}`)
  if (col.comment) parts.push(`COMMENT ${sqlString('mysql', col.comment)}`)
  return parts.length ? ' ' + parts.join(' ') : ''
}

/**
 * ALTER statement(s) turning `original` into `d`. Returns '' when nothing changed.
 * PostgreSQL returns several statements joined by `;` which run atomically.
 */
export function buildModifyColumn(
  dbType: DbType | null,
  database: string,
  table: string,
  original: ColumnDetail,
  d: ColumnDraft,
  defaultChanged: boolean
): string {
  const t = qualifiedTable(dbType, database, table)
  const renamed = d.name.trim() !== original.name
  const typeChanged = !sameType(d.type, original.type)
  const nullChanged = d.nullable !== original.nullable
  if (!renamed && !typeChanged && !nullChanged && !defaultChanged) return ''

  if (dbType === 'postgres') {
    const col = quoteIdent(dbType, original.name)
    const stmts: string[] = []
    if (typeChanged) {
      stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${d.type.trim()} USING ${col}::${d.type.trim()}`)
    }
    if (nullChanged) {
      stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${d.nullable ? 'DROP' : 'SET'} NOT NULL`)
    }
    if (defaultChanged) {
      stmts.push(
        d.default.trim()
          ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${d.default.trim()}`
          : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`
      )
    }
    // Rename last so the statements above can keep using the old name.
    if (renamed) {
      stmts.push(`ALTER TABLE ${t} RENAME COLUMN ${col} TO ${quoteIdent(dbType, d.name.trim())}`)
    }
    return stmts.join(';\n')
  }

  // MySQL: CHANGE COLUMN restates the full definition.
  const def = defaultChanged ? d.default.trim() || null : mysqlExistingDefault(original)
  return (
    `ALTER TABLE ${t} CHANGE COLUMN ${quoteIdent(dbType, original.name)} ` +
    `${quoteIdent(dbType, d.name.trim())} ${d.type.trim()} ${nullClause(d.nullable)}` +
    (def ? ` DEFAULT ${def}` : '') +
    mysqlExtraClause(original)
  )
}

// ---- Indexes ----

export function buildCreateIndex(
  dbType: DbType | null,
  database: string,
  table: string,
  name: string,
  columns: string[],
  unique: boolean
): string {
  const cols = columns.map((c) => quoteIdent(dbType, c)).join(', ')
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(dbType, name)} ON ${qualifiedTable(dbType, database, table)} (${cols})`
}

export function buildDropIndex(
  dbType: DbType | null,
  database: string,
  table: string,
  name: string
): string {
  if (dbType === 'postgres') {
    return `DROP INDEX ${quoteIdent(dbType, database)}.${quoteIdent(dbType, name)}`
  }
  return `DROP INDEX ${quoteIdent(dbType, name)} ON ${qualifiedTable(dbType, database, table)}`
}
