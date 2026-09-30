import { app } from 'electron'
import { createReadStream, mkdirSync, promises as fsp } from 'fs'
import { join } from 'path'
import { pipeline, Transform, type Readable } from 'stream'
import { createGunzip } from 'zlib'
import mysql from 'mysql2/promise'
import pg from 'pg'
import type {
  BackupFileInfo,
  BackupResult,
  ConnectionConfig,
  JobProgress,
  RestoreError,
  RestoreOptions,
  RestoreResult
} from '../../shared/types'
import { dumpMySql, mysqlOptions } from './mysqlDump'
import { dumpPostgres, pgOptions } from './pgDump'
import { SqlSplitter } from './splitter'
import { CancelledError, checkCancelled, DumpWriter, throttle, type Job } from './writer'

export { CancelledError, type Job } from './writer'

type Progress = (p: Omit<JobProgress, 'jobId'>) => void

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

const safeName = (s: string): string => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'db'

function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function backupFolder(): string {
  const dir = join(app.getPath('documents'), 'ConnectD Backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function defaultBackupPath(connectionName: string, database: string, compress: boolean): string {
  return join(backupFolder(), `${safeName(connectionName)}_${safeName(database)}_${stamp()}.sql${compress ? '.gz' : ''}`)
}

export async function runBackup(
  config: ConnectionConfig,
  password: string | undefined,
  database: string,
  filePath: string,
  includeData: boolean,
  job: Job,
  onProgress: Progress
): Promise<BackupResult> {
  const started = Date.now()
  const w = new DumpWriter(filePath, filePath.toLowerCase().endsWith('.gz'))
  const progress = throttle(onProgress)
  try {
    const dump = config.type === 'postgres' ? dumpPostgres : dumpMySql
    const { tables, rows } = await dump(config, password, database, w, includeData, job, progress)
    await w.close()
    progress.flush()
    return { filePath, tables, rows, bytes: w.bytes, durationMs: Date.now() - started }
  } catch (err) {
    await w.abort() // never leave a half-written backup behind
    throw err
  }
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

async function isGzip(filePath: string): Promise<boolean> {
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(2)
    await fh.read(buf, 0, 2, 0)
    return buf[0] === 0x1f && buf[1] === 0x8b
  } finally {
    await fh.close()
  }
}

/**
 * Opens a dump as text. `latin1` maps every byte to one char, so a statement can be
 * turned back into its exact original bytes (MySQL dumps may hold raw binary data).
 */
function openText(
  filePath: string,
  gz: boolean,
  onBytes?: (n: number) => void,
  encoding: BufferEncoding = 'utf8'
): Readable {
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onBytes?.(chunk.length)
      cb(null, chunk)
    }
  })
  const last = gz ? createGunzip() : new Transform({ transform: (c, _e, cb) => cb(null, c) })
  pipeline(createReadStream(filePath), counter, last, () => undefined)
  last.setEncoding(encoding)
  return last
}

/** The statement without leading whitespace and comments (MySQL `/*! … *\/` is kept). */
function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--') || s.startsWith('#')) {
      const nl = s.indexOf('\n')
      if (nl < 0) return ''
      s = s.slice(nl + 1)
    } else if (s.startsWith('/*') && !s.startsWith('/*!')) {
      const end = s.indexOf('*/')
      if (end < 0) return ''
      s = s.slice(end + 2)
    } else {
      return s
    }
  }
}

export async function inspectBackup(filePath: string): Promise<BackupFileInfo> {
  const { size } = await fsp.stat(filePath)
  const compressed = await isGzip(filePath)
  let head = ''
  const stream = openText(filePath, compressed)
  try {
    for await (const chunk of stream) {
      head += chunk
      if (head.length >= 16 * 1024) break
    }
  } catch {
    // Unreadable / truncated gzip — reported as unknown below.
  } finally {
    stream.destroy()
  }
  const field = (name: string): string | null => head.match(new RegExp(`^-- ${name}: (.+)$`, 'm'))?.[1].trim() ?? null

  if (/^-- ConnectD backup/m.test(head)) {
    const engine = field('Engine')
    return {
      filePath, size, compressed,
      engine: engine === 'postgres' || engine === 'mysql' ? engine : null,
      database: field('Database'),
      createdAt: field('Created'),
      source: 'connectd'
    }
  }
  if (/-- (MySQL|MariaDB) dump/i.test(head)) {
    return {
      filePath, size, compressed, engine: 'mysql',
      database: head.match(/Database: (\S+)/)?.[1] ?? null,
      createdAt: null, source: 'mysqldump'
    }
  }
  if (/-- PostgreSQL database dump/i.test(head)) {
    return { filePath, size, compressed, engine: 'postgres', database: null, createdAt: null, source: 'pg_dump' }
  }
  return { filePath, size, compressed, engine: null, database: null, createdAt: null, source: 'unknown' }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

interface Executor {
  run(sql: string): Promise<void>
  close(ok: boolean): Promise<boolean>
}

/**
 * Creates the target database. Refuses if it already exists, so "restore into a new
 * database" can never silently overwrite an existing one.
 */
async function createDatabase(config: ConnectionConfig, password: string | undefined, database: string): Promise<void> {
  const exists = (): Error => new Error(`Database "${database}" already exists — pick it from the list to restore over it`)
  if (config.type === 'postgres') {
    const client = new pg.Client(pgOptions(config, password, config.database || 'postgres'))
    await client.connect()
    try {
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
      if (rowCount) throw exists()
      await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    } finally {
      await client.end().catch(() => undefined)
    }
    return
  }
  const conn = await mysql.createConnection(mysqlOptions(config, password))
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database]
    )
    if (rows.length) throw exists()
    await conn.query(`CREATE DATABASE \`${database.replace(/`/g, '``')}\` DEFAULT CHARACTER SET utf8mb4`)
  } finally {
    conn.destroy()
  }
}

