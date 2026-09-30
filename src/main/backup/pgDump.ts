import pg from 'pg'
import type { ConnectionConfig, JobProgress } from '../../shared/types'
import { checkCancelled, type DumpWriter, type Job } from './writer'

const INSERT_BYTES = 1024 * 1024
const FETCH_ROWS = 1000

const qi = (s: string): string => '"' + s.replace(/"/g, '""') + '"'
const qn = (schema: string, name: string): string => `${qi(schema)}.${qi(name)}`
const lit = (s: string): string => "'" + s.replace(/'/g, "''") + "'"

/** Keeps every value as the server's text representation. */
const RAW_TEXT = { getTypeParser: () => (v: string) => v }

const USER_NS = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg\\_%'`
const notExtension = (catalog: string, alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend xd WHERE xd.classid = '${catalog}'::regclass AND xd.objid = ${alias}.oid AND xd.deptype = 'e')`

export function pgOptions(
  config: ConnectionConfig,
  password: string | undefined,
  database?: string
): pg.ClientConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password,
    database: database || config.database || undefined,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined
  }
}

type Progress = (p: Omit<JobProgress, 'jobId'>) => void

interface TableRow {
  oid: number
  sch: string
  name: string
  relkind: string
  is_part: boolean
  bound: string | null
  parent_oid: number | null
  partkey: string | null
  cmt: string | null
}

interface ColRow {
  rel: number
  name: string
  type: string
  notnull: boolean
  def: string | null
  ident: string
  gen: string
  coll: string | null
  cmt: string | null
}

/**
 * Writes a restorable .sql dump of one PostgreSQL database (all user schemas):
 * extensions, enums, sequences, functions, tables + data, constraints, indexes,
 * views, triggers and comments. Everything is read in one REPEATABLE READ
 * snapshot with an empty search_path, so every name in the output is qualified.
 */
export async function dumpPostgres(
  config: ConnectionConfig,
  password: string | undefined,
  database: string,
  w: DumpWriter,
  includeData: boolean,
  job: Job,
  progress: Progress
): Promise<{ tables: number; rows: number }> {
  const client = new pg.Client(pgOptions(config, password, database))
  await client.connect()
  let totalRows = 0
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SELECT pg_catalog.set_config('search_path', '', true)")
    const { rows: [info] } = await client.query(
      `SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS ver`
    )
    const v = Number(info.num)
    if (v < 100000) throw new Error('Backup needs PostgreSQL 10 or newer')

    const one = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await client.query(sql, params)).rows as T[]

    const schemas = await one<{ nspname: string }>(
      `SELECT n.nspname FROM pg_namespace n WHERE ${USER_NS} AND ${notExtension('pg_namespace', 'n')} ORDER BY 1`
    )
    const extensions = await one<{ extname: string; nspname: string }>(
      `SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname <> 'plpgsql' ORDER BY e.oid`
    )
    const enums = await one<{ sch: string; name: string; labels: string[] }>(
      `SELECT n.nspname AS sch, t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE ${USER_NS} AND ${notExtension('pg_type', 't')}
       GROUP BY n.nspname, t.typname ORDER BY 1, 2`
    )
    const sequences = await one<{
      oid: number; sch: string; name: string; type: string; start_value: string; min_value: string
      max_value: string; increment_by: string; cycle: boolean; cache_size: string; last_value: string | null
      identity: boolean; own_sch: string | null; own_tbl: string | null; own_col: string | null
    }>(
      `SELECT c.oid, s.schemaname AS sch, s.sequencename AS name, s.data_type::text AS type,
              s.start_value, s.min_value, s.max_value, s.increment_by, s.cycle, s.cache_size, s.last_value,
              EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                      AND d.deptype = 'i') AS identity,
              o.own_sch, o.own_tbl, o.own_col
       FROM pg_sequences s
       JOIN pg_namespace n ON n.nspname = s.schemaname
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
       LEFT JOIN LATERAL (
         SELECT tn.nspname AS own_sch, tc.relname AS own_tbl, a.attname AS own_col
         FROM pg_depend d
         JOIN pg_class tc ON tc.oid = d.refobjid
         JOIN pg_namespace tn ON tn.oid = tc.relnamespace
         JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
         WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a' AND d.refobjsubid > 0
         LIMIT 1) o ON true
       WHERE ${USER_NS} AND ${notExtension('pg_class', 'c')}
       ORDER BY 2, 3`
    )
    const kindCol = v >= 110000 ? 'p.prokind::text' : `'f'`
    const kindFilter = v >= 110000 ? `p.prokind IN ('f','p')` : 'NOT p.proisagg AND NOT p.proiswindow'
    const functions = await one<{ oid: number; sch: string; name: string; args: string; def: string; kind: string; late: boolean }>(
      `SELECT p.oid, n.nspname AS sch, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_functiondef(p.oid) AS def, ${kindCol} AS kind,
              EXISTS (SELECT 1 FROM pg_depend d JOIN pg_type t ON t.oid = d.refobjid
                      LEFT JOIN pg_type el ON el.oid = t.typelem
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.refclassid = 'pg_type'::regclass
                        AND (t.typrelid <> 0 OR coalesce(el.typrelid, 0) <> 0)) AS late
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${USER_NS} AND ${kindFilter} AND ${notExtension('pg_proc', 'p')}
       ORDER BY p.oid`
    )
    const tables = await one<TableRow>(
      `SELECT c.oid, n.nspname AS sch, c.relname AS name, c.relkind::text AS relkind, c.relispartition AS is_part,
              CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS bound,
              (SELECT i.inhparent::int FROM pg_inherits i WHERE i.inhrelid = c.oid AND c.relispartition LIMIT 1) AS parent_oid,
              CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey,
              obj_description(c.oid, 'pg_class') AS cmt
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') AND ${USER_NS} AND ${notExtension('pg_class', 'c')}
       ORDER BY 2, 3`
    )
    const views = await one<{ oid: number; sch: string; name: string; kind: string; def: string; cmt: string | null }>(
      `SELECT c.oid, n.nspname AS sch, c.relname AS name, c.relkind::text AS kind, pg_get_viewdef(c.oid) AS def,
              obj_description(c.oid, 'pg_class') AS cmt
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('v','m') AND ${USER_NS} AND ${notExtension('pg_class', 'c')}
       ORDER BY c.oid`
    )

    const tableOids = tables.map((t) => t.oid)
    const viewOids = views.map((x) => x.oid)
    const relOids = [...tableOids, ...viewOids]
    const genCol = v >= 120000 ? 'a.attgenerated::text' : `''`
    const cols = await one<ColRow>(
      `SELECT a.attrelid::int AS rel, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity::text AS ident,
              ${genCol} AS gen,
              CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN
                (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                 FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation)
              END AS coll,
              col_description(a.attrelid, a.attnum) AS cmt
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attrelid, a.attnum`,
      [relOids]
    )
    const constraintFilter = v >= 110000 ? 'AND con.conparentid = 0' : ''
    const constraints = await one<{ rel: number; name: string; type: string; def: string }>(
      `SELECT con.conrelid::int AS rel, con.conname AS name, con.contype::text AS type,
              pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p','u','c','x','f')
         AND con.conislocal ${constraintFilter}
       ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'f' THEN 2 ELSE 1 END, con.conrelid, con.conname`,
      [tableOids]
    )
    const indexes = await one<{ rel: number; def: string }>(
      `SELECT i.indrelid::int AS rel, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       WHERE i.indrelid = ANY($1::oid[])
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.contype IN ('p','u','x'))
         AND NOT EXISTS (SELECT 1 FROM pg_inherits ih WHERE ih.inhrelid = i.indexrelid)
       ORDER BY i.indrelid, i.indexrelid`,
      [relOids]
    )
    const viewDeps = await one<{ view: number; dep: number }>(
      `SELECT DISTINCT r.ev_class::int AS view, d.refobjid::int AS dep
       FROM pg_rewrite r JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
       WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid <> r.ev_class AND r.ev_class = ANY($1::oid[])`,
      [viewOids]
    )
    const triggerFilter = v >= 130000 ? 'AND t.tgparentid = 0' : ''
    const triggers = await one<{ def: string }>(
      `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
       WHERE t.tgrelid = ANY($1::oid[]) AND NOT t.tgisinternal ${triggerFilter}
       ORDER BY t.tgrelid, t.tgname`,
      [relOids]
    )

    const colsByRel = new Map<number, ColRow[]>()
    for (const c of cols) {
      const arr = colsByRel.get(c.rel) ?? []
      arr.push(c)
      colsByRel.set(c.rel, arr)
    }
    const nameOf = new Map<number, string>()
    for (const t of tables) nameOf.set(t.oid, qn(t.sch, t.name))
    for (const x of views) nameOf.set(x.oid, qn(x.sch, x.name))

    // ---- Header ----
    const out: string[] = [
      '-- ConnectD backup',
      '-- Engine: postgres',
      `-- Database: ${database}`,
      `-- Server: ${info.ver}`,
      `-- Created: ${new Date().toISOString()}`,
      `-- Contents: ${includeData ? 'structure + data' : 'structure only'}`,
      '',
      'SET statement_timeout = 0;',
      'SET lock_timeout = 0;',
      "SET client_encoding = 'UTF8';",
      'SET standard_conforming_strings = on;',
      'SET check_function_bodies = false;',
      'SET client_min_messages = warning;',
      "SELECT pg_catalog.set_config('search_path', '', false);",
      ''
    ]

    // Clean existing objects with the same names (like pg_dump --clean --if-exists).
    for (const x of [...views].reverse()) {
      out.push(`DROP ${x.kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} IF EXISTS ${qn(x.sch, x.name)} CASCADE;`)
    }
    for (const t of tables) if (!t.is_part) out.push(`DROP TABLE IF EXISTS ${qn(t.sch, t.name)} CASCADE;`)
    for (const s of sequences) if (!s.identity) out.push(`DROP SEQUENCE IF EXISTS ${qn(s.sch, s.name)} CASCADE;`)
    for (const e of enums) out.push(`DROP TYPE IF EXISTS ${qn(e.sch, e.name)} CASCADE;`)
    out.push('')

    for (const s of schemas) out.push(`CREATE SCHEMA IF NOT EXISTS ${qi(s.nspname)};`)
    for (const e of extensions) out.push(`CREATE EXTENSION IF NOT EXISTS ${qi(e.extname)} WITH SCHEMA ${qi(e.nspname)};`)
    for (const e of enums) {
      out.push(`CREATE TYPE ${qn(e.sch, e.name)} AS ENUM (${e.labels.map(lit).join(', ')});`)
    }
    for (const s of sequences) {
      if (s.identity) continue
      out.push(
        `CREATE SEQUENCE ${qn(s.sch, s.name)} AS ${s.type} INCREMENT BY ${s.increment_by} ` +
          `MINVALUE ${s.min_value} MAXVALUE ${s.max_value} START WITH ${s.start_value} CACHE ${s.cache_size}` +
          `${s.cycle ? ' CYCLE' : ''};`
      )
    }
    out.push('')
    const writeFunctions = (late: boolean): void => {
      for (const f of functions) if (f.late === late) out.push(`${f.def.trim()};`, '')
    }
    writeFunctions(false)

    // ---- Tables (partition parents before their partitions) ----
    const emitted = new Set<number>()
    const orderedTables: TableRow[] = []
    let remaining = [...tables]
    while (remaining.length) {
      const ready = remaining.filter((t) => !t.parent_oid || emitted.has(t.parent_oid) || !nameOf.has(t.parent_oid))
      const batch = ready.length ? ready : remaining // break cycles defensively
      for (const t of batch) {
        emitted.add(t.oid)
        orderedTables.push(t)
      }
      remaining = remaining.filter((t) => !emitted.has(t.oid))
    }

    for (const t of orderedTables) {
      const name = qn(t.sch, t.name)
      if (t.is_part && t.parent_oid && nameOf.has(t.parent_oid)) {
        // A partition can itself be partitioned (sub-partitioning).
        out.push(
          `CREATE TABLE ${name} PARTITION OF ${nameOf.get(t.parent_oid)} ${t.bound}` +
            `${t.partkey ? ` PARTITION BY ${t.partkey}` : ''};`
        )
      } else {
        const defs = (colsByRel.get(t.oid) ?? []).map((c) => {
          let s = `    ${qi(c.name)} ${c.type}`
          if (c.coll) s += ` COLLATE ${c.coll}`
          if (c.gen === 's' && c.def) s += ` GENERATED ALWAYS AS (${c.def}) STORED`
          else if (c.ident === 'a') s += ' GENERATED ALWAYS AS IDENTITY'
          else if (c.ident === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY'
          else if (c.def) s += ` DEFAULT ${c.def}`
          if (c.notnull) s += ' NOT NULL'
          return s
        })
        out.push(`CREATE TABLE ${name} (\n${defs.join(',\n')}\n)${t.partkey ? ` PARTITION BY ${t.partkey}` : ''};`)
      }
    }
    out.push('')
    writeFunctions(true)
    await w.write(out.join('\n') + '\n')

    // ---- Data ----
    const dataTables = orderedTables.filter((t) => t.relkind === 'r')
    for (let i = 0; i < dataTables.length; i++) {
      const t = dataTables[i]
      checkCancelled(job)
      progress({ phase: includeData ? 'data' : 'schema', table: `${t.sch}.${t.name}`, tablesDone: i, tablesTotal: dataTables.length, rows: totalRows, bytes: w.bytes })
      if (!includeData) continue
      const dataCols = (colsByRel.get(t.oid) ?? []).filter((c) => c.gen !== 's')
      if (dataCols.length === 0) continue
      const name = qn(t.sch, t.name)
      const overriding = dataCols.some((c) => c.ident === 'a') ? ' OVERRIDING SYSTEM VALUE' : ''
      const head = `INSERT INTO ${name} (${dataCols.map((c) => qi(c.name)).join(', ')})${overriding} VALUES\n`

      await client.query(
        `DECLARE connectd_dump NO SCROLL CURSOR FOR SELECT ${dataCols.map((c) => qi(c.name)).join(', ')} FROM ONLY ${name}`
      )
      let batch: string[] = []
      let batchBytes = 0
      let count = 0
      for (;;) {
        const res = await client.query({ text: `FETCH FORWARD ${FETCH_ROWS} FROM connectd_dump`, rowMode: 'array', types: RAW_TEXT })
        if (res.rows.length === 0) break
        for (const row of res.rows as (string | null)[][]) {
          const tuple = '(' + row.map((x) => (x === null ? 'NULL' : lit(x))).join(',') + ')'
          batch.push(tuple)
          batchBytes += tuple.length
          if (batchBytes >= INSERT_BYTES) {
            await w.write(head + batch.join(',\n') + ';\n')
            batch = []
            batchBytes = 0
          }
        }
        count += res.rows.length
        checkCancelled(job)
        progress({ phase: 'data', table: `${t.sch}.${t.name}`, tablesDone: i, tablesTotal: dataTables.length, rows: totalRows + count, bytes: w.bytes })
      }
      await client.query('CLOSE connectd_dump')
      if (batch.length) await w.write(head + batch.join(',\n') + ';\n')
      if (count) await w.write('\n')
      totalRows += count
    }

    progress({ phase: 'objects', tablesDone: dataTables.length, tablesTotal: dataTables.length, rows: totalRows, bytes: w.bytes })

    // ---- Sequence positions & ownership ----
    const post: string[] = ['']
    for (const s of sequences) {
      if (s.last_value !== null) {
        post.push(`SELECT pg_catalog.setval(${lit(qn(s.sch, s.name))}, ${s.last_value}, true);`)
      }
    }
    for (const s of sequences) {
      if (!s.identity && s.own_tbl && s.own_col && s.own_sch) {
        post.push(`ALTER SEQUENCE ${qn(s.sch, s.name)} OWNED BY ${qn(s.own_sch, s.own_tbl)}.${qi(s.own_col)};`)
      }
    }

    // ---- Constraints (PK/unique/check first, foreign keys last) and indexes ----
    const tableSet = new Set(tableOids)
    for (const c of constraints.filter((x) => x.type !== 'f')) {
      post.push(`ALTER TABLE ${nameOf.get(c.rel)} ADD CONSTRAINT ${qi(c.name)} ${c.def};`)
    }
    for (const ix of indexes) if (tableSet.has(ix.rel)) post.push(`${ix.def};`)
    for (const c of constraints.filter((x) => x.type === 'f')) {
      post.push(`ALTER TABLE ${nameOf.get(c.rel)} ADD CONSTRAINT ${qi(c.name)} ${c.def};`)
    }

    // ---- Views in dependency order ----
    const viewSet = new Set(viewOids)
    const depsOf = new Map<number, number[]>()
    for (const d of viewDeps) if (viewSet.has(d.dep)) depsOf.set(d.view, [...(depsOf.get(d.view) ?? []), d.dep])
    const done = new Set<number>()
    const viewById = new Map(views.map((x) => [x.oid, x]))
    const visit = (id: number, stack: Set<number>): void => {
      if (done.has(id) || stack.has(id)) return
      stack.add(id)
      for (const dep of depsOf.get(id) ?? []) visit(dep, stack)
      stack.delete(id)
      done.add(id)
      const x = viewById.get(id)!
      const body = x.def.trim().replace(/;\s*$/, '')
      post.push(
        x.kind === 'm'
          ? `CREATE MATERIALIZED VIEW ${qn(x.sch, x.name)} AS\n${body}\nWITH ${includeData ? '' : 'NO '}DATA;`
          : `CREATE VIEW ${qn(x.sch, x.name)} AS\n${body};`
      )
    }
    for (const x of views) visit(x.oid, new Set())
    for (const ix of indexes) if (!tableSet.has(ix.rel)) post.push(`${ix.def};`)
    for (const tr of triggers) post.push(`${tr.def};`)

    // ---- Comments ----
    for (const t of tables) if (t.cmt) post.push(`COMMENT ON TABLE ${qn(t.sch, t.name)} IS ${lit(t.cmt)};`)
    for (const x of views) {
      if (x.cmt) post.push(`COMMENT ON ${x.kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${qn(x.sch, x.name)} IS ${lit(x.cmt)};`)
    }
    for (const c of cols) {
      if (c.cmt && nameOf.has(c.rel)) post.push(`COMMENT ON COLUMN ${nameOf.get(c.rel)}.${qi(c.name)} IS ${lit(c.cmt)};`)
    }

    post.push('', '-- End of backup', '')
    await w.write(post.join('\n'))
    await client.query('COMMIT')
    return { tables: tables.length, rows: totalRows }
  } finally {
    await client.end().catch(() => undefined)
  }
}
