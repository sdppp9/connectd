import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { readFile, stat, writeFile } from 'fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  BackupOptions,
  ConnectionExportResult,
  ConnectionInput,
  ImportOptions,
  ImportPreview,
  ImportResult,
  ExportPayload,
  RestoreOptions,
  Result,
  UpdatePayload
} from '../shared/types'
import {
  defaultBackupPath,
  inspectBackup,
  runBackup,
  runRestore,
  type Job
} from './backup'
import { manager } from './db/manager'
import * as connections from './store/connections'
import {
  buildConnectionFile,
  fileHasPasswords,
  parseConnectionFile,
  previewItems,
  readConnectionFile,
  type ConnectionFile
} from './store/connectionTransfer'
import * as history from './store/history'
import * as savedQueries from './store/savedQueries'
import type { DbType } from '../shared/types'
import { writeCsv, writeJson, writeXlsx } from './export'

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Registers an invoke handler that always resolves to a Result wrapper. */
function handle<T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
    try {
      const data = await fn(event, ...args)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: toMessage(err) }
    }
  })
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

async function loadConnectionFile(filePath: string): Promise<ConnectionFile> {
  if ((await stat(filePath)).size > MAX_IMPORT_BYTES) throw new Error('File is too large to be a connections file')
  return parseConnectionFile(await readFile(filePath, 'utf-8'))
}

async function readImportFile(filePath: string): Promise<ImportPreview> {
  const file = await loadConnectionFile(filePath)
  return {
    filePath,
    exportedAt: file.exportedAt,
    encrypted: fileHasPasswords(file),
    items: previewItems(file, connections.list())
  }
}

