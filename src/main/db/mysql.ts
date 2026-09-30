import mysql from 'mysql2/promise'
import type {
  ConnectionConfig,
  SchemaSnapshot,
  TableInfo,
  ColumnInfo,
  UpdatePayload,
  TableStructure,
  IndexDetail,
  ForeignKeyDetail,
  ScriptResult
} from '../../shared/types'
import { uniqueColumnNames, type Driver, type QueryExecResult } from './driver'

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export class MySqlDriver implements Driver {
  readonly type = 'mysql' as const
  private pool: mysql.Pool | null = null

  constructor(
    private config: ConnectionConfig,
    private password: string | undefined
  ) {}

  async connect(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.password,
      database: this.config.database || undefined,
      ssl: this.config.ssl ? {} : undefined,
      waitForConnections: true,
      connectionLimit: 5,
      // Return DECIMAL/BIGINT as strings to avoid precision loss.
      decimalNumbers: false,
      dateStrings: true
    })
    // Validate immediately so connection errors surface now.
    const conn = await this.pool.getConnection()
    conn.release()
  }

  private ensure(): mysql.Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async query(sql: string): Promise<QueryExecResult> {
    const pool = this.ensure()
    // Arrays, not objects: joins often repeat column names (two `id`s).
    const [result, fields] = await pool.query({ sql, rowsAsArray: true })

    if (Array.isArray(result)) {
      // CALL returns several result sets (fields is then an array of arrays); show the first.
      const nested = Array.isArray(fields) && Array.isArray((fields as unknown[])[0])
      const data = (nested ? (result as unknown[])[0] : result) as unknown[][]
      const flds = ((nested ? (fields as unknown[])[0] : fields) ?? []) as mysql.FieldPacket[]
      const columns = uniqueColumnNames(flds.map((f) => ({ name: f.name, qualifier: f.table })))
      const rows = (Array.isArray(data) ? data : []).map((arr) => {
        const obj: Record<string, unknown> = {}
        columns.forEach((c, i) => (obj[c] = arr[i]))
        return obj
      })
      const origins = flds.map((f) =>
        f.orgTable && f.orgName
          ? {
              schema: f.db ?? '',
              table: f.orgTable,
              column: f.orgName,
              instance: `${f.db ?? ''}.${f.table ?? f.orgTable}`,
              alias: f.table
            }
          : null
      )
      return { columns, rows, rowCount: rows.length, origins }
    }

    const info = result as mysql.ResultSetHeader
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: info.affectedRows,
      message: `OK — ${info.affectedRows} row(s) affected` + (info.info ? ` (${info.info})` : '')
    }
  }

  async listDatabases(): Promise<string[]> {
    const pool = this.ensure()
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`
    )
    return rows
      .map((r) => String(r.name))
      .filter((n) => !SYSTEM_SCHEMAS.has(n.toLowerCase()))
  }

  async currentDatabase(): Promise<string | null> {
    const pool = this.ensure()
    const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT DATABASE() AS db`)
    const db = rows[0]?.db
    return db ? String(db) : null
  }

  async describeTable(database: string, table: string): Promise<TableStructure> {
    const [t] = await this.loadStructures(database, table)
    return t ?? { database, table, columns: [], indexes: [] }
  }

  async describeDatabase(database: string): Promise<TableStructure[]> {
    return this.loadStructures(database)
  }

  /** Columns + indexes for one table, or every base table of `database`. */
  private async loadStructures(database: string, table?: string): Promise<TableStructure[]> {
    const pool = this.ensure()
    const maria = await this.isMariaDb()
    const tableFilter = table ? 'AND c.TABLE_NAME = ?' : ''
    const params = table ? [database, table] : [database]
    const [cols] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT c.TABLE_NAME AS tbl, c.COLUMN_NAME AS name, c.COLUMN_TYPE AS type,
              c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS def, c.COLUMN_KEY AS ckey,
              c.EXTRA AS extra, c.COLUMN_COMMENT AS cmt
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = ? ${tableFilter} AND t.TABLE_TYPE = 'BASE TABLE'
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      params
    )
    const [idx] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT c.TABLE_NAME AS tbl, c.INDEX_NAME AS name, c.COLUMN_NAME AS col,
              c.NON_UNIQUE AS nonUnique, c.INDEX_TYPE AS type, c.SUB_PART AS subPart
       FROM information_schema.STATISTICS c
       WHERE c.TABLE_SCHEMA = ? ${tableFilter}
       ORDER BY c.TABLE_NAME, c.INDEX_NAME, c.SEQ_IN_INDEX`,
      params
    )

    const tables = new Map<string, TableStructure>()
    const get = (name: string): TableStructure => {
      let t = tables.get(name)
      if (!t) {
        t = { database, table: name, columns: [], indexes: [] }
        tables.set(name, t)
      }
      return t
    }

    for (const r of cols) {
      get(String(r.tbl)).columns.push({
        name: String(r.name),
        type: String(r.type),
        nullable: String(r.nullable).toUpperCase() === 'YES',
        default: normalizeDefault(r.def, maria),
        isPrimaryKey: String(r.ckey).toUpperCase() === 'PRI',
        extra: String(r.extra ?? ''),
        comment: r.cmt ? String(r.cmt) : null
      })
    }

    const indexMaps = new Map<string, Map<string, IndexDetail>>()
    for (const r of idx) {
      const tbl = String(r.tbl)
      if (!tables.has(tbl)) continue // views / filtered out
      let map = indexMaps.get(tbl)
      if (!map) indexMaps.set(tbl, (map = new Map()))
      const name = String(r.name)
      let entry = map.get(name)
      if (!entry) {
        entry = {
          name,
          columns: [],
          unique: Number(r.nonUnique) === 0,
          primary: name === 'PRIMARY',
          type: String(r.type ?? ''),
          subParts: []
        }
        map.set(name, entry)
      }
      entry.columns.push(String(r.col))
      entry.subParts!.push(r.subPart === null || r.subPart === undefined ? null : Number(r.subPart))
    }
    for (const [tbl, map] of indexMaps) get(tbl).indexes = [...map.values()]

    const [fks] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
              k.REFERENCED_TABLE_SCHEMA AS refSchema, k.REFERENCED_TABLE_NAME AS refTable,
              k.REFERENCED_COLUMN_NAME AS refCol, r.UPDATE_RULE AS upd, r.DELETE_RULE AS del
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? ${table ? 'AND k.TABLE_NAME = ?' : ''}
         AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      params
    )
    const fkMaps = new Map<string, Map<string, ForeignKeyDetail>>()
    for (const r of fks) {
      const tbl = String(r.tbl)
      if (!tables.has(tbl)) continue
      let map = fkMaps.get(tbl)
      if (!map) fkMaps.set(tbl, (map = new Map()))
      const name = String(r.name)
      let fk = map.get(name)
      if (!fk) {
        fk = {
          name,
          columns: [],
          refSchema: String(r.refSchema),
          refTable: String(r.refTable),
          refColumns: [],
          onUpdate: String(r.upd),
          onDelete: String(r.del)
        }
        map.set(name, fk)
      }
      fk.columns.push(String(r.col))
      fk.refColumns.push(String(r.refCol))
    }
    for (const t of tables.values()) t.foreignKeys = [...(fkMaps.get(t.table)?.values() ?? [])]

    return [...tables.values()]
  }

  private mariaDb: boolean | null = null

  private async isMariaDb(): Promise<boolean> {
    if (this.mariaDb === null) {
      const [rows] = await this.ensure().query<mysql.RowDataPacket[]>('SELECT VERSION() AS v')
      this.mariaDb = /mariadb/i.test(String(rows[0]?.v ?? ''))
    }
    return this.mariaDb
  }

  async showCreateTables(database: string, tables: string[]): Promise<Record<string, string>> {
    const pool = this.ensure()
    const out: Record<string, string> = {}
    for (const t of tables) {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SHOW CREATE TABLE ${quoteIdent(database)}.${quoteIdent(t)}`
      )
      const ddl = rows[0]?.['Create Table']
      if (ddl) out[t] = String(ddl)
    }
    return out
  }

  async executeScript(statements: string[]): Promise<ScriptResult> {
    const conn = await this.ensure().getConnection()
    let executed = 0
    try {
      for (let i = 0; i < statements.length; i++) {
        try {
          await conn.query(statements[i])
          executed++
        } catch (err) {
          return {
            total: statements.length,
            executed,
            rolledBack: false,
            error: { index: i, message: err instanceof Error ? err.message : String(err) }
          }
        }
      }
      return { total: statements.length, executed, rolledBack: false }
    } finally {
      conn.release()
    }
  }

  async introspect(scopeDb?: string): Promise<SchemaSnapshot> {
    const pool = this.ensure()
    const where = scopeDb ? `WHERE c.TABLE_SCHEMA = ?` : ``
    const params = scopeDb ? [scopeDb] : []
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT c.TABLE_SCHEMA AS db, c.TABLE_NAME AS tbl, c.COLUMN_NAME AS col,
              c.DATA_TYPE AS dtype, c.IS_NULLABLE AS nullable, c.COLUMN_KEY AS ckey
       FROM information_schema.COLUMNS c
       ${where}
       ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
      params
    )
    return buildSnapshot(
      rows.map((r) => ({
        db: String(r.db),
        tbl: String(r.tbl),
        col: String(r.col),
        dtype: String(r.dtype),
        nullable: String(r.nullable).toUpperCase() === 'YES',
        isPk: String(r.ckey).toUpperCase() === 'PRI'
      })),
      SYSTEM_SCHEMAS
    )
  }

  async update(payload: UpdatePayload): Promise<number> {
    const pool = this.ensure()
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      let updated = 0
      for (const target of payload.targets) {
        const table = target.database
          ? `${quoteIdent(target.database)}.${quoteIdent(target.table)}`
          : quoteIdent(target.table)
        const whereSql = target.primaryKey.map((k) => `${quoteIdent(k)} <=> ?`).join(' AND ')
        for (const change of target.changes) {
          const [res] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE ${table} SET ${quoteIdent(change.column)} = ? WHERE ${whereSql}`,
            [change.value, ...target.primaryKey.map((k) => change.pk[k])]
          )
          // A primary key matches at most one row; anything else means the key is wrong.
          if (res.affectedRows > 1) {
            throw new Error(`Update on ${target.table} matched ${res.affectedRows} rows — rolled back`)
          }
          updated += res.affectedRows
        }
      }
      await conn.commit()
      return updated
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }
}

/**
 * MariaDB 10.2.7+ reports defaults as SQL literals (`'abc'`, `NULL`,
 * `current_timestamp()`); MySQL reports the raw value. Normalize to MySQL's form.
 */
function normalizeDefault(def: unknown, maria: boolean): string | null {
  if (def === null || def === undefined) return null
  const v = String(def)
  if (!maria) return v
  if (v === 'NULL') return null
  const quoted = v.match(/^'(.*)'$/s)
  if (quoted) return quoted[1].replace(/''/g, "'")
  return v
}

interface FlatCol {
  db: string
  tbl: string
  col: string
  dtype: string
  nullable: boolean
  isPk: boolean
}

export function buildSnapshot(flat: FlatCol[], systemSchemas: Set<string>): SchemaSnapshot {
  const tableMap = new Map<string, TableInfo>()
  const databases = new Set<string>()

  for (const r of flat) {
    if (systemSchemas.has(r.db.toLowerCase())) continue
    databases.add(r.db)
    const key = `${r.db} ${r.tbl}`
    let t = tableMap.get(key)
    if (!t) {
      t = { database: r.db, name: r.tbl, columns: [] }
      tableMap.set(key, t)
    }
    const col: ColumnInfo = {
      name: r.col,
      dataType: r.dtype,
      nullable: r.nullable,
      isPrimaryKey: r.isPk
    }
    t.columns.push(col)
  }

  return {
    databases: [...databases].sort(),
    tables: [...tableMap.values()].sort((a, b) =>
      a.database === b.database ? a.name.localeCompare(b.name) : a.database.localeCompare(b.database)
    )
  }
}
