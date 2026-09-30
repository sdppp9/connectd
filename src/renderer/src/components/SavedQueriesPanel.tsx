import { X, Trash2, BookMarked, Play } from 'lucide-react'
import type { SavedQuery } from '../../../shared/types'
import { IconButton } from './ui/Button'

interface Props {
  open: boolean
  items: SavedQuery[]
  onClose: () => void
  onPick: (sql: string) => void
  onDelete: (id: string) => void
}

export function SavedQueriesPanel({
  open,
  items,
  onClose,
  onPick,
  onDelete
}: Props): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onMouseDown={onClose}>
      <div
        className="flex h-full w-[420px] max-w-full flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-100">
            <BookMarked size={16} /> Saved queries
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {items.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-slate-400">
              No saved queries yet.
              <br />
              Use the bookmark button next to Run to save one.
            </div>
          )}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((q) => (
              <li key={q.id} className="group flex flex-col gap-1 px-4 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800/60">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onPick(q.sql)}
                    title="Load into editor"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Play size={12} className="shrink-0 text-indigo-500" />
                    <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                      {q.name}
                    </span>
                    {q.dbType && (
                      <span className="shrink-0 rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {q.dbType}
                      </span>
                    )}
                  </button>
                  <IconButton label="Delete" onClick={() => onDelete(q.id)}>
                    <Trash2 size={14} className="text-rose-500 opacity-0 group-hover:opacity-100" />
                  </IconButton>
                </div>
                <code
                  onClick={() => onPick(q.sql)}
                  className="line-clamp-2 cursor-pointer whitespace-pre-wrap break-words pl-5 font-mono text-xs text-slate-500 dark:text-slate-400"
                >
                  {q.sql}
                </code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
