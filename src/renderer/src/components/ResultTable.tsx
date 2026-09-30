import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Save,
  Undo2,
  Pencil,
  Lock,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  FileText,
  FileJson,
  FileSpreadsheet,
  Search,
  X
} from 'lucide-react'
import type { CellChange, ExportFormat, QueryResult } from '../../../shared/types'
import { Button } from './ui/Button'
import { Spinner } from './ui/Spinner'
import { formatCell, toEditString, sameValue } from '../lib/format'

type SortDir = 'asc' | 'desc'
interface SortState {
  column: string
  dir: SortDir
}

/** Compares two cell values: numbers numerically, nulls last, else by string. */
function compareValues(a: unknown, b: unknown): number {
  const an = a === null || a === undefined
  const bn = b === null || b === undefined
  if (an && bn) return 0
  if (an) return 1
  if (bn) return -1
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
    return na - nb
  }
  return String(a).localeCompare(String(b))
}

interface Props {
  result: QueryResult
  exporting: boolean
  onExport: (format: ExportFormat) => void
  onSave: (changes: CellChange[]) => Promise<boolean>
}

type EditMap = Record<number, Record<string, unknown>>

export function ResultTable({ result, exporting, onExport, onSave }: Props): React.JSX.Element {
  const [rows, setRows] = useState(result.rows)
  const [edits, setEdits] = useState<EditMap>({})
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)

  // Reset local state whenever a new result arrives.
  useEffect(() => {
    setRows(result.rows)
    setEdits({})
    setEditing(null)
    setFilter('')
    setSort(null)
  }, [result])

  const editable = result.editable
  const pkCols = useMemo(() => new Set(editable?.tables.flatMap((t) => t.pkColumns) ?? []), [editable])
  const readOnlyCount = editable ? result.columns.filter((c) => !editable.columns[c]).length : 0

  /**
   * A cell is editable when its column maps to a source table and this row has that
   * table's key (a LEFT JOIN with no match leaves the key NULL — nothing to update).
   */
  function canEdit(rowIdx: number, col: string): boolean {
    const target = editable?.columns[col]
    const row = rows[rowIdx]
    if (!target || !row) return false
    return editable!.tables[target.table].pkColumns.every((pc) => row[pc] !== null && row[pc] !== undefined)
  }

  /** Primary-key values of one source table, read from a result row. */
  function pkOf(tableIdx: number, row: Record<string, unknown>): Record<string, unknown> {
    const t = editable!.tables[tableIdx]
    return Object.fromEntries(t.primaryKey.map((k, i) => [k, row[t.pkColumns[i]]]))
  }

  /** Effective value of a cell (edited value if present, else original). */
  function effective(rowIdx: number, col: string, row: Record<string, unknown>): unknown {
    const cell = edits[rowIdx]
    if (cell && Object.prototype.hasOwnProperty.call(cell, col)) return cell[col]
    return row[col]
  }

  // Rows after filter + sort, each paired with its original index (edits use it).
  const view = useMemo(() => {
    let items = rows.map((row, i) => ({ row, i }))
    const f = filter.trim().toLowerCase()
    if (f) {
      items = items.filter(({ row, i }) =>
        result.columns.some((col) => formatCell(effective(i, col, row)).text.toLowerCase().includes(f))
      )
    }
    if (sort) {
      const { column, dir } = sort
      items = [...items].sort((a, b) => {
        const c = compareValues(effective(a.i, column, a.row), effective(b.i, column, b.row))
        return dir === 'asc' ? c : -c
      })
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, edits, filter, sort, result.columns])

  function toggleSort(col: string): void {
    setSort((prev) => {
      if (!prev || prev.column !== col) return { column: col, dir: 'asc' }
      if (prev.dir === 'asc') return { column: col, dir: 'desc' }
      return null
    })
  }

  const changes = useMemo<CellChange[]>(() => {
    const list: CellChange[] = []
    if (!editable) return list
    for (const [rowIdxStr, cols] of Object.entries(edits)) {
      const row = rows[Number(rowIdxStr)]
      if (!row) continue
      for (const [col, value] of Object.entries(cols)) {
        const target = editable.columns[col]
        if (!target) continue
        list.push({ table: target.table, pk: pkOf(target.table, row), column: target.column, value })
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, rows, editable])

  function editedValue(rowIdx: number, col: string): { has: boolean; value: unknown } {
    const cell = edits[rowIdx]
    if (cell && Object.prototype.hasOwnProperty.call(cell, col)) return { has: true, value: cell[col] }
    return { has: false, value: undefined }
  }

  function commitEdit(rowIdx: number, col: string, value: unknown): void {
    const original = rows[rowIdx]?.[col]
    setEdits((prev) => {
      const next = { ...prev }
      const rowEdits = { ...(next[rowIdx] ?? {}) }
      if (sameValue(value, original)) {
        delete rowEdits[col]
      } else {
        rowEdits[col] = value
      }
      if (Object.keys(rowEdits).length === 0) delete next[rowIdx]
      else next[rowIdx] = rowEdits
      return next
    })
    setEditing(null)
  }

  async function handleSave(): Promise<void> {
    if (changes.length === 0) return
    setSaving(true)
    const ok = await onSave(changes)
    setSaving(false)
    if (ok && editable) {
      // Write the saved values into every row and column that shows the same record:
      // in a join, one customer can appear on many order rows.
      setRows((prev) => {
        const next = prev.map((r) => ({ ...r }))
        for (const ch of changes) {
          const sameCols = result.columns.filter((c) => {
            const t = editable.columns[c]
            return t && t.table === ch.table && t.column === ch.column
          })
          for (const [i, row] of prev.entries()) {
            const pk = pkOf(ch.table, row)
            if (Object.keys(ch.pk).every((k) => sameValue(pk[k], ch.pk[k]))) {
              for (const c of sameCols) next[i][c] = ch.value
            }
          }
        }
        return next
      })
      setEdits({})
    }
  }

  // Non-SELECT statement result (INSERT/UPDATE/DDL).
  if (result.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
        <FileText size={28} className="opacity-50" />
        <p className="text-sm">{result.message ?? 'Statement executed'}</p>
        {result.affectedRows !== undefined && (
          <p className="text-xs">{result.affectedRows} row(s) affected</p>
        )}
      </div>
    )
  }

  const dirtyCount = changes.length

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
        <span className="font-medium text-slate-600 dark:text-slate-300">
          {filter.trim() ? `${view.length} of ${rows.length}` : rows.length} row
          {rows.length === 1 ? '' : 's'}
        </span>
        <span>· {result.durationMs} ms</span>
        {editable ? (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">
            <Pencil size={11} /> editable · {editable.tables.map((t) => t.label).join(', ')}
            {readOnlyCount > 0 && <span className="ml-1 text-slate-400">· {readOnlyCount} read-only column(s)</span>}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded bg-slate-500/10 px-1.5 py-0.5">
            <Lock size={11} /> read-only
          </span>
        )}

        <div className="relative ml-auto flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-slate-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter rows…"
            className="h-7 w-44 rounded-md border border-slate-300 bg-white pl-7 pr-6 text-xs text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Clear filter"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <>
              <Button variant="ghost" onClick={() => setEdits({})} icon={<Undo2 size={14} />}>
                Revert
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={saving}
                icon={saving ? <Spinner size={14} /> : <Save size={14} />}
              >
                Save {dirtyCount} change{dirtyCount === 1 ? '' : 's'}
              </Button>
            </>
          )}

          <div className="relative">
            <Button
              variant="secondary"
              onClick={() => setMenuOpen((o) => !o)}
              onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
              disabled={exporting}
              icon={exporting ? <Spinner size={14} /> : <Download size={14} />}
            >
              Export <ChevronDown size={13} />
            </Button>
            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
                <ExportItem icon={<FileText size={14} />} label="CSV" onClick={() => onExport('csv')} />
                <ExportItem icon={<FileJson size={14} />} label="JSON" onClick={() => onExport('json')} />
                <ExportItem
                  icon={<FileSpreadsheet size={14} />}
                  label="Excel (.xlsx)"
                  onClick={() => onExport('xlsx')}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800">
            <tr>
              <th className="w-12 border-b border-r border-slate-200 px-2 py-1.5 text-right text-[11px] font-medium text-slate-400 dark:border-slate-700">
                #
              </th>
              {result.columns.map((col) => {
                const active = sort?.column === col
                return (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    className="cursor-pointer select-none border-b border-r border-slate-200 px-3 py-1.5 text-left font-semibold text-slate-600 hover:bg-slate-200/70 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700/60"
                    title="Click to sort"
                  >
                    <span className="inline-flex items-center gap-1">
                      {pkCols.has(col) && <span className="text-amber-400">●</span>}
                      {editable && !editable.columns[col] && (
                        <span title="Read-only: computed column, or its table's primary key is not in the result">
                          <Lock size={10} className="text-slate-400" />
                        </span>
                      )}
                      {col}
                      {active ? (
                        sort!.dir === 'asc' ? (
                          <ChevronUp size={13} className="text-indigo-500" />
                        ) : (
                          <ChevronDown size={13} className="text-indigo-500" />
                        )
                      ) : (
                        <ChevronsUpDown size={12} className="text-slate-300 dark:text-slate-600" />
                      )}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {view.map(({ row, i: rowIdx }, viewIdx) => (
              <tr
                key={rowIdx}
                className="odd:bg-white even:bg-slate-50/60 hover:bg-indigo-500/5 dark:odd:bg-slate-900 dark:even:bg-slate-800/40"
              >
                <td className="border-b border-r border-slate-100 px-2 py-1 text-right text-[11px] text-slate-400 dark:border-slate-800">
                  {viewIdx + 1}
                </td>
                {result.columns.map((col) => {
                  const isEditing = editing?.row === rowIdx && editing.col === col
                  const edit = editedValue(rowIdx, col)
                  const raw = edit.has ? edit.value : row[col]
                  const display = formatCell(raw)
                  const cellEditable = canEdit(rowIdx, col)
                  return (
                    <td
                      key={col}
                      onDoubleClick={() => cellEditable && setEditing({ row: rowIdx, col })}
                      className={`max-w-[420px] border-b border-r border-slate-100 px-3 py-1 align-top dark:border-slate-800 ${
                        edit.has ? 'bg-amber-400/15' : ''
                      } ${cellEditable ? 'cursor-text' : ''}`}
                      title={cellEditable ? `Double-click to edit (${editable!.tables[editable!.columns[col].table].label})` : undefined}
                    >
                      {isEditing ? (
                        <CellEditor
                          initial={raw}
                          onCommit={(v) => commitEdit(rowIdx, col, v)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <span
                          className={`block truncate ${
                            display.isNull ? 'italic text-slate-400' : 'text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {display.text}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-400">No rows returned</div>
        )}
        {rows.length > 0 && view.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-400">No rows match “{filter}”</div>
        )}
      </div>
    </div>
  )
}

function ExportItem({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onMouseDown={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700/60"
    >
      {icon}
      {label}
    </button>
  )
}

function CellEditor({
  initial,
  onCommit,
  onCancel
}: {
  initial: unknown
  onCommit: (v: unknown) => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(toEditString(initial))
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <div className="flex items-center gap-1">
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(text)
          else if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onCommit(text)}
        className="w-full min-w-[80px] rounded border border-indigo-500 bg-white px-1.5 py-0.5 text-[13px] text-slate-800 outline-none dark:bg-slate-900 dark:text-slate-100"
      />
      <button
        title="Set NULL"
        onMouseDown={(e) => {
          e.preventDefault()
          onCommit(null)
        }}
        className="shrink-0 rounded px-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700"
      >
        NULL
      </button>
    </div>
  )
}
