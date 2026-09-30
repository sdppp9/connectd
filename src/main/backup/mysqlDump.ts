import mysql from 'mysql2/promise'
import type { ConnectionConfig, JobProgress } from '../../shared/types'
import { checkCancelled, type DumpWriter, type Job } from './writer'

const BINARY_TYPES = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring',
  'multipolygon', 'geometrycollection', 'geomcollection'
])
const NUMERIC_TYPES = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal',
  'numeric', 'float', 'double', 'real', 'year'
])

/** Max size of one multi-row INSERT (stays well under max_allowed_packet). */
const INSERT_BYTES = 1024 * 1024

const q = (name: string): string => '`' + name.replace(/`/g, '``') + '`'

/** DEFINER=`user`@`host` would fail on servers without that account. */
function stripDefiner(sql: string): string {
  return sql.replace(/\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|[^\s@]+)@(`[^`]*`|'[^']*'|\S+)/i, '')
}

export function mysqlOptions(
  config: ConnectionConfig,
  password: string | undefined,
  database?: string
): mysql.ConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password,
    database: database || undefined,
    ssl: config.ssl ? {} : undefined,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  }
}

type Progress = (p: Omit<JobProgress, 'jobId'>) => void

/**
 * Writes a restorable .sql dump of one MySQL database: tables (+ data),
 * routines, views and triggers — read inside one consistent snapshot.
 */
export async function dumpMySql(
  config: ConnectionConfig,
  password: string | undefined,
  database: string,
  w: DumpWriter,
  includeData: boolean,
  job: Job,
  progress: Progress
): Promise<{ tables: number; rows: number }> {
  const conn = await mysql.createConnection(mysqlOptions(config, password, database))
  let totalRows = 0
  try {
    await conn.query("SET SESSION time_zone = '+00:00'")
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')

    const [[ver]] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v')
    const [tableRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database]
    )
    const tables = tableRows.filter((r) => r.type === 'BASE TABLE').map((r) => String(r.name))
    const views = tableRows.filter((r) => r.type === 'VIEW').map((r) => String(r.name))

    await w.write(
      [
        '-- ConnectD backup',
        '-- Engine: mysql',
        `-- Database: ${database}`,
        `-- Server: ${ver.v}`,
        `-- Created: ${new Date().toISOString()}`,
        `-- Contents: ${includeData ? 'structure + data' : 'structure only'}`,
        '',
        'SET NAMES utf8mb4;',
        "SET TIME_ZONE = '+00:00';",
        'SET FOREIGN_KEY_CHECKS = 0;',
        'SET UNIQUE_CHECKS = 0;',
        "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
        '',
        ''
      ].join('\n')
    )

    // ---- Tables ----
    for (let i = 0; i < tables.length; i++) {
      checkCancelled(job)
      const t = tables[i]
      progress({ phase: includeData ? 'data' : 'schema', table: t, tablesDone: i, tablesTotal: tables.length, rows: totalRows, bytes: w.bytes })

      const [[create]] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE ${q(t)}`)
      await w.write(`--\n-- Table ${q(t)}\n--\n\nDROP TABLE IF EXISTS ${q(t)};\n${create['Create Table']};\n\n`)
      if (!includeData) continue

      const [cols] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, EXTRA AS extra FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, t]
      )
      // Generated columns are recomputed by the server and cannot be inserted.
      const dataCols = cols.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(String(c.extra)))
      if (dataCols.length === 0) continue
      const binary = new Set(dataCols.filter((c) => BINARY_TYPES.has(String(c.type).toLowerCase())).map((c) => String(c.name)))
      const numeric = dataCols.map((c) => NUMERIC_TYPES.has(String(c.type).toLowerCase()))
      const head = `INSERT INTO ${q(t)} (${dataCols.map((c) => q(String(c.name))).join(', ')}) VALUES\n`

      const core = (conn as unknown as { connection: { query: (o: object) => { stream: () => AsyncIterable<unknown[]> } } }).connection
      const stream = core
        .query({
          sql: `SELECT ${dataCols.map((c) => q(String(c.name))).join(', ')} FROM ${q(t)}`,
          rowsAsArray: true,
          // Everything as text (in the connection's utf8mb4) or raw bytes for binary columns.
          typeCast: (field: { name: string; string: (enc?: string) => string | null; buffer: () => Buffer | null }) =>
            binary.has(field.name) ? field.buffer() : field.string('utf8')
        })
        .stream()

      let batch: string[] = []
      let batchBytes = 0
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return
        await w.write(head + batch.join(',\n') + ';\n')
        batch = []
        batchBytes = 0
      }
      let tableRowsCount = 0
      for await (const row of stream) {
        const values = (row as unknown[]).map((v, idx) => {
          if (v === null || v === undefined) return 'NULL'
          if (Buffer.isBuffer(v)) return v.length ? '0x' + v.toString('hex') : "X''"
          return numeric[idx] ? String(v) : mysql.escape(String(v))
        })
        const tuple = `(${values.join(',')})`
        batch.push(tuple)
        batchBytes += tuple.length
        tableRowsCount++
        if (batchBytes >= INSERT_BYTES) {
          await flush()
          checkCancelled(job)
          progress({ phase: 'data', table: t, tablesDone: i, tablesTotal: tables.length, rows: totalRows + tableRowsCount, bytes: w.bytes })
        }
      }
      await flush()
      totalRows += tableRowsCount
      if (tableRowsCount > 0) await w.write('\n')
    }

    progress({ phase: 'objects', tablesDone: tables.length, tablesTotal: tables.length, rows: totalRows, bytes: w.bytes })

    // ---- Routines (before views, which may call functions) ----
    const [routines] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [database]
    )
    for (const r of routines) {
      checkCancelled(job)
      const kind = String(r.type) === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE'
      const [[def]] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE ${kind} ${q(String(r.name))}`)
      const body = def?.[kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure']
      if (!body) {
        await w.write(`-- Skipped ${kind.toLowerCase()} ${q(String(r.name))}: no privilege to read its definition\n\n`)
        continue
      }
      await w.write(
        `DROP ${kind} IF EXISTS ${q(String(r.name))};\nDELIMITER ;;\n${stripDefiner(String(body))};;\nDELIMITER ;\n\n`
      )
    }

    // ---- Views, ordered so a view is created after the views it selects from ----
    const viewDefs = new Map<string, string>()
    for (const v of views) {
      const [[def]] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE VIEW ${q(v)}`)
      viewDefs.set(v, stripDefiner(String(def['Create View'])))
    }
    const ordered: string[] = []
    const seen = new Set<string>()
    const visit = (v: string, stack: Set<string>): void => {
      if (seen.has(v) || stack.has(v)) return
      stack.add(v)
      const def = viewDefs.get(v) ?? ''
      for (const other of views) if (other !== v && def.includes(q(other))) visit(other, stack)
      stack.delete(v)
      seen.add(v)
      ordered.push(v)
    }
    for (const v of views) visit(v, new Set())
    for (const v of ordered) {
      await w.write(`DROP VIEW IF EXISTS ${q(v)};\n${viewDefs.get(v)};\n\n`)
    }

    // ---- Triggers (after data, so they did not fire during the INSERTs) ----
    const [triggers] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER`,
      [database]
    )
    for (const tr of triggers) {
      checkCancelled(job)
      const [[def]] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE TRIGGER ${q(String(tr.name))}`)
      const body = def?.['SQL Original Statement']
      if (!body) continue
      await w.write(
        `DROP TRIGGER IF EXISTS ${q(String(tr.name))};\nDELIMITER ;;\n${stripDefiner(String(body))};;\nDELIMITER ;\n\n`
      )
    }

    await w.write('SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n-- End of backup\n')
    await conn.query('COMMIT')
    return { tables: tables.length, rows: totalRows }
  } finally {
    conn.destroy()
  }
}
