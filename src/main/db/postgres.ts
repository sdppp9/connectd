import pg from 'pg'
import type {
  ConnectionConfig,
  ForeignKeyDetail,
  IndexDetail,
  SchemaSnapshot,
  ScriptResult,
  TableStructure,
  UpdatePayload
} from '../../shared/types'
import { uniqueColumnNames, type ColumnOrigin, type Driver, type QueryExecResult } from './driver'
import { buildSnapshot } from './mysql'

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema'])

// Return numeric/bigint types as strings to preserve precision.
pg.types.setTypeParser(20, (v) => v) // int8/bigint
pg.types.setTypeParser(1700, (v) => v) // numeric

const PG_FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export class PostgresDriver implements Driver {
  readonly type = 'postgres' as const
  private pool: pg.Pool | null = null

  constructor(
    private config: ConnectionConfig,
    private password: string | undefined
  ) {}

  async connect(): Promise<void> {
    this.pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.password,
      database: this.config.database || undefined,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5
    })
    const client = await this.pool.connect()
    client.release()
  }

  private ensure(): pg.Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async query(sql: string): Promise<QueryExecResult> {
    const pool = this.ensure()
    const res = (await pool.query({ text: sql, rowMode: 'array' })) as pg.QueryArrayResult
    const results: pg.QueryArrayResult[] = Array.isArray(res) ? res : [res]
    // For multi-statement queries pg returns an array; use the last result.
    const last = results[results.length - 1]

    const command = (last.command || '').toUpperCase()

    if (command === 'SELECT' || (last.fields && last.fields.length > 0 && last.rows.length > 0)) {
      const fields = last.fields ?? []
      const tables = await this.relations(fields.map((f) => f.tableID).filter((id) => id > 0))
      const origins: (ColumnOrigin | null)[] = fields.map((f) => {
        const rel = tables.get(f.tableID)
        const column = rel?.columns.get(f.columnID)
        return rel && column
          ? { schema: rel.schema, table: rel.table, column, instance: String(f.tableID) }
          : null
      })
      // Arrays, not objects: joins often repeat column names (two `id`s).
      const columns = uniqueColumnNames(
        fields.map((f) => ({ name: f.name, qualifier: tables.get(f.tableID)?.table }))
      )
      const rows = (last.rows as unknown[][]).map((arr) => {
        const obj: Record<string, unknown> = {}
        columns.forEach((c: string, i: number) => (obj[c] = arr[i]))
        return obj
      })
      return { columns, rows, rowCount: rows.length, origins }
    }

    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: last.rowCount ?? 0,
      message: `OK — ${command || 'command'} ${last.rowCount ?? 0} row(s)`
    }
  }

  /** Table oid → names, cached per connection (cleared on introspect). */
  private relCache = new Map<number, { schema: string; table: string; columns: Map<number, string> }>()

  /** Resolves result-column origins (tableID / columnID) to schema, table and column names. */
  private async relations(
    oids: number[]
  ): Promise<Map<number, { schema: string; table: string; columns: Map<number, string> }>> {
    const missing = [...new Set(oids)].filter((id) => !this.relCache.has(id))
    if (missing.length) {
      const res = await this.ensure().query(
        `SELECT c.oid::int AS oid, n.nspname AS sch, c.relname AS tbl, a.attnum::int AS num, a.attname AS col
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE c.oid = ANY($1::oid[])`,
        [missing]
      )
      for (const r of res.rows) {
        let rel = this.relCache.get(r.oid)
        if (!rel) this.relCache.set(r.oid, (rel = { schema: r.sch, table: r.tbl, columns: new Map() }))
        rel.columns.set(r.num, r.col)
      }
    }
    return this.relCache
  }

  async listDatabases(): Promise<string[]> {
    const pool = this.ensure()
    const res = await pool.query(
      `SELECT datname FROM pg_database
       WHERE datistemplate = false AND datallowconn = true
       ORDER BY datname`
    )
    return res.rows.map((r) => String(r.datname))
  }

  async currentDatabase(): Promise<string | null> {
    const pool = this.ensure()
    const res = await pool.query(`SELECT current_database() AS db`)
    const db = res.rows[0]?.db
    return db ? String(db) : null
  }

  // For PostgreSQL, `database` here is the schema (e.g. `public`).
  async describeTable(database: string, table: string): Promise<TableStructure> {
    const [t] = await this.loadStructures(database, table)
    return t ?? { database, table, columns: [], indexes: [] }
  }

  // `database` is ignored: the pool is already bound to one database, and
  // every user schema in it is included (TableStructure.database = schema).
  async describeDatabase(_database: string): Promise<TableStructure[]> {
    return this.loadStructures()
  }

  /** Columns + indexes of one table, or of every base table in user schemas. */
  private async loadStructures(schema?: string, table?: string): Promise<TableStructure[]> {
    const pool = this.ensure()
    const filter = schema
      ? `n.nspname = $1 AND c.relname = $2`
      : `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'`
    const params = schema ? [schema, table] : []
    const [cols, idx, fks] = await Promise.all([
      pool.query(
        `SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS def,
                EXISTS (SELECT 1 FROM pg_index i
                        WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
                CASE a.attidentity WHEN 'a' THEN 'identity always'
                                   WHEN 'd' THEN 'identity by default' ELSE '' END AS extra,
                col_description(c.oid, a.attnum) AS cmt
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE ${filter} AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY n.nspname, c.relname, a.attnum`,
        params
      ),
      pool.query(
        `SELECT n.nspname AS sch, c.relname AS tbl, ic.relname AS name,
                ix.indisunique AS uniq, ix.indisprimary AS prim, am.amname AS type,
                pg_get_indexdef(ix.indexrelid) AS def,
                ARRAY(SELECT a.attname::text FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                      ORDER BY k.ord) AS cols
         FROM pg_index ix
         JOIN pg_class c ON c.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = ix.indexrelid
         JOIN pg_am am ON am.oid = ic.relam
         WHERE ${filter} AND c.relkind IN ('r','p')
         ORDER BY n.nspname, c.relname, ic.relname`,
        params
      ),
      pool.query(
        `SELECT n.nspname AS sch, c.relname AS tbl, con.conname AS name,
                rn.nspname AS ref_sch, rc.relname AS ref_tbl,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                      ORDER BY k.ord) AS cols,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                      ORDER BY k.ord) AS ref_cols,
                con.confupdtype::text AS upd, con.confdeltype::text AS del,
                con.condeferrable AS deferrable, con.condeferred AS deferred
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE con.contype = 'f' AND ${filter}
         ORDER BY n.nspname, c.relname, con.conname`,
        params
      )
    ])

    const tables = new Map<string, TableStructure>()
    const get = (sch: string, tbl: string): TableStructure => {
      const key = `${sch}.${tbl}`
      let t = tables.get(key)
      if (!t) {
        t = { database: sch, table: tbl, columns: [], indexes: [] }
        tables.set(key, t)
      }
      return t
    }

    for (const r of cols.rows) {
      get(String(r.sch), String(r.tbl)).columns.push({
        name: String(r.name),
        type: String(r.type),
        nullable: Boolean(r.nullable),
        default: r.def === null || r.def === undefined ? null : String(r.def),
        isPrimaryKey: Boolean(r.pk),
        extra: String(r.extra ?? ''),
        comment: r.cmt ? String(r.cmt) : null
      })
    }
    for (const r of idx.rows) {
      const idxDetail: IndexDetail = {
        name: String(r.name),
        columns: (r.cols as string[]) ?? [],
        unique: Boolean(r.uniq),
        primary: Boolean(r.prim),
        type: String(r.type ?? ''),
        definition: String(r.def)
      }
      get(String(r.sch), String(r.tbl)).indexes.push(idxDetail)
    }

    for (const t of tables.values()) t.foreignKeys = []
    for (const r of fks.rows) {
      const t = tables.get(`${r.sch}.${r.tbl}`)
      if (!t) continue
      const fk: ForeignKeyDetail = {
        name: String(r.name),
        columns: (r.cols as string[]) ?? [],
        refSchema: String(r.ref_sch),
        refTable: String(r.ref_tbl),
        refColumns: (r.ref_cols as string[]) ?? [],
        onUpdate: PG_FK_ACTIONS[String(r.upd)] ?? 'NO ACTION',
        onDelete: PG_FK_ACTIONS[String(r.del)] ?? 'NO ACTION',
        deferrable: r.deferrable
          ? r.deferred
            ? 'DEFERRABLE INITIALLY DEFERRED'
            : 'DEFERRABLE'
          : ''
      }
      t.foreignKeys!.push(fk)
    }

    return [...tables.values()]
  }

  async showCreateTables(): Promise<Record<string, string>> {
    return {}
  }

  /** PostgreSQL DDL is transactional: the whole script commits or rolls back. */
  async executeScript(statements: string[]): Promise<ScriptResult> {
    const client = await this.ensure().connect()
    let executed = 0
    try {
      await client.query('BEGIN')
      for (let i = 0; i < statements.length; i++) {
        try {
          await client.query(statements[i])
          executed++
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined)
          return {
            total: statements.length,
            executed: 0,
            rolledBack: true,
            error: { index: i, message: err instanceof Error ? err.message : String(err) }
          }
        }
      }
      await client.query('COMMIT')
      return { total: statements.length, executed, rolledBack: false }
    } finally {
      client.release()
    }
  }

  // scopeDb is unused for PostgreSQL: switching database requires a reconnect,
  // so the connection is already scoped to a single database here.
  async introspect(_scopeDb?: string): Promise<SchemaSnapshot> {
    const pool = this.ensure()
    this.relCache.clear()
    const [cols, pks] = await Promise.all([
      pool.query(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
         FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_schema, table_name, ordinal_position`
      ),
      pool.query(
        `SELECT tc.table_schema, tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'`
      )
    ])

    const pkSet = new Set(
      pks.rows.map((r) => `${r.table_schema} ${r.table_name} ${r.column_name}`)
    )

    return buildSnapshot(
      cols.rows.map((r) => ({
        db: String(r.table_schema),
        tbl: String(r.table_name),
        col: String(r.column_name),
        dtype: String(r.data_type),
        nullable: String(r.is_nullable).toUpperCase() === 'YES',
        isPk: pkSet.has(`${r.table_schema} ${r.table_name} ${r.column_name}`)
      })),
      SYSTEM_SCHEMAS
    )
  }

  async update(payload: UpdatePayload): Promise<number> {
    const pool = this.ensure()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let updated = 0
      for (const target of payload.targets) {
        const table = target.database
          ? `${quoteIdent(target.database)}.${quoteIdent(target.table)}`
          : quoteIdent(target.table)
        const whereSql = target.primaryKey
          .map((k, i) => `${quoteIdent(k)} IS NOT DISTINCT FROM $${i + 2}`)
          .join(' AND ')
        for (const change of target.changes) {
          const res = await client.query(
            `UPDATE ${table} SET ${quoteIdent(change.column)} = $1 WHERE ${whereSql}`,
            [change.value, ...target.primaryKey.map((k) => change.pk[k])]
          )
          // A primary key matches at most one row; anything else means the key is wrong.
          if ((res.rowCount ?? 0) > 1) {
            throw new Error(`Update on ${target.table} matched ${res.rowCount} rows — rolled back`)
          }
          updated += res.rowCount ?? 0
        }
      }
      await client.query('COMMIT')
      return updated
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }
}
