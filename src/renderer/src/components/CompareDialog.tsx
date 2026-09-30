import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X,
  GitCompareArrows,
  ArrowLeftRight,
  Loader2,
  CheckCircle2,
  Plus,
  Minus,
  Pencil,
  ChevronRight,
  ChevronDown,
  Search,
  Copy,
  Play,
  AlertTriangle,
  Columns3,
  ListTree,
  KeyRound,
  Link2,
  ShieldAlert,
  FolderOpen,
  DatabaseBackup
} from 'lucide-react'
import type { ConnectionConfig, DatabaseStructure, JobProgress, ScriptResult } from '../../../shared/types'
import { newJobId, useJobProgress } from '../lib/jobs'
import { formatBytes } from '../lib/format'
import { Button } from './ui/Button'
import { useToast } from './ui/Toast'
import {
  buildSyncItems,
  buildSyncScript,
  diffStructures,
  type ColumnDiff,
  type DiffStatus,
  type ForeignKeyDiff,
  type IndexDiff,
  type StructureDiff,
  type SyncItem,
  type TableDiff
} from '../lib/schemaSync'

interface Props {
  open: boolean
  connections: ConnectionConfig[]
  onClose: () => void
}

interface Side {
  connId: string
  db: string
  dbs: string[]
  loadingDbs: boolean
}

const emptySide: Side = { connId: '', db: '', dbs: [], loadingDbs: false }

interface Compared {
  diff: StructureDiff
  items: SyncItem[]
  /** Snapshot of the pickers at compare time (the pickers may change afterwards). */
  source: { connId: string; db: string }
  dest: { connId: string; db: string }
  sameEngine: boolean
}

type View = 'diff' | 'sync'

/** What to back up from the destination before a sync runs. */
type BackupMode = 'full' | 'structure' | 'none'

