import { useCallback, useEffect, useState } from 'react'
import {
  X,
  Table2,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  Check,
  KeyRound,
  Columns3,
  ListTree,
  Loader2,
  AlertTriangle,
  Play
} from 'lucide-react'
import type { ColumnDetail, DbType, IndexDetail, TableStructure } from '../../../shared/types'
import { Button, IconButton } from './ui/Button'
import { useToast } from './ui/Toast'
import {
  type ColumnDraft,
  buildAddColumn,
  buildCreateIndex,
  buildDropColumn,
  buildDropIndex,
  buildModifyColumn
} from '../lib/ddl'

interface Props {
  open: boolean
  sessionId: string
  dbType: DbType | null
  database: string
  table: string
  onClose: () => void
  /** Called after a successful ALTER so the schema tree/autocomplete refresh. */
  onChanged: () => void
}

interface Pending {
  sql: string
  label: string
  danger: boolean
}

const MYSQL_TYPES = [
  'INT', 'BIGINT', 'TINYINT(1)', 'SMALLINT', 'DECIMAL(10,2)', 'DOUBLE', 'FLOAT',
  'VARCHAR(255)', 'CHAR(1)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'BOOLEAN', 'JSON', "ENUM('a','b')"
]
const PG_TYPES = [
  'integer', 'bigint', 'smallint', 'numeric(10,2)', 'double precision', 'real',
  'varchar(255)', 'char(1)', 'text', 'date', 'timestamp', 'timestamptz', 'time',
  'boolean', 'jsonb', 'json', 'uuid', 'serial', 'bigserial'
]

const emptyDraft = (): ColumnDraft => ({ name: '', type: '', nullable: true, default: '' })