async function openExecutor(
  config: ConnectionConfig,
  password: string | undefined,
  database: string,
  opts: RestoreOptions
): Promise<Executor> {
  if (config.type === 'postgres') {
    const client = new pg.Client(pgOptions(config, password, database))
    await client.connect()
    const tx = opts.singleTransaction
    if (tx) await client.query('BEGIN')
    return {
      async run(sql) {
        // Inside a transaction, a savepoint lets one failing statement be skipped.
        if (!(tx && opts.continueOnError)) {
          await client.query(sql)
          return
        }
        await client.query('SAVEPOINT connectd_sp')
        try {
          await client.query(sql)
          await client.query('RELEASE SAVEPOINT connectd_sp')
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT connectd_sp')
          throw err
        }
      },
      async close(ok) {
        let rolledBack = false
        try {
          if (tx) {
            await client.query(ok ? 'COMMIT' : 'ROLLBACK')
            rolledBack = !ok
          }
        } finally {
          await client.end().catch(() => undefined)
        }
        return rolledBack
      }
    }
  }
  // With the handshake charset set to binary, mysql2 sends each latin1-decoded
  // statement back as its original bytes; SET NAMES tells the server how to read them
  // (and the dump's own SET NAMES can still change that). Session tracking is off so
  // mysql2 doesn't follow those SET NAMES and start re-encoding statements as UTF-8.
  const conn = await mysql.createConnection({
    ...mysqlOptions(config, password, database),
    charset: 'BINARY',
    flags: ['-SESSION_TRACK']
  })
  await conn.query('SET NAMES utf8mb4')
  return {
    async run(sql) {
      await conn.query(sql)
    },
    async close() {
      conn.destroy()
      return false
    }
  }
}

/** Statements that would redirect the restore away from the chosen database. */
function shouldSkip(dbType: ConnectionConfig['type'], sql: string): boolean {
  // mysqldump --databases adds these; in MySQL "SCHEMA" is a synonym for "DATABASE".
  if (dbType === 'mysql' && /^(CREATE\s+(DATABASE|SCHEMA)|USE)\b/i.test(sql)) return true
  if (dbType === 'postgres' && /^CREATE\s+DATABASE\s/i.test(sql)) return true
  return false
}

export async function runRestore(
  config: ConnectionConfig,
  password: string | undefined,
  database: string,
  filePath: string,
  opts: RestoreOptions,
  job: Job,
  onProgress: Progress
): Promise<RestoreResult> {
  const started = Date.now()
  const { size } = await fsp.stat(filePath)
  const gz = await isGzip(filePath)
  const progress = throttle(onProgress)
  if (opts.createDatabase) await createDatabase(config, password, database)

  const exec = await openExecutor(config, password, database, opts)
  const splitter = new SqlSplitter(config.type)
  const errors: RestoreError[] = []
  let bytes = 0
  let statements = 0
  let skipped = 0
  let failed = false
  let cancelled = false

  // MySQL statements are byte strings (latin1) and the binary-charset connection also
  // returns its error messages that way; decode both as UTF-8 for display.
  const display = (text: string): string => {
    if (config.type !== 'mysql' || /[^\x00-\xff]/.test(text)) return text
    const utf8 = Buffer.from(text, 'latin1').toString('utf8')
    return utf8.includes('�') ? text : utf8
  }

  const runOne = async (sql: string): Promise<void> => {
    checkCancelled(job)
    const head = stripLeadingComments(sql.length > 8192 ? sql.slice(0, 8192) : sql)
    if (shouldSkip(config.type, head)) {
      skipped++
      return
    }
    if (config.type === 'postgres' && /^COPY\s[\s\S]*\sFROM\s+stdin/i.test(head)) {
      throw new Error(
        'This file uses COPY … FROM stdin (pg_dump default format), which needs psql. ' +
          'Create the dump with `pg_dump --inserts` or with ConnectD Backup.'
      )
    }
    const index = statements++
    try {
      await exec.run(sql)
    } catch (err) {
      const shown = display(sql.length > 400 ? sql.slice(0, 400) : sql)
      const e: RestoreError = {
        index,
        message: display(err instanceof Error ? err.message : String(err)),
        sql: sql.length > 400 ? shown + '…' : shown
      }
      if (!opts.continueOnError) {
        errors.push(e)
        failed = true
        throw e
      }
      if (errors.length < 100) errors.push(e)
    }
    progress({ phase: 'restore', bytes, totalBytes: size, statements })
  }

  const stream = openText(filePath, gz, (n) => (bytes += n), config.type === 'mysql' ? 'latin1' : 'utf8')
  try {
    for await (const chunk of stream) {
      for (const sql of splitter.push(chunk as string)) await runOne(sql)
    }
    for (const sql of splitter.end()) await runOne(sql)
  } catch (err) {
    if (err instanceof CancelledError) cancelled = true
    else if (!failed) {
      failed = true
      errors.push({ index: statements, message: err instanceof Error ? err.message : String(err), sql: '' })
    }
  } finally {
    stream.destroy()
  }

  const rolledBack = await exec.close(!failed && !cancelled).catch(() => false)
  progress.flush()
  return {
    statements,
    skipped: skipped + splitter.skippedDirectives,
    errors,
    failed,
    cancelled,
    rolledBack,
    durationMs: Date.now() - started
  }
}
