import type { SchemaSnapshot } from '../../../shared/types'

/** A nested namespace understood by @codemirror/lang-sql's `schema` option. */
export type CmSchema = Record<string, Record<string, string[]> | string[]>

/**
 * Converts our schema snapshot into the nested shape expected by
 * @codemirror/lang-sql: `{ db: { table: [columns] }, table: [columns] }`.
 *
 * - Nesting by database enables qualified completion (`db.` → tables,
 *   `db.table.` → columns).
 * - The flat `table → columns` entries enable bare completion (`table.` →
 *   columns) which is what you want once a single database is selected.
 */
export function buildCmSchema(snapshot: SchemaSnapshot | null): CmSchema {
  const schema: CmSchema = {}
  if (!snapshot) return schema
  for (const table of snapshot.tables) {
    const cols = table.columns.map((c) => c.name)
    const dbGroup = (schema[table.database] as Record<string, string[]>) ?? {}
    dbGroup[table.name] = cols
    schema[table.database] = dbGroup
    // Flat entry for unqualified `table.column` completion.
    schema[table.name] = cols
  }
  return schema
}

/**
 * Picks the schema/database that should complete at the top level (so table
 * names and their columns suggest without a qualifier).
 */
export function pickDefaultSchema(
  snapshot: SchemaSnapshot | null,
  currentDatabase: string | null
): string | undefined {
  if (!snapshot) return undefined
  const dbs = snapshot.databases
  if (currentDatabase && dbs.includes(currentDatabase)) return currentDatabase
  if (dbs.length === 1) return dbs[0]
  if (dbs.includes('public')) return 'public'
  return undefined
}