export function TableStructureDialog({
  open,
  sessionId,
  dbType,
  database,
  table,
  onClose,
  onChanged
}: Props): React.JSX.Element | null {
  const toast = useToast()
  const [structure, setStructure] = useState<TableStructure | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'columns' | 'indexes'>('columns')

  const [editing, setEditing] = useState<{ index: number; draft: ColumnDraft } | null>(null)
  const [adding, setAdding] = useState<ColumnDraft | null>(null)
  const [newIndex, setNewIndex] = useState<{ name: string; columns: string[]; unique: boolean } | null>(
    null
  )
  const [pending, setPending] = useState<Pending | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await window.api.describeTable(sessionId, database, table)
    setLoading(false)
    if (res.ok) setStructure(res.data)
    else setError(res.error)
  }, [sessionId, database, table])

  useEffect(() => {
    if (!open) return
    setTab('columns')
    setEditing(null)
    setAdding(null)
    setNewIndex(null)
    setPending(null)
    void load()
  }, [open, load])

  if (!open) return null

  const typeList = dbType === 'postgres' ? PG_TYPES : MYSQL_TYPES

  // ---- action builders (all go through a confirm with the exact SQL) ----
  function saveEdit(): void {
    if (!editing || !structure) return
    const original = structure.columns[editing.index]
    const d = editing.draft
    if (!d.name.trim() || !d.type.trim()) return toast.error('Name and type are required')
    const defaultChanged = d.default !== (original.default ?? '')
    const sql = buildModifyColumn(dbType, database, table, original, d, defaultChanged)
    if (!sql) {
      setEditing(null)
      return toast.info('No changes')
    }
    setPending({ sql, label: `Modify column "${original.name}"`, danger: false })
  }

  function confirmAdd(): void {
    if (!adding) return
    if (!adding.name.trim() || !adding.type.trim()) return toast.error('Name and type are required')
    setPending({
      sql: buildAddColumn(dbType, database, table, { ...adding, name: adding.name.trim() }),
      label: `Add column "${adding.name.trim()}"`,
      danger: false
    })
  }

  function confirmDropColumn(col: ColumnDetail): void {
    setPending({
      sql: buildDropColumn(dbType, database, table, col.name),
      label: `Drop column "${col.name}" — its data will be permanently lost`,
      danger: true
    })
  }

  function confirmCreateIndex(): void {
    if (!newIndex) return
    if (!newIndex.name.trim()) return toast.error('Index name is required')
    if (newIndex.columns.length === 0) return toast.error('Pick at least one column')
    setPending({
      sql: buildCreateIndex(dbType, database, table, newIndex.name.trim(), newIndex.columns, newIndex.unique),
      label: `Create index "${newIndex.name.trim()}"`,
      danger: false
    })
  }

  function confirmDropIndex(idx: IndexDetail): void {
    setPending({
      sql: buildDropIndex(dbType, database, table, idx.name),
      label: `Drop index "${idx.name}"`,
      danger: true
    })
  }

  async function runPending(): Promise<void> {
    if (!pending) return
    setRunning(true)
    const res = await window.api.query(sessionId, pending.sql)
    setRunning(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(`${pending.label.split(' — ')[0]} — done`)
    setPending(null)
    setEditing(null)
    setAdding(null)
    setNewIndex(null)
    await load()
    onChanged()
  }

  // ---- render ----
  const inputCls =
    'h-7 w-full rounded border border-slate-300 bg-white px-2 text-xs text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
  const indexedCols = new Set(structure?.indexes.flatMap((i) => i.columns) ?? [])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="relative flex h-[86vh] w-full max-w-5xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <Table2 size={18} className="text-indigo-500" />
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            <span className="text-slate-400">{database}.</span>
            {table}
          </h2>
          <div className="ml-4 flex gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-slate-800">
            <TabBtn active={tab === 'columns'} onClick={() => setTab('columns')} icon={<Columns3 size={13} />}>
              Columns {structure && <span className="text-slate-400">{structure.columns.length}</span>}
            </TabBtn>
            <TabBtn active={tab === 'indexes'} onClick={() => setTab('indexes')} icon={<ListTree size={13} />}>
              Indexes {structure && <span className="text-slate-400">{structure.indexes.length}</span>}
            </TabBtn>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Reload" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </IconButton>
            <IconButton label="Close" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {error && (
            <div className="m-5 flex items-center gap-2 rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-500">
              <AlertTriangle size={15} /> {error}
            </div>
          )}
          {!structure && loading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 size={18} className="animate-spin" /> Loading structure…
            </div>
          )}

          {structure && tab === 'columns' && (
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="w-8 px-3 py-2">#</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="w-20 px-3 py-2 text-center">Nullable</th>
                  <th className="px-3 py-2">Default</th>
                  <th className="px-3 py-2">Key / Extra</th>
                  <th className="w-20 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {structure.columns.map((col, i) => {
                  const isEditing = editing?.index === i
                  if (isEditing && editing) {
                    const d = editing.draft
                    const set = (patch: Partial<ColumnDraft>): void =>
                      setEditing({ index: i, draft: { ...d, ...patch } })
                    return (
                      <tr key={col.name} className="bg-indigo-500/5">
                        <td className="px-3 py-1.5 text-xs text-slate-400">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <input className={inputCls} value={d.name} onChange={(e) => set({ name: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className={inputCls} list="cd-types" value={d.type} onChange={(e) => set({ type: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <input type="checkbox" checked={d.nullable} onChange={(e) => set({ nullable: e.target.checked })} className="accent-indigo-600" />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className={inputCls} value={d.default} placeholder="none" onChange={(e) => set({ default: e.target.value })} />
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-400">{col.isPrimaryKey ? 'PK' : ''} {col.extra}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex gap-0.5">
                            <IconButton label="Save" onClick={saveEdit}>
                              <Check size={15} className="text-emerald-500" />
                            </IconButton>
                            <IconButton label="Cancel" onClick={() => setEditing(null)}>
                              <X size={15} />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    )
                  }
                  return (
                    <tr key={col.name} className="group border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
                      <td className="px-3 py-1.5 text-xs text-slate-400">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-200">
                        <span className="inline-flex items-center gap-1.5">
                          {col.isPrimaryKey && <KeyRound size={12} className="text-amber-400" />}
                          {col.name}
                          {!col.isPrimaryKey && indexedCols.has(col.name) && (
                            <span title="Indexed" className="rounded bg-sky-500/10 px-1 text-[10px] text-sky-500">idx</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs text-indigo-600 dark:text-indigo-300">{col.type}</td>
                      <td className="px-3 py-1.5 text-center text-xs">
                        {col.nullable ? <span className="text-slate-400">YES</span> : <span className="font-medium text-slate-600 dark:text-slate-300">NO</span>}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-500">
                        {col.default === null ? <span className="italic text-slate-300 dark:text-slate-600">—</span> : col.default}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-400">
                        {col.isPrimaryKey && <span className="mr-1 rounded bg-amber-400/15 px-1 text-amber-500">PK</span>}
                        {col.extra}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                          <IconButton
                            label="Edit column"
                            onClick={() =>
                              setEditing({
                                index: i,
                                draft: { name: col.name, type: col.type, nullable: col.nullable, default: col.default ?? '' }
                              })
                            }
                          >
                            <Pencil size={14} />
                          </IconButton>
                          <IconButton label="Drop column" onClick={() => confirmDropColumn(col)}>
                            <Trash2 size={14} className="text-rose-500" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}

                {/* Add-column row */}
                {adding ? (
                  <tr className="bg-emerald-500/5">
                    <td className="px-3 py-1.5 text-xs text-emerald-500">+</td>
                    <td className="px-2 py-1.5">
                      <input autoFocus className={inputCls} placeholder="column_name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className={inputCls} list="cd-types" placeholder="type" value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={adding.nullable} onChange={(e) => setAdding({ ...adding, nullable: e.target.checked })} className="accent-indigo-600" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className={inputCls} placeholder="none" value={adding.default} onChange={(e) => setAdding({ ...adding, default: e.target.value })} />
                    </td>
                    <td />
                    <td className="px-2 py-1.5">
                      <div className="flex gap-0.5">
                        <IconButton label="Add" onClick={confirmAdd}>
                          <Check size={15} className="text-emerald-500" />
                        </IconButton>
                        <IconButton label="Cancel" onClick={() => setAdding(null)}>
                          <X size={15} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr>
                    <td colSpan={7} className="px-3 py-2">
                      <Button variant="ghost" icon={<Plus size={14} />} onClick={() => setAdding(emptyDraft())}>
                        Add column
                      </Button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {structure && tab === 'indexes' && (
            <div className="p-4">
              <table className="w-full border-collapse text-[13px]">
                <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Columns</th>
                    <th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Method</th>
                    <th className="w-12 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {structure.indexes.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-400">
                        No indexes on this table
                      </td>
                    </tr>
                  )}
                  {structure.indexes.map((idx) => (
                    <tr key={idx.name} className="group border-b border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2 font-mono text-slate-700 dark:text-slate-200">{idx.name}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {idx.columns.map((c) => (
                            <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {c}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {idx.primary ? (
                          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-500">PRIMARY</span>
                        ) : idx.unique ? (
                          <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-indigo-500">UNIQUE</span>
                        ) : (
                          <span className="text-slate-400">INDEX</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs uppercase text-slate-400">{idx.type}</td>
                      <td className="px-2 py-2">
                        {!idx.primary && (
                          <IconButton label="Drop index" onClick={() => confirmDropIndex(idx)}>
                            <Trash2 size={14} className="text-rose-500 opacity-0 group-hover:opacity-100" />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Create index */}
              <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700">
                {newIndex ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <input
                        autoFocus
                        className={`${inputCls} max-w-xs`}
                        placeholder="index name, e.g. idx_orders_status"
                        value={newIndex.name}
                        onChange={(e) => setNewIndex({ ...newIndex, name: e.target.value })}
                      />
                      <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={newIndex.unique}
                          onChange={(e) => setNewIndex({ ...newIndex, unique: e.target.checked })}
                          className="accent-indigo-600"
                        />
                        Unique
                      </label>
                      <div className="ml-auto flex gap-1">
                        <Button variant="ghost" onClick={() => setNewIndex(null)}>Cancel</Button>
                        <Button variant="primary" onClick={confirmCreateIndex} icon={<Check size={14} />}>Create</Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="mr-1 text-xs text-slate-400">Columns (in order):</span>
                      {structure.columns.map((c) => {
                        const pos = newIndex.columns.indexOf(c.name)
                        const on = pos >= 0
                        return (
                          <button
                            key={c.name}
                            onClick={() =>
                              setNewIndex({
                                ...newIndex,
                                columns: on
                                  ? newIndex.columns.filter((x) => x !== c.name)
                                  : [...newIndex.columns, c.name]
                              })
                            }
                            className={`rounded border px-2 py-0.5 font-mono text-xs transition-colors ${
                              on
                                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                                : 'border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-600'
                            }`}
                          >
                            {on && <span className="mr-1 font-bold">{pos + 1}</span>}
                            {c.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    icon={<Plus size={14} />}
                    onClick={() => setNewIndex({ name: `idx_${table}_`, columns: [], unique: false })}
                  >
                    Create index
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <datalist id="cd-types">
          {typeList.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        {/* Confirm with exact SQL */}
        {pending && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-black/40 p-6">
            <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-100">
                {pending.danger ? (
                  <AlertTriangle size={16} className="text-rose-500" />
                ) : (
                  <Play size={15} className="text-indigo-500" />
                )}
                {pending.label}
              </div>
              <div className="px-4 py-3">
                <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                  This will run the following SQL on <b>{database}</b>:
                </p>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-100 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-200">
                  {pending.sql}
                </pre>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700">
                <Button variant="ghost" onClick={() => setPending(null)} disabled={running}>
                  Cancel
                </Button>
                <Button
                  variant={pending.danger ? 'danger' : 'primary'}
                  onClick={() => void runPending()}
                  disabled={running}
                  icon={running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                >
                  Run
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100'
          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}
