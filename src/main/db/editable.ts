import type { DbType, EditableMeta, EditableTable, SchemaSnapshot, TableInfo } from '../../shared/types'
import type { ColumnOrigin } from './driver'

/**
 * Decides which result columns can be edited inline and where each one is stored.
 *
 * Uses the column origins reported by the server (base table + column of every
 * result column), so joins work: each source table whose full primary key is in
 * the result becomes editable, while expressions, aggregates and tables without
 * their key stay read-only. Set operations (UNION …) are never editable because
 * their rows can come from different tables than the reported origin.
 */
export function detectEditable(
  sql: string,
  schema: SchemaSnapshot,
  resultColumns: string[],
  origins: (ColumnOrigin | null)[] | undefined,
  dbType: DbType
): EditableMeta | null {
  const code = stripStrings(stripComments(sql)).trim().toLowerCase()
  if (!/^\(?\s*(select|with)\b/.test(code)) return null
  if (/\b(union|intersect|except)\b/.test(code)) return null

  if (origins && origins.some(Boolean)) {
    return fromOrigins(schema, resultColumns, origins, dbType)
  }
  return fromSqlText(sql, schema, resultColumns)
}

interface Instance {
  schema: string
  table: string
  alias?: string
  /** Real column → first result column showing it. */
  byColumn: Map<string, string>
  /** Every result column that comes from this table reference. */
  resultColumns: { result: string; column: string }[]
  /** The same real column appears twice. */
  repeated: boolean
}

function fromOrigins(
  schema: SchemaSnapshot,
  resultColumns: string[],
  origins: (ColumnOrigin | null)[],
  dbType: DbType
): EditableMeta | null {
  const instances = new Map<string, Instance>()
  origins.forEach((o, i) => {
    if (!o) return
    let inst = instances.get(o.instance)
    if (!inst) {
      inst = { schema: o.schema, table: o.table, alias: o.alias, byColumn: new Map(), resultColumns: [], repeated: false }
      instances.set(o.instance, inst)
    }
    if (inst.byColumn.has(o.column)) inst.repeated = true
    else inst.byColumn.set(o.column, resultColumns[i])
    inst.resultColumns.push({ result: resultColumns[i], column: o.column })
  })

  const tables: EditableTable[] = []
  const columns: EditableMeta['columns'] = {}
  for (const inst of instances.values()) {
    // PostgreSQL can't tell two references to the same table apart (self-join),
    // so a repeated column there means we can't know which key belongs to which row.
    if (inst.repeated && dbType === 'postgres') continue
    const info = findTable(schema, inst.schema, inst.table)
    if (!info) continue
    const pk = info.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
    if (pk.length === 0 || !pk.every((k) => inst.byColumn.has(k))) continue

    const index = tables.length
    tables.push({
      database: info.database,
      table: info.name,
      label: inst.alias && inst.alias !== info.name ? `${inst.alias} (${info.name})` : info.name,
      primaryKey: pk,
      pkColumns: pk.map((k) => inst.byColumn.get(k)!)
    })
    for (const rc of inst.resultColumns) columns[rc.result] = { table: index, column: rc.column }
  }
  return tables.length ? { tables, columns } : null
}

function findTable(schema: SchemaSnapshot, db: string, table: string): TableInfo | null {
  const matches = schema.tables.filter(
    (t) => eqIdent(t.name, table) && (!db || eqIdent(t.database, db))
  )
  return matches.length === 1 ? matches[0] : null
}

/**
 * Fallback when the driver reports no origins: a plain single-table SELECT whose
 * primary key is in the result. Only real columns of that table are editable.
 */
function fromSqlText(sql: string, schema: SchemaSnapshot, resultColumns: string[]): EditableMeta | null {
  const cleaned = stripComments(sql).trim().replace(/;\s*$/, '')
  const lower = cleaned.toLowerCase()
  if (/\bjoin\b|\bgroup\s+by\b|\(\s*select\b/.test(lower)) return null

  const fromMatch = lower.match(/\bfrom\b\s+([\s\S]+?)(\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b|\boffset\b|$)/)
  if (!fromMatch) return null
  const fromStart = fromMatch.index! + fromMatch[0].indexOf(fromMatch[1])
  const fromRaw = cleaned.slice(fromStart, fromStart + fromMatch[1].length).trim()
  if (fromRaw.includes(',')) return null

  const parts = (fromRaw.split(/\s+/)[0] ?? '').split('.').map(unquote)
  const info = findTable(schema, parts.length > 1 ? parts[parts.length - 2] : '', parts[parts.length - 1])
  if (!info) return null
  const pk = info.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const resultFor = (name: string): string | undefined =>
    resultColumns.find((r) => r.toLowerCase() === name.toLowerCase())
  if (pk.length === 0 || !pk.every((k) => resultFor(k))) return null

  const columns: EditableMeta['columns'] = {}
  for (const c of info.columns) {
    const r = resultFor(c.name)
    if (r) columns[r] = { table: 0, column: c.name }
  }
  return {
    tables: [
      { database: info.database, table: info.name, label: info.name, primaryKey: pk, pkColumns: pk.map((k) => resultFor(k)!) }
    ],
    columns
  }
}

function unquote(s: string): string {
  return s.replace(/^["`\[]/, '').replace(/["`\]]$/, '')
}

function eqIdent(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** Blanks out string literals so keywords inside them (e.g. 'union') are ignored. */
function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
}