export function registerIpc(): void {
  // ---- Connections ----
  handle('conn:list', () => connections.list())

  handle('conn:save', (_e, input: ConnectionInput) => connections.save(input))

  handle('conn:delete', async (_e, id: string) => {
    await manager.disconnectByConnectionId(id)
    connections.remove(id)
  })

  handle('conn:test', async (_e, input: ConnectionInput) => {
    const config = {
      id: input.id ?? 'test',
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      user: input.user,
      database: input.database,
      ssl: input.ssl
    }
    await manager.test(config, input.password)
  })

  // sessionId identifies a tab; connectionId resolves the saved config.
  handle(
    'conn:connect',
    async (_e, sessionId: string, connectionId: string, passwordOverride?: string) => {
      const config = connections.getConfig(connectionId)
      if (!config) throw new Error('Connection not found')
      const password = passwordOverride ?? connections.getPassword(connectionId)
      return manager.connect(sessionId, config, password)
    }
  )

  handle('conn:disconnect', (_e, sessionId: string) => manager.disconnect(sessionId))

  handle('conn:status', (_e, sessionId: string) => manager.isConnected(sessionId))

  handle(
    'conn:export',
    async (event, ids: string[], passphrase?: string): Promise<ConnectionExportResult> => {
      const items = connections.portable(ids)
      if (items.length === 0) throw new Error('Choose at least one connection')
      // Validate (and derive the key) before asking where to save.
      const file = await buildConnectionFile(items, passphrase)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const day = new Date().toISOString().slice(0, 10)
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Export connections',
        defaultPath: `connectd-connections-${day}.json`,
        filters: [{ name: 'ConnectD connections', extensions: ['json'] }]
      })
      if (canceled || !filePath) return { saved: false }
      await writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8')
      return {
        saved: true,
        path: filePath,
        count: file.connections.length,
        passwords: file.connections.filter((c) => c.password).length
      }
    }
  )

  handle('conn:importPick', async (event): Promise<ImportPreview | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import connections',
      properties: ['openFile'],
      filters: [
        { name: 'ConnectD connections', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return readImportFile(res.filePaths[0])
  })

  handle(
    'conn:import',
    async (_e, filePath: string, opts: ImportOptions): Promise<ImportResult> => {
      const file = await loadConnectionFile(filePath)
      const passphrase = opts.passphrase || undefined
      const all = await readConnectionFile(file, passphrase)
      const picked = [...new Set(opts.indexes)]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < all.length)
        .sort((a, b) => a - b)
        .map((i) => all[i])
      if (picked.length === 0) throw new Error('Choose at least one connection')
      return connections.importMany(picked, opts.duplicates)
    }
  )

  handle('db:use', (_e, sessionId: string, database: string | null) =>
    manager.useDatabase(sessionId, database)
  )

  // ---- Queries ----
  handle('db:query', async (_e, sessionId: string, sql: string) => {
    const connName = manager.connectionName(sessionId) ?? 'connection'
    try {
      const result = await manager.query(sessionId, sql)
      history.add({
        connectionId: sessionId,
        connectionName: connName,
        sql,
        ok: true,
        rowCount: result.rowCount,
        durationMs: result.durationMs
      })
      return result
    } catch (err) {
      history.add({
        connectionId: sessionId,
        connectionName: connName,
        sql,
        ok: false,
        error: toMessage(err)
      })
      throw err
    }
  })

  handle('db:update', async (_e, sessionId: string, payload: UpdatePayload) => {
    const updatedRows = await manager.update(sessionId, payload)
    return { updatedRows }
  })

  handle('db:introspect', (_e, sessionId: string) => manager.introspect(sessionId))

  handle('db:describe', (_e, sessionId: string, database: string, table: string) =>
    manager.describeTable(sessionId, database, table)
  )

  // ---- Schema compare (throwaway connections) ----
  handle('compare:databases', (_e, connectionId: string) => {
    const config = connections.getConfig(connectionId)
    if (!config) throw new Error('Connection not found')
    return manager.fetchDatabases(config, connections.getPassword(connectionId))
  })

  // ---- Schema sync ----
  const requireConfig = (connectionId: string) => {
    const config = connections.getConfig(connectionId)
    if (!config) throw new Error('Connection not found')
    return config
  }

  handle('compare:structure', (_e, connectionId: string, database: string) =>
    manager.fetchStructure(requireConfig(connectionId), connections.getPassword(connectionId), database)
  )

  handle('compare:createTables', (_e, connectionId: string, database: string, tables: string[]) =>
    manager.fetchCreateTables(
      requireConfig(connectionId),
      connections.getPassword(connectionId),
      database,
      tables
    )
  )

  handle('compare:apply', async (_e, connectionId: string, database: string, statements: string[]) => {
    const config = requireConfig(connectionId)
    const start = Date.now()
    const result = await manager.applyScript(
      config,
      connections.getPassword(connectionId),
      database,
      statements
    )
    history.add({
      connectionId,
      connectionName: `${config.name} · schema sync`,
      sql: statements.join(';\n') + ';',
      ok: !result.error,
      durationMs: Date.now() - start,
      error: result.error?.message
    })
    return result
  })

  // ---- Backup / restore (long-running jobs report progress on 'job:progress') ----
  const jobs = new Map<string, Job>()
  const SQL_FILTERS = [
    { name: 'SQL dump', extensions: ['sql', 'gz'] },
    { name: 'All files', extensions: ['*'] }
  ]

  handle(
    'backup:run',
    async (event, jobId: string, connectionId: string, database: string, opts: BackupOptions) => {
      const config = requireConfig(connectionId)
      let filePath = defaultBackupPath(config.name, database, opts.compress)
      if (opts.target === 'ask') {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        const res = await dialog.showSaveDialog(win!, {
          title: 'Save backup',
          defaultPath: filePath,
          filters: [
            opts.compress
              ? { name: 'Compressed SQL dump', extensions: ['gz'] }
              : { name: 'SQL dump', extensions: ['sql'] }
          ]
        })
        if (res.canceled || !res.filePath) return null
        filePath = res.filePath
      }
      const job: Job = { cancelled: false }
      jobs.set(jobId, job)
      const start = Date.now()
      try {
        const result = await runBackup(
          config,
          connections.getPassword(connectionId),
          database,
          filePath,
          opts.includeData,
          job,
          (p) => event.sender.send('job:progress', { ...p, jobId })
        )
        history.add({
          connectionId,
          connectionName: `${config.name} · backup`,
          sql: `-- Backup of ${database} → ${result.filePath}`,
          ok: true,
          rowCount: result.rows,
          durationMs: Date.now() - start
        })
        return result
      } finally {
        jobs.delete(jobId)
      }
    }
  )

  handle('job:cancel', (_e, jobId: string) => {
    const job = jobs.get(jobId)
    if (job) job.cancelled = true
  })

  handle('restore:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose a backup to restore',
      properties: ['openFile'],
      filters: SQL_FILTERS
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return inspectBackup(res.filePaths[0])
  })

  handle(
    'restore:run',
    async (
      event,
      jobId: string,
      connectionId: string,
      database: string,
      filePath: string,
      opts: RestoreOptions
    ) => {
      const config = requireConfig(connectionId)
      if (!database.trim()) throw new Error('Choose a target database')
      const job: Job = { cancelled: false }
      jobs.set(jobId, job)
      try {
        const result = await runRestore(
          config,
          connections.getPassword(connectionId),
          database.trim(),
          filePath,
          opts,
          job,
          (p) => event.sender.send('job:progress', { ...p, jobId })
        )
        history.add({
          connectionId,
          connectionName: `${config.name} · restore`,
          sql: `-- Restore ${filePath} → ${database}`,
          ok: !result.failed && !result.cancelled,
          rowCount: result.statements,
          durationMs: result.durationMs,
          error: result.errors[0]?.message
        })
        return result
      } finally {
        jobs.delete(jobId)
      }
    }
  )

  handle('shell:showItem', (_e, filePath: string) => shell.showItemInFolder(filePath))

  // ---- Export ----
  handle('export:save', async (event, payload: ExportPayload) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const ext = payload.format
    const base = payload.suggestedName ?? 'result'
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: `${base}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (canceled || !filePath) return { saved: false }

    if (payload.format === 'csv') await writeCsv(filePath, payload.columns, payload.rows)
    else if (payload.format === 'json') await writeJson(filePath, payload.rows)
    else await writeXlsx(filePath, payload.columns, payload.rows)

    return { saved: true, path: filePath }
  })

  // ---- History ----
  handle('history:list', () => history.list())
  handle('history:clear', () => history.clear())

  // ---- Saved queries ----
  handle('saved:list', () => savedQueries.list())
  handle('saved:add', (_e, name: string, sql: string, dbType?: DbType) =>
    savedQueries.add({ name, sql, dbType })
  )
  handle('saved:delete', (_e, id: string) => savedQueries.remove(id))
}
