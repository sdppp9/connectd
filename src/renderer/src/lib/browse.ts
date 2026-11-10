import type { DbType } from '../../../shared/types'

export const PAGE_SIZE = 100

function quoteChar(dbType: DbType | null): string {
  return dbType === 'postgres' ? '"' : '`'
}

function quoteIdent(dbType: DbType | null, name: string): string {
  const q = quoteChar(dbType)
  return q + name.split(q).join(q + q) + q
}

/** Quotes a possibly db-qualified table identifier for the given dialect. */
export function qualifiedTable(dbType: DbType | null, database: string, table: string): string {
  return `${quoteIdent(dbType, database)}.${quoteIdent(dbType, table)}`
}

export interface BrowseOrder {
  column: string
  dir: 'asc' | 'desc'
}

/**
 * SELECT * with a LIMIT/OFFSET page for browsing a table's rows, optionally sorted by the
 * database. `tiebreak` (the primary key) keeps pages stable when the sort column has duplicates.
 */
export function buildPageSql(
  dbType: DbType | null,
  database: string,
  table: string,
  page: number,
  pageSize = PAGE_SIZE,
  order: BrowseOrder | null = null,
  tiebreak: string[] = []
): string {
  const t = qualifiedTable(dbType, database, table)
  let orderBy = ''
  if (order) {
    const dir = order.dir === 'desc' ? 'DESC' : 'ASC'
    const cols = [order.column, ...tiebreak.filter((c) => c !== order.column)]
    orderBy = ` ORDER BY ${cols.map((c) => `${quoteIdent(dbType, c)} ${dir}`).join(', ')}`
  }
  return `SELECT * FROM ${t}${orderBy} LIMIT ${pageSize} OFFSET ${page * pageSize}`
}

/** COUNT(*) to know how many pages exist. */
export function buildCountSql(dbType: DbType | null, database: string, table: string): string {
  const t = qualifiedTable(dbType, database, table)
  return `SELECT COUNT(*) AS total FROM ${t}`
}
