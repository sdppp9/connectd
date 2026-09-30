import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Database,
  Play,
  History,
  Sun,
  Moon,
  Zap,
  AlertTriangle,
  GitCompareArrows,
  Bookmark,
  BookMarked,
  DatabaseBackup
} from 'lucide-react'
import { ToastProvider, useToast } from './components/ui/Toast'
import { Button } from './components/ui/Button'
import { Modal } from './components/ui/Modal'
import { Spinner } from './components/ui/Spinner'
import { ConnectionSidebar } from './components/ConnectionSidebar'
import { ConnectionForm } from './components/ConnectionForm'
import { DatabaseSelector } from './components/DatabaseSelector'
import { SchemaTree } from './components/SchemaTree'
import { QueryEditor } from './components/QueryEditor'
import { ResultTable } from './components/ResultTable'
import { HistoryPanel } from './components/HistoryPanel'
import { SavedQueriesPanel } from './components/SavedQueriesPanel'
import { CompareDialog } from './components/CompareDialog'
import { BackupDialog } from './components/BackupDialog'
import {
  ExportConnectionsDialog,
  ImportConnectionsDialog
} from './components/ConnectionTransferDialog'
import { TableStructureDialog } from './components/TableStructureDialog'
import { TabBar, type TabMeta } from './components/TabBar'
import { loadSession, saveSession } from './lib/session'
import { PAGE_SIZE, buildPageSql, buildCountSql } from './lib/browse'
import { clamp, readNumberPref, writePref } from './lib/prefs'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type {
  CellChange,
  ConnectionConfig,
  DbType,
  ExportFormat,
  HistoryEntry,
  ImportPreview,
  QueryResult,
  SavedQuery,
  SchemaSnapshot,
  TableInfo
} from '../../shared/types'

interface Tab {
  id: string
  title: string
  connectionId: string | null
  connectionName: string | null
  dbType: DbType | null
  schema: SchemaSnapshot | null
  databases: string[]
  currentDatabase: string | null
  sql: string
  result: QueryResult | null
  queryError: string | null
  running: boolean
  switchingDb: boolean
  connecting: boolean
  /** Active table-browsing pagination state, or null for a normal query. */
  browse: BrowseState | null
  /** Set when restored from a saved session; drives auto-reconnect on boot. */
  restoreConnectionId?: string | null
  restoreDatabase?: string | null
}

interface BrowseState {
  database: string
  table: string
  page: number
  totalRows: number
}

interface ConfirmState {
  message: string
  title: string
  danger: boolean
  resolve: (v: boolean) => void
}

/** SQL editor height (px), resizable with the splitter under it. */
const EDITOR_HEIGHT_KEY = 'connectd.editorHeight'
const EDITOR_HEIGHT_DEFAULT = 240
const EDITOR_HEIGHT_MIN = 80
/** Space always left for the results under the editor. */
const RESULT_MIN = 120

function newTab(): Tab {
  return {
    id: crypto.randomUUID(),
    title: 'New query',
    connectionId: null,
    connectionName: null,
    dbType: null,
    schema: null,
    databases: [],
    currentDatabase: null,
    sql: 'SELECT 1;',
    result: null,
    queryError: null,
    running: false,
    switchingDb: false,
    connecting: false,
    browse: null
  }
}

/** Builds the initial tab set, restoring the previous session if present. */
function restoreInitialTabs(): Tab[] {
  const session = loadSession()
  if (session && session.tabs.length > 0) {
    return session.tabs.map((pt) => ({
      ...newTab(),
      title: pt.title || 'New query',
      sql: pt.sql ?? '',
      restoreConnectionId: pt.connectionId ?? null,
      restoreDatabase: pt.currentDatabase ?? null
    }))
  }
  return [newTab()]
}

function tabTitle(name: string, db: string | null): string {
  return db ? `${name} · ${db}` : name
}

