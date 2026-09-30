import type {
  ConnectionConfig,
  ConnectResult,
  DatabaseStructure,
  QueryResult,
  ScriptResult,
  SchemaSnapshot,
  TableStructure,
  UpdatePayload
} from '../../shared/types'
import type { Driver } from './driver'
import { MySqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { detectEditable } from './editable'

interface ActiveConnection {
  driver: Driver
  schema: SchemaSnapshot
  config: ConnectionConfig
  password: string | undefined
}

/**
 * Holds live database connections keyed by a per-tab **session id**, so the
 * same saved connection can be opened in multiple tabs (e.g. prod vs dev)
 * without them interfering with each other.
 */
class ConnectionManager {
  private active = new Map<string, ActiveConnection>()

  private createDriver(config: ConnectionConfig, password: string | undefined): Driver {
    return config.type === 'postgres'
      ? new PostgresDriver(config, password)
      : new MySqlDriver(config, password)
  }

  /** Opens (or replaces) a session's connection; returns schema + database list. */
  async connect(
    sessionId: string,
    config: ConnectionConfig,
    password: string | undefined
  ): Promise<ConnectResult> {
    await this.disconnect(sessionId)
    const driver = this.createDriver(config, password)
    await driver.connect()
    const databases = await driver.listDatabases().catch(() => [])
    const currentDatabase = await driver.currentDatabase().catch(() => null)
    const schema = await driver.introspect(currentDatabase ?? undefined)
    this.active.set(sessionId, { driver, schema, config, password })
    return { schema, databases, currentDatabase }
  }

  /** Switches the active database of a session by reconnecting scoped to it. */
  async useDatabase(sessionId: string, database: string | null): Promise<ConnectResult> {
    const conn = this.require(sessionId)
    const nextConfig: ConnectionConfig = { ...conn.config, database: database || undefined }
    return this.connect(sessionId, nextConfig, conn.password)
  }

  /** Tests a connection without keeping it open. */
  async test(config: ConnectionConfig, password: string | undefined): Promise<void> {
    const driver = this.createDriver(config, password)
    try {
      await driver.connect()
    } finally {
      await driver.close()
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const conn = this.active.get(sessionId)
    if (conn) {
      this.active.delete(sessionId)
      await conn.driver.close().catch(() => undefined)
    }
  }

  /** Closes every session that uses a given saved connection (on delete). */
  async disconnectByConnectionId(connectionId: string): Promise<void> {
    const ids = [...this.active.entries()]
      .filter(([, c]) => c.config.id === connectionId)
      .map(([sid]) => sid)
    await Promise.all(ids.map((sid) => this.disconnect(sid)))
  }

  isConnected(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  connectionName(sessionId: string): string | null {
    return this.active.get(sessionId)?.config.name ?? null
  }

  private require(sessionId: string): ActiveConnection {
    const conn = this.active.get(sessionId)
    if (!conn) throw new Error('Connection is not open. Please connect first.')
    return conn
  }

  async introspect(sessionId: string): Promise<SchemaSnapshot> {
    const conn = this.require(sessionId)
    const current = await conn.driver.currentDatabase().catch(() => null)
    conn.schema = await conn.driver.introspect(current ?? undefined)
    return conn.schema
  }

  async query(sessionId: string, sql: string): Promise<QueryResult> {
    const conn = this.require(sessionId)
    const start = Date.now()
    const res = await conn.driver.query(sql)
    const durationMs = Date.now() - start
    const editable =
      res.columns.length > 0
        ? detectEditable(sql, conn.schema, res.columns, res.origins, conn.config.type)
        : null
    return {
      columns: res.columns,
      rows: res.rows,
      rowCount: res.rowCount,
      durationMs,
      affectedRows: res.affectedRows,
      message: res.message,
      editable
    }
  }

  async describeTable(sessionId: string, database: string, table: string): Promise<TableStructure> {
    return this.require(sessionId).driver.describeTable(database, table)
  }

  async update(sessionId: string, payload: UpdatePayload): Promise<number> {
    const conn = this.require(sessionId)
    return conn.driver.update(payload)
  }

  // ---- One-off fetches (used by the schema compare feature) ----

  /** Opens a throwaway connection to list a server's databases. */
  async fetchDatabases(config: ConnectionConfig, password: string | undefined): Promise<string[]> {
    const driver = this.createDriver(config, password)
    await driver.connect()
    try {
      return await driver.listDatabases()
    } finally {
      await driver.close().catch(() => undefined)
    }
  }

  /** Runs `fn` on a throwaway driver bound to `database`, always closing it. */
  private async withDriver<T>(
    config: ConnectionConfig,
    password: string | undefined,
    database: string,
    fn: (driver: Driver) => Promise<T>
  ): Promise<T> {
    const cfg: ConnectionConfig = { ...config, database: database || config.database }
    const driver = this.createDriver(cfg, password)
    await driver.connect()
    try {
      return await fn(driver)
    } finally {
      await driver.close().catch(() => undefined)
    }
  }

  /** Full column + index structure of a database (schema sync). */
  async fetchStructure(
    config: ConnectionConfig,
    password: string | undefined,
    database: string
  ): Promise<DatabaseStructure> {
    const tables = await this.withDriver(config, password, database, (d) =>
      d.describeDatabase(database)
    )
    return { dbType: config.type, database, tables }
  }

  async fetchCreateTables(
    config: ConnectionConfig,
    password: string | undefined,
    database: string,
    tables: string[]
  ): Promise<Record<string, string>> {
    return this.withDriver(config, password, database, (d) => d.showCreateTables(database, tables))
  }

  /** Runs a sync script against a destination database on one session. */
  async applyScript(
    config: ConnectionConfig,
    password: string | undefined,
    database: string,
    statements: string[]
  ): Promise<ScriptResult> {
    return this.withDriver(config, password, database, (d) => d.executeScript(statements))
  }

  async closeAll(): Promise<void> {
    const ids = [...this.active.keys()]
    await Promise.all(ids.map((id) => this.disconnect(id)))
  }
}

export const manager = new ConnectionManager()
