import { useCallback, useEffect, useState } from 'react'
import {
  X,
  DatabaseBackup,
  ArchiveRestore,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  FolderOpen,
  FileArchive,
  Square,
  ShieldAlert,
  XCircle
} from 'lucide-react'
import type {
  BackupFileInfo,
  BackupResult,
  ConnectionConfig,
  JobProgress,
  RestoreResult
} from '../../../shared/types'
import { Button } from './ui/Button'
import { useToast } from './ui/Toast'
import { formatBytes, formatDuration } from '../lib/format'
import { newJobId, useJobProgress } from '../lib/jobs'

interface Props {
  open: boolean
  connections: ConnectionConfig[]
  /** Pre-selects the active tab's connection / database. */
  defaultConnectionId?: string | null
  defaultDatabase?: string | null
  onClose: () => void
  /** Called after a restore changed a database. */
  onRestored?: (connectionId: string, database: string) => void
}

type Tab = 'backup' | 'restore'

const NEW_DB = '\u0000new'

const selCls =
  'h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200'
const inputCls =
  'h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'

export function BackupDialog({
  open,
  connections,
  defaultConnectionId,
  defaultDatabase,
  onClose,
  onRestored
}: Props): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>('backup')
  const [busy, setBusy] = useState(false)

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
            <DatabaseBackup size={18} className="text-indigo-500" /> Backup &amp; restore
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            title={busy ? 'Cancel the running job first' : 'Close'}
            className="text-slate-400 hover:text-slate-700 disabled:opacity-40 dark:hover:text-slate-200"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-4 border-b border-slate-200 px-5 dark:border-slate-700">
          {(['backup', 'restore'] as Tab[]).map((t) => (
            <button
              key={t}
              disabled={busy}
              onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2.5 text-sm font-medium disabled:opacity-50 ${
                tab === t
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t === 'backup' ? <DatabaseBackup size={14} /> : <ArchiveRestore size={14} />}
              {t === 'backup' ? 'Backup' : 'Restore'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {tab === 'backup' ? (
            <BackupPane
              connections={connections}
              defaultConnectionId={defaultConnectionId}
              defaultDatabase={defaultDatabase}
              onBusy={setBusy}
            />
          ) : (
            <RestorePane connections={connections} onBusy={setBusy} onRestored={onRestored} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connection + database picker
// ---------------------------------------------------------------------------

function useDatabases(connId: string): { dbs: string[]; loading: boolean; reload: () => void } {
  const toast = useToast()
  const [dbs, setDbs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setDbs([])
    if (!connId) return
    setLoading(true)
    window.api.compareDatabases(connId).then((res) => {
      if (!alive) return
      setLoading(false)
      if (res.ok) setDbs(res.data)
      else toast.error(res.error)
    })
    return () => {
      alive = false
    }
  }, [connId, nonce, toast])
  return { dbs, loading, reload: () => setNonce((n) => n + 1) }
}

function ConnectionSelect({
  value,
  connections,
  onChange,
  disabled
}: {
  value: string
  connections: ConnectionConfig[]
  onChange: (id: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <select className={selCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Connection…</option>
      {connections.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type})
        </option>
      ))}
    </select>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function ProgressPanel({
  progress,
  startedAt,
  onCancel,
  cancelling
}: {
  progress: JobProgress | null
  startedAt: number
  onCancel: () => void
  cancelling: boolean
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])

  let pct: number | null = null
  let line = 'Starting…'
  if (progress?.phase === 'restore' && progress.totalBytes) {
    pct = Math.min(100, (progress.bytes / progress.totalBytes) * 100)
    line = `${(progress.statements ?? 0).toLocaleString()} statements · ${formatBytes(progress.bytes)} of ${formatBytes(progress.totalBytes)}`
  } else if (progress) {
    if (progress.tablesTotal) pct = ((progress.tablesDone ?? 0) / progress.tablesTotal) * 100
    const what =
      progress.phase === 'objects'
        ? 'Views, routines, triggers…'
        : progress.table
          ? `${progress.phase === 'schema' ? 'Structure' : 'Data'}: ${progress.table}`
          : 'Reading structure…'
    line = `${what} · table ${Math.min((progress.tablesDone ?? 0) + 1, progress.tablesTotal ?? 0)}/${progress.tablesTotal ?? 0} · ${(progress.rows ?? 0).toLocaleString()} rows · ${formatBytes(progress.bytes)}`
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3">
      <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <Loader2 size={15} className="animate-spin text-indigo-500" />
        <span className="min-w-0 flex-1 truncate" title={line}>
          {line}
        </span>
        <span className="text-xs text-slate-400">{formatDuration(now - startedAt)}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={`h-full rounded-full bg-indigo-500 transition-all ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={cancelling} icon={<Square size={13} />}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function BackupPane({
  connections,
  defaultConnectionId,
  defaultDatabase,
  onBusy
}: {
  connections: ConnectionConfig[]
  defaultConnectionId?: string | null
  defaultDatabase?: string | null
  onBusy: (b: boolean) => void
}): React.JSX.Element {
  const toast = useToast()
  const [connId, setConnId] = useState(defaultConnectionId ?? '')
  const [db, setDb] = useState(defaultDatabase ?? '')
  const { dbs, loading } = useDatabases(connId)
  const [includeData, setIncludeData] = useState(true)
  const [compress, setCompress] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const [result, setResult] = useState<BackupResult | null>(null)
  const progress = useJobProgress(jobId)

  useEffect(() => {
    if (dbs.length && !dbs.includes(db)) {
      const conn = connections.find((c) => c.id === connId)
      setDb([defaultDatabase, conn?.database].find((d) => d && dbs.includes(d)) ?? dbs[0])
    }
  }, [dbs, db, connId, connections, defaultDatabase])

  async function run(): Promise<void> {
    if (!connId || !db) return toast.error('Pick a connection and database')
    const id = newJobId()
    setResult(null)
    setJobId(id)
    setStartedAt(Date.now())
    setCancelling(false)
    onBusy(true)
    const res = await window.api.backupDatabase(id, connId, db, { includeData, compress, target: 'ask' })
    onBusy(false)
    setJobId(null)
    if (!res.ok) {
      if (res.error === 'Cancelled') toast.info('Backup cancelled — partial file removed')
      else toast.error(res.error)
      return
    }
    if (res.data) {
      setResult(res.data)
      toast.success('Backup complete')
    }
  }

  const running = jobId !== null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Field label="Connection">
          <ConnectionSelect value={connId} connections={connections} disabled={running} onChange={(id) => { setConnId(id); setDb('') }} />
        </Field>
        <Field label="Database">
          <select className={selCls} value={db} disabled={running || loading || !dbs.length} onChange={(e) => setDb(e.target.value)}>
            <option value="">{loading ? 'Loading…' : 'Database…'}</option>
            {dbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-col gap-2 text-sm text-slate-600 dark:text-slate-300">
        <div className="flex gap-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" className="accent-indigo-600" checked={includeData} disabled={running} onChange={() => setIncludeData(true)} />
            Structure + data
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" className="accent-indigo-600" checked={!includeData} disabled={running} onChange={() => setIncludeData(false)} />
            Structure only
          </label>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" className="accent-indigo-600" checked={compress} disabled={running} onChange={(e) => setCompress(e.target.checked)} />
          Compress (.sql.gz — usually 5–10× smaller)
        </label>
      </div>

      <p className="text-xs text-slate-400">
        Reads a consistent snapshot (other users can keep working) and writes a plain SQL file with tables, data,
        indexes, foreign keys, views, routines/functions and triggers. The database is only read, never changed.
      </p>

      {running ? (
        <ProgressPanel
          progress={progress}
          startedAt={startedAt}
          cancelling={cancelling}
          onCancel={() => {
            setCancelling(true)
            if (jobId) window.api.cancelJob(jobId)
          }}
        />
      ) : (
        <div className="flex justify-end">
          <Button variant="primary" onClick={run} disabled={!connId || !db} icon={<DatabaseBackup size={15} />}>
            Back up…
          </Button>
        </div>
      )}

      {result && !running && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={16} /> Backup complete
          </div>
          <div className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-300">{result.filePath}</div>
          <div className="mt-1 text-xs text-slate-500">
            {result.tables} tables · {result.rows.toLocaleString()} rows · {formatBytes(result.bytes)} of SQL ·{' '}
            {formatDuration(result.durationMs)}
          </div>
          <Button className="mt-2" onClick={() => window.api.showItemInFolder(result.filePath)} icon={<FolderOpen size={14} />}>
            Show in folder
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<BackupFileInfo['source'], string> = {
  connectd: 'ConnectD backup',
  mysqldump: 'mysqldump file',
  pg_dump: 'pg_dump file',
  unknown: 'SQL file'
}

function RestorePane({
  connections,
  onBusy,
  onRestored
}: {
  connections: ConnectionConfig[]
  onBusy: (b: boolean) => void
  onRestored?: (connectionId: string, database: string) => void
}): React.JSX.Element {
  const toast = useToast()
  const [file, setFile] = useState<BackupFileInfo | null>(null)
  const [connId, setConnId] = useState('')
  const [dbChoice, setDbChoice] = useState(NEW_DB)
  const [newDb, setNewDb] = useState('')
  const { dbs, loading, reload } = useDatabases(connId)
  const [stopOnError, setStopOnError] = useState(true)
  const [singleTx, setSingleTx] = useState(true)
  const [backupFirst, setBackupFirst] = useState(true)
  const [confirmText, setConfirmText] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [stage, setStage] = useState<'backup' | 'restore'>('restore')
  const [startedAt, setStartedAt] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const [result, setResult] = useState<{ res: RestoreResult; target: string } | null>(null)
  const [safetyBackup, setSafetyBackup] = useState<string | null>(null)
  const progress = useJobProgress(jobId)

  const conn = connections.find((c) => c.id === connId)
  const engineMismatch = Boolean(file?.engine && conn && conn.type !== file.engine)
  const isNew = dbChoice === NEW_DB
  const target = (isNew ? newDb : dbChoice).trim()
  const overwriting = !isNew && Boolean(target)
  const nameTaken = isNew && dbs.some((d) => d.toLowerCase() === target.toLowerCase())
  const running = jobId !== null

  const pick = useCallback(async () => {
    const res = await window.api.pickBackupFile()
    if (!res.ok) return toast.error(res.error)
    if (!res.data) return
    setFile(res.data)
    setResult(null)
    setSafetyBackup(null)
    setNewDb(res.data.database ? `${res.data.database}_restore` : '')
    const match = connections.find((c) => !res.data!.engine || c.type === res.data!.engine)
    if (!connId && match) setConnId(match.id)
  }, [toast, connections, connId])

  async function run(): Promise<void> {
    if (!file || !connId || !target) return
    setResult(null)
    setSafetyBackup(null)
    setCancelling(false)
    setStartedAt(Date.now())
    onBusy(true)
    try {
      // Safety copy of the database that is about to be overwritten.
      if (overwriting && backupFirst) {
        const bid = newJobId()
        setStage('backup')
        setJobId(bid)
        const b = await window.api.backupDatabase(bid, connId, target, { includeData: true, compress: true, target: 'auto' })
        if (!b.ok) {
          toast.error(b.error === 'Cancelled' ? 'Cancelled — nothing was restored' : `Safety backup failed, nothing was restored: ${b.error}`)
          return
        }
        setSafetyBackup(b.data?.filePath ?? null)
      }
      const rid = newJobId()
      setStage('restore')
      setJobId(rid)
      setStartedAt(Date.now())
      const res = await window.api.restoreDatabase(rid, connId, target, file.filePath, {
        createDatabase: isNew,
        singleTransaction: conn?.type === 'postgres' && singleTx,
        continueOnError: !stopOnError
      })
      if (!res.ok) return toast.error(res.error)
      setResult({ res: res.data, target })
      setConfirmText('')
      if (isNew) {
        // The new database now exists; running again must go through the overwrite path.
        reload()
        if (!res.data.failed && !res.data.cancelled) setNewDb('')
      }
      if (res.data.cancelled) toast.info('Restore cancelled')
      else if (res.data.failed) toast.error('Restore stopped on an error')
      else {
        toast.success(`Restored into ${target}`)
        onRestored?.(connId, target)
      }
    } finally {
      setJobId(null)
      onBusy(false)
    }
  }

  const canRun =
    !!file && !!connId && !!target && !engineMismatch && !nameTaken && (!overwriting || confirmText === target)

  return (
    <div className="flex flex-col gap-4">
      {/* File */}
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Backup file</div>
        {file ? (
          <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <FileArchive size={20} className="mt-0.5 shrink-0 text-indigo-500" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="break-all font-mono text-xs text-slate-700 dark:text-slate-200">{file.filePath}</div>
              <div className="mt-1 text-xs text-slate-500">
                {SOURCE_LABEL[file.source]}
                {file.engine && ` · ${file.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}`}
                {file.database && ` · from “${file.database}”`}
                {file.createdAt && ` · ${new Date(file.createdAt).toLocaleString()}`}
                {` · ${formatBytes(file.size)}${file.compressed ? ' (gzip)' : ''}`}
              </div>
            </div>
            <Button variant="ghost" onClick={pick} disabled={running}>
              Change
            </Button>
          </div>
        ) : (
          <Button onClick={pick} icon={<FolderOpen size={15} />}>
            Choose .sql / .sql.gz file…
          </Button>
        )}
      </div>

      {file && (
        <>
          <div className="flex gap-3">
            <Field label="Restore into connection">
              <ConnectionSelect value={connId} connections={connections} disabled={running} onChange={(id) => { setConnId(id); setDbChoice(NEW_DB) }} />
            </Field>
            <Field label="Database">
              <select className={selCls} value={dbChoice} disabled={running || !connId || loading} onChange={(e) => { setDbChoice(e.target.value); setConfirmText('') }}>
                <option value={NEW_DB}>+ New database…</option>
                {dbs.map((d) => (
                  <option key={d} value={d}>
                    {d} (existing)
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {isNew && (
            <Field label="New database name">
              <input className={inputCls} value={newDb} disabled={running} onChange={(e) => setNewDb(e.target.value)} placeholder="e.g. shop_restore" />
              {nameTaken && (
                <p className="mt-1 text-xs text-rose-500">
                  “{target}” already exists — choose it from the Database list to restore over it.
                </p>
              )}
            </Field>
          )}

          {engineMismatch && (
            <Notice tone="rose">
              This file is for {file.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}, but the connection is{' '}
              {conn?.type === 'postgres' ? 'PostgreSQL' : 'MySQL'}.
            </Notice>
          )}
          {file.source === 'pg_dump' && (
            <Notice tone="amber">
              pg_dump files work only when made with <code>--inserts</code> (the default COPY format needs psql).
            </Notice>
          )}

          <div className="flex flex-col gap-2 text-sm text-slate-600 dark:text-slate-300">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="accent-indigo-600" checked={stopOnError} disabled={running} onChange={(e) => setStopOnError(e.target.checked)} />
              Stop at the first error (otherwise log errors and keep going)
            </label>
            {conn?.type === 'postgres' && (
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" className="accent-indigo-600" checked={singleTx} disabled={running} onChange={(e) => setSingleTx(e.target.checked)} />
                All or nothing — one transaction, rolled back if anything fails
              </label>
            )}
            {overwriting && (
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" className="accent-indigo-600" checked={backupFirst} disabled={running} onChange={(e) => setBackupFirst(e.target.checked)} />
                Back up <b className="font-mono">{target}</b> first (to Documents\ConnectD Backups)
              </label>
            )}
          </div>

          {overwriting && (
            <Notice tone="rose" icon={<ShieldAlert size={14} className="mt-0.5 shrink-0" />}>
              <b className="font-mono">{target}</b> already exists. Tables, views and routines with the same names as in
              the file are <b>dropped and replaced</b> by the backup&apos;s version; other tables are left alone.
              {conn?.type === 'mysql' && ' MySQL cannot roll back if the restore fails halfway.'}
              <div className="mt-2">
                <label className="mb-1 block text-xs">
                  Type <b className="font-mono">{target}</b> to confirm
                </label>
                <input className={inputCls} value={confirmText} disabled={running} onChange={(e) => setConfirmText(e.target.value)} />
              </div>
            </Notice>
          )}

          {running ? (
            <div>
              <div className="mb-1 text-xs text-slate-400">
                {stage === 'backup' ? `Step 1/2 — safety backup of ${target}` : overwriting && backupFirst ? 'Step 2/2 — restoring' : 'Restoring'}
              </div>
              <ProgressPanel
                progress={progress}
                startedAt={startedAt}
                cancelling={cancelling}
                onCancel={() => {
                  setCancelling(true)
                  if (jobId) window.api.cancelJob(jobId)
                }}
              />
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                variant={overwriting ? 'danger' : 'primary'}
                onClick={run}
                disabled={!canRun}
                icon={<ArchiveRestore size={15} />}
              >
                {overwriting ? `Restore over ${target || '…'}` : `Restore into new database`}
              </Button>
            </div>
          )}

          {safetyBackup && !running && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <CheckCircle2 size={13} className="text-emerald-500" /> Safety backup:
              <button className="truncate font-mono text-indigo-500 hover:underline" onClick={() => window.api.showItemInFolder(safetyBackup)}>
                {safetyBackup}
              </button>
            </div>
          )}

          {result && !running && <RestoreSummary result={result.res} target={result.target} engine={conn?.type} />}
        </>
      )}
    </div>
  )
}

function RestoreSummary({
  result,
  target,
  engine
}: {
  result: RestoreResult
  target: string
  engine?: string
}): React.JSX.Element {
  const ok = !result.failed && !result.cancelled
  const tone = ok ? (result.errors.length ? 'amber' : 'emerald') : 'rose'
  const cls = {
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
  }[tone]
  return (
    <div className={`rounded-lg border p-3 text-sm ${cls}`}>
      <div className="flex items-center gap-2 font-medium">
        {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        {result.cancelled
          ? 'Restore cancelled'
          : result.failed
            ? 'Restore stopped on an error'
            : result.errors.length
              ? `Restored into ${target} with ${result.errors.length} error(s)`
              : `Restored into ${target}`}
      </div>
      <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        {result.statements.toLocaleString()} statements · {formatDuration(result.durationMs)}
        {result.skipped > 0 && ` · ${result.skipped} client directive(s) skipped (USE / CREATE DATABASE / DELIMITER)`}
      </div>
      {(result.failed || result.cancelled) && (
        <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">
          {result.rolledBack
            ? 'Everything was rolled back — the database is unchanged.'
            : engine === 'mysql'
              ? 'Statements before this point were already applied (MySQL cannot roll back DDL).'
              : 'Statements before this point were already applied.'}
        </div>
      )}
      {result.errors.slice(0, 20).map((e) => (
        <div key={e.index} className="mt-2 rounded border border-current/20 bg-white/50 p-2 text-xs text-slate-700 dark:bg-slate-900/40 dark:text-slate-200">
          <div className="font-medium">
            #{e.index + 1}: {e.message}
          </div>
          {e.sql && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">{e.sql}</pre>}
        </div>
      ))}
    </div>
  )
}

function Notice({
  tone,
  icon,
  children
}: {
  tone: 'rose' | 'amber'
  icon?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const cls =
    tone === 'rose'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${cls}`}>
      {icon ?? <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
