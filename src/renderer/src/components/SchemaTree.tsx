import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Database,
  Table2,
  Columns3,
  KeyRound,
  RefreshCw,
  Loader2,
  Eye,
  TextCursorInput,
  TableProperties,
  Search,
  X
} from 'lucide-react'
import type { SchemaSnapshot, TableInfo } from '../../../shared/types'
import { IconButton } from './ui/Button'

interface Props {
  schema: SchemaSnapshot | null
  refreshing: boolean
  onRefresh: () => void
  onInsert: (text: string) => void
  onViewData: (table: TableInfo) => void
  onViewStructure: (table: TableInfo) => void
}

interface MenuState {
  x: number
  y: number
  table: TableInfo
}

export function SchemaTree({
  schema,
  refreshing,
  onRefresh,
  onInsert,
  onViewData,
  onViewStructure
}: Props): React.JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])
  const [query, setQuery] = useState('')

  const byDb = useMemo(() => {
    const map = new Map<string, TableInfo[]>()
    if (schema) {
      const q = query.trim().toLowerCase()
      for (const t of schema.tables) {
        if (q && !t.name.toLowerCase().includes(q)) continue
        const arr = map.get(t.database) ?? []
        arr.push(t)
        map.set(t.database, arr)
      }
    }
    return map
  }, [schema, query])

  const searching = query.trim().length > 0
  const totalMatches = [...byDb.values()].reduce((n, arr) => n + arr.length, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Schema</span>
        {schema && (
          <IconButton label="Refresh schema" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </IconButton>
        )}
      </div>

      {schema && (
        <div className="relative mb-1 px-2">
          <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tables…"
            className="h-7 w-full rounded-md border border-slate-300 bg-white pl-7 pr-6 text-xs text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {!schema && (
          <div className="px-3 py-6 text-center text-xs text-slate-400">
            Connect to a database to browse its schema.
          </div>
        )}
        {schema && searching && totalMatches === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-400">
            No tables match “{query}”
          </div>
        )}
        {schema &&
          [...byDb.entries()].map(([db, tables]) => (
            <DbNode
              key={db}
              db={db}
              tables={tables}
              expand={searching}
              onInsert={onInsert}
              onMenu={(table, x, y) => setMenu({ table, x, y })}
            />
          ))}
      </div>

      {menu && (
        <div
          className="fixed z-50 w-52 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={<Eye size={14} />}
            label="View data (100)"
            onClick={() => {
              onViewData(menu.table)
              setMenu(null)
            }}
          />
          <MenuItem
            icon={<TableProperties size={14} />}
            label="Structure / Indexes"
            onClick={() => {
              onViewStructure(menu.table)
              setMenu(null)
            }}
          />
          <MenuItem
            icon={<TextCursorInput size={14} />}
            label="Insert name"
            onClick={() => {
              onInsert(menu.table.name)
              setMenu(null)
            }}
          />
        </div>
      )}
    </div>
  )
}

function MenuItem({
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
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-slate-600 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700/60"
    >
      {icon}
      {label}
    </button>
  )
}

function DbNode({
  db,
  tables,
  expand,
  onInsert,
  onMenu
}: {
  db: string
  tables: TableInfo[]
  expand: boolean
  onInsert: (t: string) => void
  onMenu: (table: TableInfo, x: number, y: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(tables.length <= 40)
  const show = expand || open
  return (
    <div>
      <Row indent={0} onClick={() => setOpen((o) => !o)}>
        {show ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Database size={14} className="text-indigo-400" />
        <span className="truncate font-medium">{db}</span>
        <span className="ml-auto text-[10px] text-slate-400">{tables.length}</span>
      </Row>
      {show &&
        tables.map((t) => <TableNode key={t.name} table={t} onInsert={onInsert} onMenu={onMenu} />)}
    </div>
  )
}

function TableNode({
  table,
  onInsert,
  onMenu
}: {
  table: TableInfo
  onInsert: (t: string) => void
  onMenu: (table: TableInfo, x: number, y: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Row
        indent={1}
        onClick={() => setOpen((o) => !o)}
        onDouble={() => onInsert(table.name)}
        onContext={(x, y) => onMenu(table, x, y)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Table2 size={13} className="text-slate-400" />
        <span className="truncate">{table.name}</span>
      </Row>
      {open &&
        table.columns.map((col) => (
          <Row key={col.name} indent={2} onClick={() => onInsert(col.name)}>
            <span className="w-[13px]" />
            {col.isPrimaryKey ? (
              <KeyRound size={12} className="text-amber-400" />
            ) : (
              <Columns3 size={12} className="text-slate-400" />
            )}
            <span className="truncate">{col.name}</span>
            <span className="ml-auto truncate pl-2 text-[10px] text-slate-400">{col.dataType}</span>
          </Row>
        ))}
    </div>
  )
}

function Row({
  indent,
  onClick,
  onDouble,
  onContext,
  children
}: {
  indent: number
  onClick?: () => void
  onDouble?: () => void
  onContext?: (x: number, y: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDouble}
      onContextMenu={
        onContext
          ? (e) => {
              e.preventDefault()
              onContext(e.clientX, e.clientY)
            }
          : undefined
      }
      style={{ paddingLeft: 8 + indent * 14 }}
      className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[13px] text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-700/40"
    >
      {children}
    </button>
  )
}
