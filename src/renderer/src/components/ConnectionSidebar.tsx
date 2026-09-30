import { Plus, Database, Pencil, Trash2, Plug, PlugZap, Loader2, FileInput, FileOutput } from 'lucide-react'
import type { ConnectionConfig } from '../../../shared/types'
import { IconButton } from './ui/Button'

interface Props {
  connections: ConnectionConfig[]
  activeId: string | null
  connectingId: string | null
  onConnect: (c: ConnectionConfig) => void
  onDisconnect: (c: ConnectionConfig) => void
  onEdit: (c: ConnectionConfig) => void
  onDelete: (c: ConnectionConfig) => void
  onNew: () => void
  onImport: () => void
  onExport: () => void
}

export function ConnectionSidebar({
  connections,
  activeId,
  connectingId,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onNew,
  onImport,
  onExport
}: Props): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Connections
        </span>
        <div className="flex items-center">
          <IconButton label="Import connections" onClick={onImport}>
            <FileInput size={15} />
          </IconButton>
          <IconButton
            label="Export connections"
            onClick={onExport}
            disabled={connections.length === 0}
          >
            <FileOutput size={15} />
          </IconButton>
          <IconButton label="New connection" onClick={onNew}>
            <Plus size={16} />
          </IconButton>
        </div>
      </div>

      {connections.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-slate-400">
          No connections yet.
          <br />
          Click <span className="font-semibold">+</span> to add one,
          <br />
          or{' '}
          <button className="font-semibold text-indigo-500 hover:underline" onClick={onImport}>
            import a file
          </button>
          .
        </div>
      )}

      <ul className="flex flex-col gap-0.5 px-2">
        {connections.map((c) => {
          const active = c.id === activeId
          const connecting = c.id === connectingId
          return (
            <li
              key={c.id}
              className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-200'
                  : 'text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-700/40'
              }`}
            >
              <Database
                size={15}
                className={active ? 'text-indigo-500' : 'text-slate-400'}
              />
              <button
                className="flex min-w-0 flex-1 flex-col items-start text-left"
                onClick={() => (active ? undefined : onConnect(c))}
                title={`${c.user}@${c.host}:${c.port}`}
              >
                <span className="w-full truncate font-medium">{c.name}</span>
                <span className="w-full truncate text-[11px] text-slate-400">
                  {c.type} · {c.host}
                </span>
              </button>

              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                {connecting ? (
                  <Loader2 size={15} className="mx-1.5 animate-spin text-indigo-500" />
                ) : active ? (
                  <IconButton label="Disconnect" onClick={() => onDisconnect(c)}>
                    <PlugZap size={15} className="text-emerald-500" />
                  </IconButton>
                ) : (
                  <IconButton label="Connect" onClick={() => onConnect(c)}>
                    <Plug size={15} />
                  </IconButton>
                )}
                <IconButton label="Edit" onClick={() => onEdit(c)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton label="Delete" onClick={() => onDelete(c)}>
                  <Trash2 size={14} className="text-rose-500" />
                </IconButton>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
