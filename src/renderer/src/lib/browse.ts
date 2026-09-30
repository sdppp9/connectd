import type { DbType } from '../../../shared/types'

export const PAGE_SIZE = 100

function quoteChar(dbType: DbType | null): string {
  return dbType === 'postgres' ? '"' : '`'
}

/** Quotes a possibly db-qualified table identifier for the given dialect. */
export function qualifiedTable(dbType: DbType | null, database: string, table: string): string {
  const q = quoteChar(dbType)
  const qi = (s: string): string => q + s.split(q).join(q + q) + q
  return `${qi(database)}.${qi(table)}`
}

/** SELECT * with a LIMIT/OFFSET page for browsing a table's rows. */
export function buildPageSql(
  dbType: DbType | null,
  database: string,
  table: string,
  page: number,
  pageSize = PAGE_SIZE
): string {
  const t = qualifiedTable(dbType, database, table)
  return `SELECT * FROM ${t} LIMIT ${pageSize} OFFSET ${page * pageSize}`
}

/** COUNT(*) to know how many pages exist. */
export function buildCountSql(dbType: DbType | null, database: string, table: string): string {
  const t = qualifiedTable(dbType, database, table)
  return `SELECT COUNT(*) AS total FROM ${t}`
}
