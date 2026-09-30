import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionExportResult,
  ImportOptions,
  ImportPreview,
  ImportResult,
  BackupFileInfo,
  BackupOptions,
  BackupResult,
  ConnectResult,
  JobProgress,
  RestoreOptions,
  RestoreResult,
  DatabaseStructure,
  ScriptResult,
  ExportPayload,
  DbType,
  HistoryEntry,
  QueryResult,
  Result,
  SavedQuery,
  SchemaSnapshot,
  TableStructure,
  UpdatePayload,
  UpdateResult
} from '../shared/types'

export interface SaveResult {
  config: ConnectionConfig
  passwordNotStored: boolean
}

export interface ExportResult {
  saved: boolean
  path?: string
}

export interface ConnectDeeApi {
  listConnections: () => Promise<Result<ConnectionConfig[]>>
  saveConnection: (input: ConnectionInput) => Promise<Result<SaveResult>>
  deleteConnection: (id: string) => Promise<Result<void>>
  testConnection: (input: ConnectionInput) => Promise<Result<void>>
  /** Passwords are included (encrypted) only when a passphrase is given. */
  exportConnections: (ids: string[], passphrase?: string) => Promise<Result<ConnectionExportResult>>
  /** Resolves to null when the user cancels the file dialog. */
  pickConnectionsFile: () => Promise<Result<ImportPreview | null>>
  importConnections: (filePath: string, opts: ImportOptions) => Promise<Result<ImportResult>>
  connect: (sessionId: string, connectionId: string, password?: string) => Promise<Result<ConnectResult>>
  disconnect: (sessionId: string) => Promise<Result<void>>
  status: (sessionId: string) => Promise<Result<boolean>>
  useDatabase: (sessionId: string, database: string | null) => Promise<Result<ConnectResult>>
  query: (sessionId: string, sql: string) => Promise<Result<QueryResult>>
  update: (sessionId: string, payload: UpdatePayload) => Promise<Result<UpdateResult>>
  introspect: (sessionId: string) => Promise<Result<SchemaSnapshot>>
  describeTable: (sessionId: string, database: string, table: string) => Promise<Result<TableStructure>>
  compareDatabases: (connectionId: string) => Promise<Result<string[]>>
  compareStructure: (connectionId: string, database: string) => Promise<Result<DatabaseStructure>>
  compareCreateTables: (
    connectionId: string,
    database: string,
    tables: string[]
  ) => Promise<Result<Record<string, string>>>
  applySync: (
    connectionId: string,
    database: string,
    statements: string[]
  ) => Promise<Result<ScriptResult>>
  exportResult: (payload: ExportPayload) => Promise<Result<ExportResult>>
  listHistory: () => Promise<Result<HistoryEntry[]>>
  clearHistory: () => Promise<Result<void>>
  listSavedQueries: () => Promise<Result<SavedQuery[]>>
  addSavedQuery: (name: string, sql: string, dbType?: DbType) => Promise<Result<SavedQuery>>
  deleteSavedQuery: (id: string) => Promise<Result<void>>
  /** Resolves to null when the user cancels the save dialog. */
  backupDatabase: (
    jobId: string,
    connectionId: string,
    database: string,
    opts: BackupOptions
  ) => Promise<Result<BackupResult | null>>
  pickBackupFile: () => Promise<Result<BackupFileInfo | null>>
  restoreDatabase: (
    jobId: string,
    connectionId: string,
    database: string,
    filePath: string,
    opts: RestoreOptions
  ) => Promise<Result<RestoreResult>>
  cancelJob: (jobId: string) => Promise<Result<void>>
  showItemInFolder: (filePath: string) => Promise<Result<void>>
  /** Subscribes to backup/restore progress; returns an unsubscribe function. */
  onJobProgress: (cb: (p: JobProgress) => void) => () => void
}

const api: ConnectDeeApi = {
  listConnections: () => ipcRenderer.invoke('conn:list'),
  saveConnection: (input) => ipcRenderer.invoke('conn:save', input),
  deleteConnection: (id) => ipcRenderer.invoke('conn:delete', id),
  testConnection: (input) => ipcRenderer.invoke('conn:test', input),
  exportConnections: (ids, passphrase) => ipcRenderer.invoke('conn:export', ids, passphrase),
  pickConnectionsFile: () => ipcRenderer.invoke('conn:importPick'),
  importConnections: (filePath, opts) => ipcRenderer.invoke('conn:import', filePath, opts),
  connect: (sessionId, connectionId, password) =>
    ipcRenderer.invoke('conn:connect', sessionId, connectionId, password),
  disconnect: (sessionId) => ipcRenderer.invoke('conn:disconnect', sessionId),
  status: (sessionId) => ipcRenderer.invoke('conn:status', sessionId),
  useDatabase: (sessionId, database) => ipcRenderer.invoke('db:use', sessionId, database),
  query: (sessionId, sql) => ipcRenderer.invoke('db:query', sessionId, sql),
  update: (sessionId, payload) => ipcRenderer.invoke('db:update', sessionId, payload),
  introspect: (sessionId) => ipcRenderer.invoke('db:introspect', sessionId),
  describeTable: (sessionId, database, table) =>
    ipcRenderer.invoke('db:describe', sessionId, database, table),
  compareDatabases: (connectionId) => ipcRenderer.invoke('compare:databases', connectionId),
  compareStructure: (connectionId, database) =>
    ipcRenderer.invoke('compare:structure', connectionId, database),
  compareCreateTables: (connectionId, database, tables) =>
    ipcRenderer.invoke('compare:createTables', connectionId, database, tables),
  applySync: (connectionId, database, statements) =>
    ipcRenderer.invoke('compare:apply', connectionId, database, statements),
  exportResult: (payload) => ipcRenderer.invoke('export:save', payload),
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listSavedQueries: () => ipcRenderer.invoke('saved:list'),
  addSavedQuery: (name, sql, dbType) => ipcRenderer.invoke('saved:add', name, sql, dbType),
  deleteSavedQuery: (id) => ipcRenderer.invoke('saved:delete', id),
  backupDatabase: (jobId, connectionId, database, opts) =>
    ipcRenderer.invoke('backup:run', jobId, connectionId, database, opts),
  pickBackupFile: () => ipcRenderer.invoke('restore:pick'),
  restoreDatabase: (jobId, connectionId, database, filePath, opts) =>
    ipcRenderer.invoke('restore:run', jobId, connectionId, database, filePath, opts),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  onJobProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: JobProgress): void => cb(p)
    ipcRenderer.on('job:progress', listener)
    return () => {
      ipcRenderer.removeListener('job:progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
