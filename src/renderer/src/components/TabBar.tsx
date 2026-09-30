import { Plus, X, Database, Circle } from 'lucide-react'
import type { DbType } from '../../../shared/types'

export interface TabMeta {
  id: string
  title: string
  dbType: DbType | null
  connected: boolean
}

interface Props {
  tabs: TabMeta[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function TabBar({ tabs, activeId, onSelect, onClose, onNew }: Props): React.JSX.Element {
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto border-b border-slate-200 bg-slate-100 px-1.5 pt-1.5 dark:border-slate-800 dark:bg-slate-950/60">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            onMouseDown={() => onSelect(tab.id)}
            className={`group flex min-w-[130px] max-w-[220px] cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-sm transition-colors ${
              active
                ? 'border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
                : 'border-transparent text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-800/60'
            }`}
          >
            {tab.connected ? (
              <Circle size={8} className="shrink-0 fill-emerald-500 text-emerald-500" />
            ) : (
              <Database size={13} className="shrink-0 text-slate-400" />
            )}
            <span className="flex-1 truncate">{tab.title}</span>
            <button
              onMouseDown={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              className="shrink-0 rounded p-0.5 text-slate-400 opacity-0 hover:bg-slate-300/60 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-slate-700 dark:hover:text-slate-200"
              aria-label="Close tab"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
      <button
        onClick={onNew}
        title="New tab"
        aria-label="New tab"
        className="mb-1 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <Plus size={16} />
      </button>
    </div>
  )
}