function Workspace(): React.JSX.Element {
  const toast = useToast()

  const [tabs, setTabs] = useState<Tab[]>(restoreInitialTabs)
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id)

  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [refreshingSchema, setRefreshingSchema] = useState(false)

  const [formOpen, setFormOpen] = useState(false)
  const [editingConfig, setEditingConfig] = useState<ConnectionConfig | null>(null)
  const [exportConnOpen, setExportConnOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [exporting, setExporting] = useState(false)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])

  const [savedOpen, setSavedOpen] = useState(false)
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [saveName, setSaveName] = useState('')
  const [saveModalOpen, setSaveModalOpen] = useState(false)

  const [compareOpen, setCompareOpen] = useState(false)
  /** Text highlighted in the active tab's editor ('' = none). */
  const [selectedSql, setSelectedSql] = useState('')
  // A selection belongs to one tab's editor; never carry it over to another tab.
  useEffect(() => setSelectedSql(''), [activeTabId])

  // ---- Resizable editor / results split ----
  const [editorHeight, setEditorHeight] = useState(() =>
    readNumberPref(EDITOR_HEIGHT_KEY, EDITOR_HEIGHT_DEFAULT, EDITOR_HEIGHT_MIN, 4000)
  )
  const [resizing, setResizing] = useState(false)
  const editorBoxRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  /** Keeps at least RESULT_MIN px for the results below the editor. */
  const clampEditorHeight = useCallback((h: number): number => {
    const box = editorBoxRef.current?.getBoundingClientRect()
    const main = mainRef.current?.getBoundingClientRect()
    const max = box && main ? main.bottom - box.top - RESULT_MIN : 4000
    return Math.round(clamp(h, EDITOR_HEIGHT_MIN, Math.max(EDITOR_HEIGHT_MIN, max)))
  }, [])

  const setAndSaveEditorHeight = useCallback(
    (h: number) => {
      const next = clampEditorHeight(h)
      setEditorHeight(next)
      writePref(EDITOR_HEIGHT_KEY, next)
    },
    [clampEditorHeight]
  )

  // A smaller window must not push the results out of view.
  useEffect(() => {
    const fit = (): void => setEditorHeight((h) => clampEditorHeight(h))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [clampEditorHeight])
  const [backupOpen, setBackupOpen] = useState(false)
  const [structureTarget, setStructureTarget] = useState<{
    sessionId: string
    dbType: DbType | null
    database: string
    table: string
  } | null>(null)

  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  )

  // Mirror of tabs for use inside async callbacks without stale closures.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const loadConnections = useCallback(async () => {
    const res = await window.api.listConnections()
    if (res.ok) setConnections(res.data)
    else toast.error(res.error)
  }, [toast])

  const handleImportConnections = useCallback(async () => {
    const res = await window.api.pickConnectionsFile()
    if (!res.ok) toast.error(res.error)
    else if (res.data) setImportPreview(res.data)
  }, [toast])

  const refreshHistory = useCallback(async () => {
    const res = await window.api.listHistory()
    if (res.ok) setHistory(res.data)
  }, [])

  const loadSavedQueries = useCallback(async () => {
    const res = await window.api.listSavedQueries()
    if (res.ok) setSavedQueries(res.data)
  }, [])

  // Core connect used by both the sidebar and session restore.
  const connectTab = useCallback(
    async (tabId: string, c: ConnectionConfig, savedDb?: string | null): Promise<boolean> => {
      patchTab(tabId, { connecting: true })
      const res = await window.api.connect(tabId, c.id)
      patchTab(tabId, { connecting: false })
      if (!res.ok) {
        toast.error(`${c.name}: ${res.error}`)
        return false
      }
      let data = res.data
      if (savedDb && savedDb !== data.currentDatabase && data.databases.includes(savedDb)) {
        const sw = await window.api.useDatabase(tabId, savedDb)
        if (sw.ok) data = sw.data
      }
      patchTab(tabId, {
        connectionId: c.id,
        connectionName: c.name,
        dbType: c.type,
        schema: data.schema,
        databases: data.databases,
        currentDatabase: data.currentDatabase,
        title: tabTitle(c.name, data.currentDatabase)
      })
      return true
    },
    [patchTab, toast]
  )

  // Boot: load data, then auto-reconnect any tabs restored from last session.
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void (async () => {
      const res = await window.api.listConnections()
      const conns = res.ok ? res.data : []
      if (res.ok) setConnections(conns)
      else toast.error(res.error)
      void refreshHistory()
      void loadSavedQueries()

      for (const tab of tabsRef.current) {
        if (!tab.restoreConnectionId) continue
        const c = conns.find((x) => x.id === tab.restoreConnectionId)
        patchTab(tab.id, { restoreConnectionId: null, restoreDatabase: null })
        if (c) await connectTab(tab.id, c, tab.restoreDatabase ?? undefined)
      }
    })()
  }, [connectTab, loadSavedQueries, patchTab, refreshHistory, toast])

  // Persist the session (open tabs + drafts) whenever it changes.
  useEffect(() => {
    saveSession({
      tabs: tabs.map((t) => ({
        title: t.title,
        sql: t.sql,
        connectionId: t.connectionId ?? t.restoreConnectionId ?? null,
        connectionName: t.connectionName,
        dbType: t.dbType,
        currentDatabase: t.currentDatabase ?? t.restoreDatabase ?? null
      })),
      activeIndex: Math.max(
        0,
        tabs.findIndex((t) => t.id === activeTabId)
      )
    })
  }, [tabs, activeTabId])

  function confirm(message: string, opts?: { title?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) =>
      setConfirmState({
        message,
        title: opts?.title ?? 'Please confirm',
        danger: opts?.danger ?? false,
        resolve
      })
    )
  }

  function toggleTheme(): void {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  // ---- Tab actions ----
  function handleNewTab(): void {
    const t = newTab()
    setTabs((ts) => [...ts, t])
    setActiveTabId(t.id)
  }

  async function handleCloseTab(id: string): Promise<void> {
    const tab = tabs.find((t) => t.id === id)
    if (tab?.connectionId) void window.api.disconnect(id)
    const remaining = tabs.filter((t) => t.id !== id)
    if (remaining.length === 0) {
      const t = newTab()
      setTabs([t])
      setActiveTabId(t.id)
      return
    }
    setTabs(remaining)
    if (activeTabId === id) {
      const idx = tabs.findIndex((t) => t.id === id)
      const next = remaining[Math.min(idx, remaining.length - 1)]
      setActiveTabId(next.id)
    }
  }

  // ---- Connection actions (operate on the active tab) ----
  async function handleConnect(c: ConnectionConfig): Promise<void> {
    const ok = await connectTab(activeTab.id, c)
    if (ok) toast.success(`Connected to ${c.name}`)
  }

  async function handleDisconnect(): Promise<void> {
    const tab = activeTab
    if (!tab.connectionId) return
    await window.api.disconnect(tab.id)
    patchTab(tab.id, {
      connectionId: null,
      connectionName: null,
      dbType: null,
      schema: null,
      databases: [],
      currentDatabase: null,
      title: 'New query'
    })
    toast.info('Disconnected')
  }

  async function handleDelete(c: ConnectionConfig): Promise<void> {
    const ok = await confirm(`Delete connection "${c.name}"? This cannot be undone.`, {
      title: 'Delete connection',
      danger: true
    })
    if (!ok) return
    const res = await window.api.deleteConnection(c.id)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    // Reset any tabs that were using this connection.
    setTabs((ts) =>
      ts.map((t) =>
        t.connectionId === c.id
          ? {
              ...t,
              connectionId: null,
              connectionName: null,
              dbType: null,
              schema: null,
              databases: [],
              currentDatabase: null,
              title: 'New query'
            }
          : t
      )
    )
    await loadConnections()
    toast.success('Connection deleted')
  }

  async function handleSwitchDatabase(db: string | null): Promise<void> {
    const tab = activeTab
    if (!tab.connectionId) return
    patchTab(tab.id, { switchingDb: true })
    const res = await window.api.useDatabase(tab.id, db)
    patchTab(tab.id, { switchingDb: false })
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    patchTab(tab.id, {
      schema: res.data.schema,
      databases: res.data.databases,
      currentDatabase: res.data.currentDatabase,
      title: tabTitle(tab.connectionName ?? 'Connection', res.data.currentDatabase)
    })
    toast.success(db ? `Using database "${db}"` : 'Browsing all databases')
  }

  async function handleRefreshSchema(): Promise<void> {
    const tab = activeTab
    if (!tab.connectionId) return
    setRefreshingSchema(true)
    const res = await window.api.introspect(tab.id)
    setRefreshingSchema(false)
    if (res.ok) patchTab(tab.id, { schema: res.data })
    else toast.error(res.error)
  }

  function insertText(text: string): void {
    const tab = activeTab
    const s = tab.sql
    patchTab(tab.id, { sql: s.length === 0 || /\s$/.test(s) ? s + text : s + ' ' + text })
  }

  // ---- Query ----
  async function runQuery(): Promise<void> {
    const tab = activeTab
    if (!tab.connectionId) {
      toast.error('Connect this tab to a database first')
      return
    }
    // Highlighted text runs on its own; otherwise the whole editor.
    const sql = selectedSql.trim() ? selectedSql : tab.sql
    if (!sql.trim()) return
    patchTab(tab.id, { running: true, queryError: null, browse: null })
    const res = await window.api.query(tab.id, sql)
    patchTab(tab.id, { running: false })
    await refreshHistory()
    if (!res.ok) {
      patchTab(tab.id, { queryError: res.error, result: null })
      return
    }
    patchTab(tab.id, { result: res.data })
  }

  async function handleExport(format: ExportFormat): Promise<void> {
    const tab = activeTab
    if (!tab.result) return
    setExporting(true)
    const res = await window.api.exportResult({
      format,
      columns: tab.result.columns,
      rows: tab.result.rows,
      suggestedName: tab.connectionName ?? 'result'
    })
    setExporting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.saved) toast.success('Exported successfully')
  }

  async function handleSaveChanges(changes: CellChange[]): Promise<boolean> {
    const tab = activeTab
    if (!tab.connectionId || !tab.result?.editable) return false
    const meta = tab.result.editable

    // One target per source table; all of them run in a single transaction.
    const byTable = new Map<number, CellChange[]>()
    for (const c of changes) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c])
    const targets = [...byTable.entries()].map(([idx, list]) => {
      const t = meta.tables[idx]
      // Key changes go last so the other updates on that row still find it by its old key.
      const isKey = (c: CellChange): number => (t.primaryKey.includes(c.column) ? 1 : 0)
      return {
        database: t.database,
        table: t.table,
        primaryKey: t.primaryKey,
        changes: [...list].sort((a, b) => isKey(a) - isKey(b)).map(({ pk, column, value }) => ({ pk, column, value }))
      }
    })

    const rowCount = new Set(changes.map((c) => `${c.table}:${JSON.stringify(c.pk)}`)).size
    const names = [...byTable.keys()].map((i) => `"${meta.tables[i].table}"`).join(', ')
    const ok = await confirm(
      `Apply ${changes.length} change(s) across ${rowCount} row(s) in ${names}?` +
        (targets.length > 1 ? ' All tables are updated in one transaction.' : ''),
      { title: 'Save changes to database' }
    )
    if (!ok) return false
    const res = await window.api.update(tab.id, { targets })
    if (!res.ok) {
      toast.error(res.error)
      return false
    }
    toast.success(`Updated ${res.data.updatedRows} row(s)`)
    return true
  }

  // ---- Table data browsing (right-click → View data) ----
  async function loadBrowsePage(
    tabId: string,
    database: string,
    table: string,
    page: number,
    totalRowsKnown?: number
  ): Promise<void> {
    const t = tabsRef.current.find((x) => x.id === tabId)
    if (!t) return
    patchTab(tabId, { running: true, queryError: null })

    let totalRows = totalRowsKnown
    if (totalRows === undefined) {
      const cres = await window.api.query(tabId, buildCountSql(t.dbType, database, table))
      if (cres.ok) {
        const row = cres.data.rows[0] as Record<string, unknown> | undefined
        totalRows = Number(row?.total ?? Object.values(row ?? {})[0] ?? 0)
      } else {
        totalRows = 0
      }
    }

    const pageSql = buildPageSql(t.dbType, database, table, page, PAGE_SIZE)
    const res = await window.api.query(tabId, pageSql)
    patchTab(tabId, { running: false })
    await refreshHistory()
    if (!res.ok) {
      patchTab(tabId, { queryError: res.error, result: null, browse: null })
      return
    }
    patchTab(tabId, {
      result: res.data,
      queryError: null,
      sql: pageSql,
      browse: { database, table, page, totalRows: totalRows ?? 0 }
    })
  }

  function handleViewData(table: TableInfo): void {
    const tab = activeTab
    if (!tab.connectionId) {
      toast.error('Connect this tab to a database first')
      return
    }
    void loadBrowsePage(tab.id, table.database, table.name, 0)
  }

  function handleViewStructure(table: TableInfo): void {
    const tab = activeTab
    if (!tab.connectionId) {
      toast.error('Connect this tab to a database first')
      return
    }
    setStructureTarget({
      sessionId: tab.id,
      dbType: tab.dbType,
      database: table.database,
      table: table.name
    })
  }

  function browseToPage(page: number): void {
    const tab = activeTab
    if (!tab.browse) return
    void loadBrowsePage(tab.id, tab.browse.database, tab.browse.table, page, tab.browse.totalRows)
  }

  function openSaveModal(): void {
    if (!activeTab.sql.trim()) {
      toast.error('Nothing to save — the editor is empty')
      return
    }
    const firstLine = activeTab.sql.trim().split('\n')[0].slice(0, 40)
    setSaveName(firstLine)
    setSaveModalOpen(true)
  }

  async function confirmSaveQuery(): Promise<void> {
    if (!saveName.trim()) {
      toast.error('Please enter a name')
      return
    }
    const res = await window.api.addSavedQuery(
      saveName.trim(),
      activeTab.sql,
      activeTab.dbType ?? undefined
    )
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setSaveModalOpen(false)
    await loadSavedQueries()
    toast.success('Query saved')
  }

  async function deleteSavedQuery(id: string): Promise<void> {
    const res = await window.api.deleteSavedQuery(id)
    if (res.ok) loadSavedQueries()
    else toast.error(res.error)
  }

  const tabMetas: TabMeta[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    dbType: t.dbType,
    connected: Boolean(t.connectionId)
  }))

  return (
    <div className="flex h-full bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Zap size={16} />
          </div>
          <span className="text-sm font-bold tracking-tight">ConnectD</span>
        </div>

        <div className="max-h-[45%] overflow-auto border-b border-slate-200 py-1 dark:border-slate-800">
          <ConnectionSidebar
            connections={connections}
            activeId={activeTab.connectionId}
            connectingId={activeTab.connecting ? activeTab.connectionId : null}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onEdit={(c) => {
              setEditingConfig(c)
              setFormOpen(true)
            }}
            onDelete={handleDelete}
            onNew={() => {
              setEditingConfig(null)
              setFormOpen(true)
            }}
            onImport={handleImportConnections}
            onExport={() => setExportConnOpen(true)}
          />
        </div>

        <SchemaTree
          schema={activeTab.schema}
          refreshing={refreshingSchema}
          onRefresh={handleRefreshSchema}
          onInsert={insertText}
          onViewData={handleViewData}
          onViewStructure={handleViewStructure}
        />
      </aside>

      {/* Main */}
      <main ref={mainRef} className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabMetas}
          activeId={activeTabId}
          onSelect={setActiveTabId}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />

        {/* Status bar */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm">
            <Database
              size={16}
              className={activeTab.connectionId ? 'text-emerald-500' : 'text-slate-400'}
            />
            {activeTab.connectionName ? (
              <span className="font-medium">
                {activeTab.connectionName}
                <span className="ml-1 text-xs text-slate-400">({activeTab.dbType})</span>
              </span>
            ) : (
              <span className="text-slate-400">Not connected — pick a connection on the left</span>
            )}
          </div>

          {activeTab.connectionId && activeTab.databases.length > 0 && activeTab.dbType && (
            <DatabaseSelector
              databases={activeTab.databases}
              current={activeTab.currentDatabase}
              dbType={activeTab.dbType}
              switching={activeTab.switchingDb}
              onChange={handleSwitchDatabase}
            />
          )}

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              onClick={() => setCompareOpen(true)}
              icon={<GitCompareArrows size={15} />}
            >
              Compare &amp; Sync
            </Button>
            <Button variant="ghost" onClick={() => setBackupOpen(true)} icon={<DatabaseBackup size={15} />}>
              Backup
            </Button>
            <Button variant="ghost" onClick={() => setSavedOpen(true)} icon={<BookMarked size={15} />}>
              Saved
            </Button>
            <Button variant="ghost" onClick={() => setHistoryOpen(true)} icon={<History size={15} />}>
              History
            </Button>
            <Button
              variant="ghost"
              onClick={toggleTheme}
              icon={dark ? <Sun size={15} /> : <Moon size={15} />}
            >
              {dark ? 'Light' : 'Dark'}
            </Button>
          </div>
        </header>

        {/* Editor */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              SQL Query
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">
                {selectedSql.trim() ? 'Runs the highlighted SQL only · ' : ''}Ctrl/Cmd + Enter
              </span>
              <Button variant="ghost" onClick={openSaveModal} icon={<Bookmark size={14} />}>
                Save
              </Button>
              <Button
                variant="primary"
                onClick={runQuery}
                disabled={activeTab.running || !activeTab.connectionId}
                icon={activeTab.running ? <Spinner size={14} /> : <Play size={14} />}
              >
                {selectedSql.trim() ? 'Run selected' : 'Run'}
              </Button>
            </div>
          </div>
          <div ref={editorBoxRef} style={{ height: editorHeight }} className="shrink-0">
            <QueryEditor
              value={activeTab.sql}
              onChange={(v) => patchTab(activeTab.id, { sql: v })}
              onRun={runQuery}
              onSelectionChange={setSelectedSql}
              schema={activeTab.schema}
              currentDatabase={activeTab.currentDatabase}
              dbType={activeTab.dbType}
              dark={dark}
              disabled={activeTab.running}
            />
          </div>
        </div>

        {/* Drag to resize the editor; double-click resets; arrow keys when focused. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize SQL editor"
          aria-valuenow={editorHeight}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dragRef.current = { startY: e.clientY, startH: editorHeight }
            setResizing(true)
          }}
          onPointerMove={(e) => {
            const d = dragRef.current
            if (d) setEditorHeight(clampEditorHeight(d.startH + e.clientY - d.startY))
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId)
            dragRef.current = null
            setResizing(false)
            writePref(EDITOR_HEIGHT_KEY, editorHeight)
          }}
          onDoubleClick={() => setAndSaveEditorHeight(EDITOR_HEIGHT_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              setAndSaveEditorHeight(editorHeight + (e.key === 'ArrowDown' ? 20 : -20))
            }
          }}
          className={`group relative h-1.5 shrink-0 cursor-row-resize touch-none border-y border-slate-200 outline-none dark:border-slate-800 ${
            resizing ? 'bg-indigo-500/60' : 'bg-slate-100 hover:bg-indigo-500/40 focus-visible:bg-indigo-500/40 dark:bg-slate-800/60'
          }`}
        >
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-300 group-hover:bg-white dark:bg-slate-600" />
        </div>

        {/* Result */}
        <section className="min-h-0 flex-1 bg-white dark:bg-slate-900">
          {activeTab.running ? (
            <Centered>
              <Spinner size={22} className="text-indigo-500" />
              <span className="text-sm text-slate-400">Running query…</span>
            </Centered>
          ) : activeTab.queryError ? (
            <Centered>
              <AlertTriangle size={26} className="text-rose-500" />
              <span className="max-w-lg text-center text-sm text-rose-500">{activeTab.queryError}</span>
            </Centered>
          ) : activeTab.result ? (
            <div className="flex h-full flex-col">
              {activeTab.browse && (
                <PaginationBar
                  browse={activeTab.browse}
                  onPrev={() => browseToPage(activeTab.browse!.page - 1)}
                  onNext={() => browseToPage(activeTab.browse!.page + 1)}
                />
              )}
              <div className="min-h-0 flex-1">
                <ResultTable
                  key={activeTab.id}
                  result={activeTab.result}
                  exporting={exporting}
                  onExport={handleExport}
                  onSave={handleSaveChanges}
                />
              </div>
            </div>
          ) : (
            <Centered>
              <Database size={28} className="text-slate-300 dark:text-slate-600" />
              <span className="text-sm text-slate-400">
                {activeTab.connectionId
                  ? 'Write a query and press Run to see results'
                  : 'Connect this tab to a database to get started'}
              </span>
            </Centered>
          )}
        </section>
      </main>

      <ConnectionForm
        open={formOpen}
        editing={editingConfig}
        onClose={() => setFormOpen(false)}
        onSaved={async () => {
          setFormOpen(false)
          await loadConnections()
        }}
      />

      <ExportConnectionsDialog
        open={exportConnOpen}
        connections={connections}
        onClose={() => setExportConnOpen(false)}
      />
      <ImportConnectionsDialog
        preview={importPreview}
        onClose={() => setImportPreview(null)}
        onImported={() => void loadConnections()}
      />

      <HistoryPanel
        open={historyOpen}
        entries={history}
        onClose={() => setHistoryOpen(false)}
        onPick={(picked) => {
          patchTab(activeTab.id, { sql: picked })
          setHistoryOpen(false)
        }}
        onClear={async () => {
          await window.api.clearHistory()
          refreshHistory()
        }}
      />

      <SavedQueriesPanel
        open={savedOpen}
        items={savedQueries}
        onClose={() => setSavedOpen(false)}
        onPick={(picked) => {
          patchTab(activeTab.id, { sql: picked })
          setSavedOpen(false)
        }}
        onDelete={deleteSavedQuery}
      />

      <CompareDialog
        open={compareOpen}
        connections={connections}
        onClose={() => setCompareOpen(false)}
      />
      <BackupDialog
        open={backupOpen}
        connections={connections}
        defaultConnectionId={activeTab.connectionId}
        defaultDatabase={activeTab.currentDatabase}
        onClose={() => setBackupOpen(false)}
        onRestored={(connectionId) => {
          // The open tab may be looking at the database that was just restored.
          if (activeTab.connectionId === connectionId) void handleRefreshSchema()
        }}
      />

      {structureTarget && (
        <TableStructureDialog
          open
          sessionId={structureTarget.sessionId}
          dbType={structureTarget.dbType}
          database={structureTarget.database}
          table={structureTarget.table}
          onClose={() => setStructureTarget(null)}
          onChanged={() => void handleRefreshSchema()}
        />
      )}

      <Modal
        open={saveModalOpen}
        title="Save query"
        onClose={() => setSaveModalOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={confirmSaveQuery}>
              Save
            </Button>
          </>
        }
      >
        <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Name
        </label>
        <input
          autoFocus
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirmSaveQuery()}
          placeholder="e.g. Active customers report"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
      </Modal>

      <Modal
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        onClose={() => {
          confirmState?.resolve(false)
          setConfirmState(null)
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                confirmState?.resolve(false)
                setConfirmState(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant={confirmState?.danger ? 'danger' : 'primary'}
              onClick={() => {
                confirmState?.resolve(true)
                setConfirmState(null)
              }}
            >
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">{confirmState?.message}</p>
      </Modal>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-full flex-col items-center justify-center gap-3">{children}</div>
}

function PaginationBar({
  browse,
  onPrev,
  onNext
}: {
  browse: BrowseState
  onPrev: () => void
  onNext: () => void
}): React.JSX.Element {
  const from = browse.totalRows === 0 ? 0 : browse.page * PAGE_SIZE + 1
  const to = Math.min((browse.page + 1) * PAGE_SIZE, browse.totalRows)
  const hasPrev = browse.page > 0
  const hasNext = to < browse.totalRows
  const totalPages = Math.max(1, Math.ceil(browse.totalRows / PAGE_SIZE))
  return (
    <div className="flex items-center gap-3 border-b border-slate-200 bg-indigo-500/5 px-3 py-1.5 text-xs dark:border-slate-800">
      <span className="font-medium text-slate-600 dark:text-slate-300">
        Browsing <span className="text-indigo-500">{browse.table}</span>
      </span>
      <span className="text-slate-400">
        {from.toLocaleString()}–{to.toLocaleString()} of {browse.totalRows.toLocaleString()} rows
      </span>
      <div className="ml-auto flex items-center gap-1">
        <span className="mr-1 text-slate-400">
          Page {browse.page + 1} / {totalPages}
        </span>
        <Button variant="secondary" onClick={onPrev} disabled={!hasPrev} icon={<ChevronLeft size={14} />}>
          Prev
        </Button>
        <Button variant="secondary" onClick={onNext} disabled={!hasNext}>
          Next <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Workspace />
    </ToastProvider>
  )
}
