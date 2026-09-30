import { X, Trash2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import type { HistoryEntry } from '../../../shared/types'
import { Button, IconButton } from './ui/Button'

interface Props {
  open: boolean
  entries: HistoryEntry[]
  onClose: () => void
  onPick: (sql: string) => void
  onClear: () => void
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleString()
}

export function HistoryPanel({ open, entries, onClose, onPick, onClear }: Props): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onMouseDown={onClose}>
      <div
        className="flex h-full w-[420px] max-w-full flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-100">
            <Clock size={16} /> Query history
          </h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={onClear} icon={<Trash2 size={14} />}>
              Clear
            </Button>
            <IconButton label="Close" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {entries.length === 0 && (
            <div className="py-10 text-center text-sm text-slate-400">No history yet</div>
          )}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {entries.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => onPick(e.sql)}
                  className="flex w-full flex-col gap-1 px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800/60"
                >
                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    {e.ok ? (
                      <CheckCircle2 size={12} className="text-emerald-500" />
                    ) : (
                      <XCircle size={12} className="text-rose-500" />
                    )}
                    <span className="font-medium text-slate-500 dark:text-slate-400">
                      {e.connectionName}
                    </span>
                    <span>· {timeAgo(e.ts)}</span>
                    {e.ok && e.rowCount !== undefined && <span>· {e.rowCount} rows</span>}
                    {e.durationMs !== undefined && <span>· {e.durationMs} ms</span>}
                  </div>
                  <code className="line-clamp-2 whitespace-pre-wrap break-words font-mono text-xs text-slate-600 dark:text-slate-300">
                    {e.sql}
                  </code>
                  {!e.ok && e.error && (
                    <span className="text-[11px] text-rose-500">{e.error}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