export function CompareDialog({ open, connections, onClose }: Props): React.JSX.Element | null {
  const toast = useToast()
  const [source, setSource] = useState<Side>(emptySide)
  const [dest, setDest] = useState<Side>(emptySide)
  const [comparing, setComparing] = useState(false)
  const [result, setResult] = useState<Compared | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>('diff')
  const [onlyDiffs, setOnlyDiffs] = useState(true)
  const [search, setSearch] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [applying, setApplying] = useState(false)
  const [lastRun, setLastRun] = useState<ScriptResult | null>(null)
  const [backupMode, setBackupMode] = useState<BackupMode>('full')
  const [backupJob, setBackupJob] = useState<string | null>(null)
  const [lastBackup, setLastBackup] = useState<string | null>(null)
  const backupProgress = useJobProgress(backupJob)

  useEffect(() => {
    if (open) {
      setSource(emptySide)
      setDest(emptySide)
      setResult(null)
      setLastRun(null)
      setSearch('')
      setView('diff')
    }
  }, [open])

  const connName = useCallback(
    (id: string) => connections.find((c) => c.id === id)?.name ?? 'connection',
    [connections]
  )

  const loadDbs = useCallback(
    async (connId: string, setSide: React.Dispatch<React.SetStateAction<Side>>, keepDb?: string) => {
      setSide({ connId, db: '', dbs: [], loadingDbs: true })
      if (!connId) return setSide(emptySide)
      const res = await window.api.compareDatabases(connId)
      if (!res.ok) {
        toast.error(res.error)
        setSide({ connId, db: '', dbs: [], loadingDbs: false })
        return
      }
      const conn = connections.find((c) => c.id === connId)
      const preferred = [keepDb, conn?.database].find((d) => d && res.data.includes(d))
      setSide({ connId, db: preferred ?? res.data[0] ?? '', dbs: res.data, loadingDbs: false })
    },
    [toast, connections]
  )

  function swap(): void {
    setSource(dest)
    setDest(source)
    setResult(null)
    setLastRun(null)
  }

  const runCompare = useCallback(
    async (src: { connId: string; db: string }, dst: { connId: string; db: string }) => {
      setComparing(true)
      const [s, d] = await Promise.all([
        window.api.compareStructure(src.connId, src.db),
        window.api.compareStructure(dst.connId, dst.db)
      ])
      if (!s.ok || !d.ok) {
        setComparing(false)
        toast.error(!s.ok ? `Source: ${s.error}` : `Destination: ${(d as { error: string }).error}`)
        return
      }
      const srcStruct: DatabaseStructure = s.data
      const dstStruct: DatabaseStructure = d.data
      const sameEngine = srcStruct.dbType === dstStruct.dbType
      const diff = diffStructures(srcStruct, dstStruct)

      let createSql: Record<string, string> = {}
      const missing = diff.tables.filter((t) => t.status === 'missing').map((t) => t.name)
      if (sameEngine && srcStruct.dbType === 'mysql' && missing.length > 0) {
        const res = await window.api.compareCreateTables(src.connId, src.db, missing)
        if (res.ok) createSql = res.data
      }
      const items = sameEngine ? buildSyncItems(diff, dst.db, createSql) : []
      setResult({ diff, items, source: src, dest: dst, sameEngine })
      setSelected(new Set(items.filter((i) => !i.destructive).map((i) => i.id)))
      setComparing(false)
    },
    [toast]
  )

  async function handleCompare(): Promise<void> {
    if (!source.connId || !source.db || !dest.connId || !dest.db) {
      toast.error('Pick a connection and database on both sides')
      return
    }
    if (source.connId === dest.connId && source.db === dest.db) {
      toast.error('Source and destination are the same database')
      return
    }
    setLastRun(null)
    await runCompare({ connId: source.connId, db: source.db }, { connId: dest.connId, db: dest.db })
  }

  const chosen = useMemo(
    () => result?.items.filter((i) => selected.has(i.id)) ?? [],
    [result, selected]
  )
  const script = useMemo(
    () => (result ? buildSyncScript(result.diff, result.dest.db, chosen) : []),
    [result, chosen]
  )
  const scriptText = script.map((s) => s + ';').join('\n\n')
  const destructiveCount = chosen.filter((i) => i.destructive).length

  async function handleApply(): Promise<void> {
    if (!result) return
    setApplying(true)
    setLastBackup(null)
    if (backupMode !== 'none') {
      const id = newJobId()
      setBackupJob(id)
      const b = await window.api.backupDatabase(id, result.dest.connId, result.dest.db, {
        includeData: backupMode === 'full',
        compress: true,
        target: 'auto'
      })
      setBackupJob(null)
      if (!b.ok) {
        setApplying(false)
        toast.error(
          b.error === 'Cancelled'
            ? 'Backup cancelled — nothing was changed'
            : `Backup failed — nothing was changed: ${b.error}`
        )
        return
      }
      setLastBackup(b.data?.filePath ?? null)
    }
    const res = await window.api.applySync(result.dest.connId, result.dest.db, script)
    setApplying(false)
    setConfirming(false)
    if (!res.ok) return toast.error(res.error)
    setLastRun(res.data)
    if (res.data.error) {
      toast.error(
        res.data.rolledBack
          ? `Statement ${res.data.error.index + 1} failed — everything was rolled back`
          : `Statement ${res.data.error.index + 1} failed — ${res.data.executed} statement(s) before it were applied`
      )
    } else {
      toast.success(`Sync applied: ${res.data.executed} statement(s)`)
    }
    // Re-compare so the view reflects the destination's new state.
    await runCompare(result.source, result.dest)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
            <GitCompareArrows size={18} className="text-indigo-500" /> Compare &amp; sync schema
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X size={18} />
          </button>
        </div>

        {/* Selectors */}
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div className="flex items-end gap-3">
            <SidePicker
              label="Source (e.g. dev)"
              side={source}
              connections={connections}
              onConn={(id) => loadDbs(id, setSource, source.db)}
              onDb={(db) => setSource((s) => ({ ...s, db }))}
            />
            <button
              onClick={swap}
              title="Swap source and destination"
              className="mb-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700/60 dark:hover:text-slate-100"
            >
              <ArrowLeftRight size={16} />
            </button>
            <SidePicker
              label="Destination (e.g. prod)"
              side={dest}
              connections={connections}
              onConn={(id) => loadDbs(id, setDest, dest.db)}
              onDb={(db) => setDest((s) => ({ ...s, db }))}
            />
            <Button
              variant="primary"
              onClick={handleCompare}
              disabled={comparing || applying}
              className="mb-0.5"
              icon={comparing ? <Loader2 size={15} className="animate-spin" /> : <GitCompareArrows size={15} />}
            >
              Compare
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Sync changes the <b className="text-slate-500 dark:text-slate-300">destination</b> so its structure matches
            the <b className="text-slate-500 dark:text-slate-300">source</b>. The source is never modified.
          </p>
        </div>

        {/* Body */}
        {!result && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-slate-400">
            {comparing ? (
              <>
                <Loader2 size={22} className="animate-spin" />
                <p className="text-sm">Reading table structures…</p>
              </>
            ) : (
              <>
                <GitCompareArrows size={30} className="opacity-40" />
                <p className="text-sm">Choose a source and destination, then click Compare</p>
              </>
            )}
          </div>
        )}

        {result && (
          <>
            <div className="flex items-center gap-3 border-b border-slate-200 px-5 dark:border-slate-700">
              <TabButton active={view === 'diff'} onClick={() => setView('diff')}>
                Differences
              </TabButton>
              <TabButton active={view === 'sync'} onClick={() => setView('sync')}>
                Sync script
                {result.items.length > 0 && (
                  <span className="ml-1.5 rounded bg-indigo-500/15 px-1.5 text-[11px] text-indigo-500">
                    {chosen.length}/{result.items.length}
                  </span>
                )}
              </TabButton>
              <div className="ml-auto flex items-center gap-2 py-2 text-xs">
                {result.diff.identical ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-500">
                    <CheckCircle2 size={14} /> Structures are identical
                  </span>
                ) : (
                  <>
                    <Badge color="emerald" icon={<Plus size={12} />}>
                      {result.diff.counts.missing} missing in destination
                    </Badge>
                    <Badge color="amber" icon={<Pencil size={12} />}>
                      {result.diff.counts.changed} different
                    </Badge>
                    <Badge color="rose" icon={<Minus size={12} />}>
                      {result.diff.counts.extra} only in destination
                    </Badge>
                  </>
                )}
                {comparing && <Loader2 size={14} className="animate-spin text-slate-400" />}
              </div>
            </div>

            {lastBackup && (
              <div className="mx-5 mt-3 flex items-center gap-2 text-xs text-slate-500">
                <DatabaseBackup size={13} className="shrink-0 text-emerald-500" />
                Destination was backed up before the sync:
                <span className="min-w-0 truncate font-mono" title={lastBackup}>
                  {lastBackup}
                </span>
                <button
                  onClick={() => window.api.showItemInFolder(lastBackup)}
                  className="inline-flex shrink-0 items-center gap-1 text-indigo-500 hover:underline"
                >
                  <FolderOpen size={12} /> Show
                </button>
              </div>
            )}

            {lastRun?.error && (
              <div className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <b>Statement {lastRun.error.index + 1} of {lastRun.total} failed:</b> {lastRun.error.message}
                  <div className="mt-0.5 opacity-80">
                    {lastRun.rolledBack
                      ? 'PostgreSQL rolled back the whole script — the destination is unchanged.'
                      : `MySQL cannot roll back DDL — ${lastRun.executed} statement(s) before it were applied. The list below shows what is still left.`}
                  </div>
                </div>
              </div>
            )}

            {view === 'diff' ? (
              <DiffView diff={result.diff} onlyDiffs={onlyDiffs} setOnlyDiffs={setOnlyDiffs} search={search} setSearch={setSearch} />
            ) : (
              <SyncView
                result={result}
                selected={selected}
                setSelected={setSelected}
                scriptText={scriptText}
                statementCount={script.length}
                destructiveCount={destructiveCount}
                destLabel={`${connName(result.dest.connId)} / ${result.dest.db}`}
                applying={applying}
                onApply={() => setConfirming(true)}
              />
            )}
          </>
        )}
      </div>

      {confirming && result && (
        <ConfirmApply
          destConn={connName(result.dest.connId)}
          destDb={result.dest.db}
          statementCount={script.length}
          destructiveCount={destructiveCount}
          engine={result.diff.dbType}
          applying={applying}
          backupMode={backupMode}
          setBackupMode={setBackupMode}
          backupProgress={backingUpProgress(backupJob, backupProgress)}
          onCancelBackup={() => backupJob && window.api.cancelJob(backupJob)}
          onCancel={() => setConfirming(false)}
          onConfirm={handleApply}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Differences view
// ---------------------------------------------------------------------------

function DiffView({
  diff,
  onlyDiffs,
  setOnlyDiffs,
  search,
  setSearch
}: {
  diff: StructureDiff
  onlyDiffs: boolean
  setOnlyDiffs: (v: boolean) => void
  search: string
  setSearch: (v: string) => void
}): React.JSX.Element {
  const q = search.trim().toLowerCase()
  const tables = diff.tables.filter(
    (t) => (!onlyDiffs || t.status !== 'same') && (!q || t.key.toLowerCase().includes(q))
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-5 py-2.5">
        <SearchBox value={search} onChange={setSearch} />
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <input
            type="checkbox"
            checked={onlyDiffs}
            onChange={(e) => setOnlyDiffs(e.target.checked)}
            className="h-3.5 w-3.5 accent-indigo-600"
          />
          Show only differences
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">
        <p className="mb-2 text-[11px] text-slate-400">
          Changes read <span className="font-mono">destination → source</span> (what the destination becomes after sync).
        </p>
        <div className="flex flex-col gap-2">
          {tables.map((t) => (
            <TableRow key={t.key} table={t} onlyDiffs={onlyDiffs} />
          ))}
          {tables.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No differences to show</p>}
        </div>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<DiffStatus, string> = {
  missing: 'missing in destination',
  extra: 'only in destination',
  changed: 'different',
  same: 'identical'
}

function StatusBadge({ status }: { status: DiffStatus }): React.JSX.Element {
  if (status === 'missing') return <Badge color="emerald" icon={<Plus size={11} />}>{STATUS_LABEL[status]}</Badge>
  if (status === 'extra') return <Badge color="rose" icon={<Minus size={11} />}>{STATUS_LABEL[status]}</Badge>
  if (status === 'changed') return <Badge color="amber" icon={<Pencil size={11} />}>{STATUS_LABEL[status]}</Badge>
  return <Badge color="slate">{STATUS_LABEL[status]}</Badge>
}

function TableRow({ table, onlyDiffs }: { table: TableDiff; onlyDiffs: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(table.status === 'changed')
  const cols = onlyDiffs && table.status === 'changed' ? table.columns.filter((c) => c.status !== 'same') : table.columns
  const idx = onlyDiffs && table.status === 'changed' ? table.indexes.filter((i) => i.status !== 'same') : table.indexes
  const fks =
    onlyDiffs && table.status === 'changed'
      ? table.foreignKeys.filter((f) => f.status !== 'same')
      : table.foreignKeys

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-slate-50 px-3 py-2 text-left text-sm dark:bg-slate-800/50"
      >
        {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        <span className="font-medium text-slate-700 dark:text-slate-200">{table.key}</span>
        <StatusBadge status={table.status} />
        <span className="ml-auto text-[11px] text-slate-400">
          {plural(table.columns.length, 'column')} · {plural(table.indexes.length, 'index', 'indexes')}
          {table.foreignKeys.length > 0 && ` · ${plural(table.foreignKeys.length, 'foreign key')}`}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {cols.map((c) => (
            <DiffLine key={'c:' + c.name} icon={<Columns3 size={12} />} item={c} detail={columnText(c)} />
          ))}
          {idx.map((i) => (
            <DiffLine
              key={'i:' + i.name}
              icon={(i.source ?? i.dest)?.primary ? <KeyRound size={12} /> : <ListTree size={12} />}
              item={i}
              detail={indexText(i)}
            />
          ))}
          {fks.map((f) => (
            <DiffLine key={'f:' + f.name} icon={<Link2 size={12} />} item={f} detail={fkText(f)} />
          ))}
          {cols.length === 0 && idx.length === 0 && fks.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400">No differences</div>
          )}
        </div>
      )}
    </div>
  )
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`
}

function columnText(c: ColumnDiff): string {
  if (c.status === 'changed') return c.changes.join('  ·  ')
  const col = c.source ?? c.dest
  if (!col) return ''
  return [
    col.type,
    col.nullable ? null : 'NOT NULL',
    col.default !== null ? `default ${col.default}` : null,
    col.extra || null
  ]
    .filter(Boolean)
    .join(' · ')
}

function indexText(i: IndexDiff): string {
  if (i.status === 'changed') return i.changes.join('  ·  ')
  const ix = i.source ?? i.dest
  if (!ix) return ''
  const kind = ix.primary ? 'PRIMARY' : ix.unique ? 'UNIQUE' : 'INDEX'
  return `${kind} (${ix.columns.join(', ') || 'expression'})${ix.type ? ' · ' + ix.type.toLowerCase() : ''}`
}

function fkText(f: ForeignKeyDiff): string {
  if (f.status === 'changed') return f.changes.join('  ·  ')
  const fk = f.source ?? f.dest
  if (!fk) return ''
  let s = `FK (${fk.columns.join(', ')}) → ${fk.refTable}(${fk.refColumns.join(', ')})`
  if (fk.onDelete.toUpperCase() !== 'NO ACTION') s += ` · on delete ${fk.onDelete.toLowerCase()}`
  if (fk.onUpdate.toUpperCase() !== 'NO ACTION') s += ` · on update ${fk.onUpdate.toLowerCase()}`
  return s
}

function DiffLine({
  icon,
  item,
  detail
}: {
  icon: React.ReactNode
  item: { name: string; status: DiffStatus }
  detail: string
}): React.JSX.Element {
  const color = {
    missing: 'text-emerald-500',
    extra: 'text-rose-500',
    changed: 'text-amber-500',
    same: 'text-slate-400'
  }[item.status]
  const mark = { missing: '+', extra: '−', changed: '~', same: ' ' }[item.status]
  return (
    <div className="flex items-start gap-2.5 px-3 py-1.5 text-[13px]">
      <span className={`w-3 shrink-0 font-mono font-bold ${color}`}>{mark}</span>
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <span className="w-48 shrink-0 truncate font-mono text-slate-700 dark:text-slate-200" title={item.name}>
        {item.name}
      </span>
      <span className={`text-xs ${item.status === 'changed' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
        {detail}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sync view
// ---------------------------------------------------------------------------

function SyncView({
  result,
  selected,
  setSelected,
  scriptText,
  statementCount,
  destructiveCount,
  destLabel,
  applying,
  onApply
}: {
  result: Compared
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  scriptText: string
  statementCount: number
  destructiveCount: number
  destLabel: string
  applying: boolean
  onApply: () => void
}): React.JSX.Element {
  const toast = useToast()

  if (!result.sameEngine) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-slate-400">
        <AlertTriangle size={26} className="opacity-60" />
        <p className="text-sm">Sync needs both sides on the same engine (MySQL ↔ MySQL or PostgreSQL ↔ PostgreSQL).</p>
      </div>
    )
  }
  if (result.items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-emerald-500">
        <CheckCircle2 size={28} />
        <p className="text-sm">Nothing to sync — destination already matches source.</p>
      </div>
    )
  }

  const groups = new Map<string, SyncItem[]>()
  for (const i of result.items) {
    const arr = groups.get(i.tableKey) ?? []
    arr.push(i)
    groups.set(i.tableKey, arr)
  }

  const setMany = (ids: string[], on: boolean): void => {
    const next = new Set(selected)
    for (const id of ids) (on ? next.add(id) : next.delete(id))
    setSelected(next)
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(scriptText)
      toast.success('SQL copied to clipboard')
    } catch {
      toast.error('Could not access the clipboard')
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Items */}
      <div className="flex min-h-0 flex-col border-r border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 text-xs">
          <span className="mr-1 text-slate-400">Select:</span>
          <SmallBtn onClick={() => setSelected(new Set(result.items.filter((i) => !i.destructive).map((i) => i.id)))}>
            Safe changes
          </SmallBtn>
          <SmallBtn onClick={() => setSelected(new Set(result.items.map((i) => i.id)))}>All (incl. drops)</SmallBtn>
          <SmallBtn onClick={() => setSelected(new Set())}>None</SmallBtn>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {[...groups.entries()].map(([key, items]) => {
            const ids = items.map((i) => i.id)
            const on = ids.filter((id) => selected.has(id)).length
            return (
              <div key={key} className="mb-2 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                <label className="flex cursor-pointer items-center gap-2 bg-slate-50 px-3 py-1.5 text-sm dark:bg-slate-800/50">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-indigo-600"
                    checked={on === ids.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < ids.length
                    }}
                    onChange={(e) => setMany(ids, e.target.checked)}
                  />
                  <span className="font-medium text-slate-700 dark:text-slate-200">{key}</span>
                  <span className="ml-auto text-[11px] text-slate-400">
                    {on}/{ids.length}
                  </span>
                </label>
                {items.map((i) => (
                  <label
                    key={i.id}
                    className="flex cursor-pointer items-start gap-2 border-t border-slate-100 px-3 py-1.5 text-[12.5px] hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
                  >
                    <input
                      type="checkbox"
                      className={`mt-0.5 h-3.5 w-3.5 ${i.destructive ? 'accent-rose-600' : 'accent-indigo-600'}`}
                      checked={selected.has(i.id)}
                      onChange={(e) => setMany([i.id], e.target.checked)}
                    />
                    <div className="min-w-0">
                      <div
                        className={`break-words font-mono ${
                          i.destructive ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {i.label}
                      </div>
                      {i.warning && (
                        <div
                          className={`mt-0.5 flex items-center gap-1 text-[11px] ${
                            i.destructive ? 'text-rose-500/80' : 'text-amber-600 dark:text-amber-400/90'
                          }`}
                        >
                          <AlertTriangle size={11} className="shrink-0" /> {i.warning}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {/* Script */}
      <div className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-slate-400">
          <span>
            {statementCount} statement(s) → <b className="text-slate-600 dark:text-slate-300">{destLabel}</b>
          </span>
          <div className="ml-auto flex gap-2">
            <Button onClick={copy} disabled={statementCount === 0} icon={<Copy size={14} />}>
              Copy SQL
            </Button>
            <Button
              variant={destructiveCount > 0 ? 'danger' : 'primary'}
              onClick={onApply}
              disabled={statementCount === 0 || applying}
              icon={applying ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            >
              Apply to destination
            </Button>
          </div>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words border-t border-slate-200 bg-slate-50 px-4 py-3 font-mono text-[12px] leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-300">
          {scriptText || '-- Nothing selected'}
        </pre>
      </div>
    </div>
  )
}

function ConfirmApply({
  destConn,
  destDb,
  statementCount,
  destructiveCount,
  engine,
  applying,
  backupMode,
  setBackupMode,
  backupProgress,
  onCancelBackup,
  onCancel,
  onConfirm
}: {
  destConn: string
  destDb: string
  statementCount: number
  destructiveCount: number
  engine: string
  applying: boolean
  backupMode: BackupMode
  setBackupMode: (m: BackupMode) => void
  /** Non-null while the pre-sync backup runs. */
  backupProgress: { text: string } | null
  onCancelBackup: () => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const needsTyping = destructiveCount > 0
  const ok = !needsTyping || typed === destDb
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
          <ShieldAlert size={18} className={needsTyping ? 'text-rose-500' : 'text-amber-500'} />
          Apply sync to destination?
        </h3>
        <div className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>
            Run <b>{statementCount}</b> statement(s) on{' '}
            <b className="font-mono">
              {destConn} / {destDb}
            </b>
            .
          </p>
          {destructiveCount > 0 && (
            <p className="rounded-md bg-rose-500/10 px-3 py-2 text-rose-600 dark:text-rose-300">
              Includes <b>{destructiveCount}</b> destructive change(s) (drop table / column / index). Dropped data cannot be
              recovered.
            </p>
          )}
          <p className="text-xs text-slate-400">
            {engine === 'postgres'
              ? 'PostgreSQL runs the script in one transaction: if any statement fails, nothing is changed.'
              : 'MySQL commits each DDL statement immediately: if one fails, earlier statements stay applied.'}
          </p>
          <div>
            <label className="mb-1 block text-xs text-slate-500">Before running</label>
            <select
              value={backupMode}
              disabled={applying}
              onChange={(e) => setBackupMode(e.target.value as BackupMode)}
              className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="full">Back up destination: structure + data (recommended)</option>
              <option value="structure">Back up destination: structure only (faster)</option>
              <option value="none">No backup</option>
            </select>
            {backupMode !== 'none' && (
              <p className="mt-1 text-[11px] text-slate-400">Saved to Documents\ConnectD Backups — restore it from Backup → Restore.</p>
            )}
          </div>
          {backupProgress && (
            <div className="flex items-center gap-2 rounded-md bg-indigo-500/10 px-3 py-2 text-xs text-indigo-600 dark:text-indigo-300">
              <Loader2 size={13} className="shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{backupProgress.text}</span>
              <button onClick={onCancelBackup} className="shrink-0 hover:underline">
                Cancel
              </button>
            </div>
          )}
          {needsTyping && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">
                Type <b className="font-mono">{destDb}</b> to confirm
              </label>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 font-mono text-sm outline-none focus:border-rose-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant={needsTyping ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={!ok || applying}
            icon={applying ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          >
            {backupMode === 'none' ? `Run ${statementCount} statement(s)` : `Back up & run ${statementCount} statement(s)`}
          </Button>
        </div>
      </div>
    </div>
  )
}

function backingUpProgress(jobId: string | null, p: JobProgress | null): { text: string } | null {
  if (!jobId) return null
  if (!p) return { text: 'Backing up destination…' }
  const where = p.table ? ` — ${p.table}` : ''
  return {
    text: `Backing up destination${where} · table ${Math.min((p.tablesDone ?? 0) + 1, p.tablesTotal ?? 0)}/${p.tablesTotal ?? 0} · ${(p.rows ?? 0).toLocaleString()} rows · ${formatBytes(p.bytes)}`
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function SidePicker({
  label,
  side,
  connections,
  onConn,
  onDb
}: {
  label: string
  side: Side
  connections: ConnectionConfig[]
  onConn: (id: string) => void
  onDb: (db: string) => void
}): React.JSX.Element {
  const selCls =
    'h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200'
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="flex gap-2">
        <select className={selCls} value={side.connId} onChange={(e) => onConn(e.target.value)}>
          <option value="">Connection…</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.type})
            </option>
          ))}
        </select>
        <select
          className={selCls}
          value={side.db}
          disabled={side.loadingDbs || side.dbs.length === 0}
          onChange={(e) => onDb(e.target.value)}
        >
          <option value="">{side.loadingDbs ? 'Loading…' : 'Database…'}</option>
          {side.dbs.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <div className="relative w-64">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter tables…"
        className="h-7 w-full rounded-md border border-slate-300 bg-white pl-7 pr-2 text-xs text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
      />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex items-center border-b-2 px-1 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  )
}

function SmallBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  )
}

function Badge({
  color,
  icon,
  children
}: {
  color: 'emerald' | 'rose' | 'amber' | 'slate'
  icon?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const map = {
    emerald: 'bg-emerald-500/10 text-emerald-500',
    rose: 'bg-rose-500/10 text-rose-500',
    amber: 'bg-amber-500/10 text-amber-500',
    slate: 'bg-slate-500/10 text-slate-400'
  }
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${map[color]}`}>
      {icon}
      {children}
    </span>
  )
}
