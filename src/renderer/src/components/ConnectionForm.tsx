import { useEffect, useState } from 'react'
import { Database, Plug, Loader2 } from 'lucide-react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { useToast } from './ui/Toast'
import type { ConnectionConfig, ConnectionInput, DbType } from '../../../shared/types'

interface Props {
  open: boolean
  editing: ConnectionConfig | null
  onClose: () => void
  onSaved: (saved: ConnectionConfig) => void
}

const DEFAULT_PORTS: Record<DbType, number> = { mysql: 3306, postgres: 5432 }

function blankForm(): ConnectionInput {
  return {
    name: '',
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    database: '',
    ssl: false
  }
}

export function ConnectionForm({ open, editing, onClose, onSaved }: Props): React.JSX.Element {
  const toast = useToast()
  const [form, setForm] = useState<ConnectionInput>(blankForm())
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (editing) {
      setForm({
        id: editing.id,
        name: editing.name,
        type: editing.type,
        host: editing.host,
        port: editing.port,
        user: editing.user,
        password: '',
        database: editing.database ?? '',
        ssl: editing.ssl ?? false
      })
    } else {
      setForm(blankForm())
    }
  }, [open, editing])

  function set<K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function onTypeChange(type: DbType): void {
    setForm((f) => {
      // Update port only if it still matches the other type's default.
      const wasDefault = f.port === DEFAULT_PORTS.mysql || f.port === DEFAULT_PORTS.postgres
      return { ...f, type, port: wasDefault ? DEFAULT_PORTS[type] : f.port }
    })
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    const res = await window.api.testConnection(form)
    setTesting(false)
    if (res.ok) toast.success('Connection successful')
    else toast.error(res.error)
  }

  async function handleSave(): Promise<void> {
    if (!form.name.trim()) {
      toast.error('Please enter a connection name')
      return
    }
    setSaving(true)
    const res = await window.api.saveConnection(form)
    setSaving(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.passwordNotStored) {
      toast.info('Saved, but OS encryption is unavailable so the password was not stored')
    } else {
      toast.success('Connection saved')
    }
    onSaved(res.data.config)
  }

  const inputCls =
    'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
  const labelCls = 'mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400'

  return (
    <Modal
      open={open}
      title={editing ? 'Edit connection' : 'New connection'}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={handleTest}
            disabled={testing || saving}
            icon={testing ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />}
          >
            Test
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className={labelCls}>Name</label>
          <input
            className={inputCls}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="My database"
          />
        </div>

        <div className="col-span-2">
          <label className={labelCls}>Type</label>
          <div className="flex gap-2">
            {(['mysql', 'postgres'] as DbType[]).map((t) => (
              <button
                key={t}
                onClick={() => onTypeChange(t)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  form.type === t
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                    : 'border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:text-slate-400'
                }`}
              >
                <Database size={15} />
                {t === 'mysql' ? 'MySQL / MariaDB' : 'PostgreSQL'}
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-1">
          <label className={labelCls}>Host</label>
          <input className={inputCls} value={form.host} onChange={(e) => set('host', e.target.value)} />
        </div>
        <div className="col-span-1">
          <label className={labelCls}>Port</label>
          <input
            type="number"
            className={inputCls}
            value={form.port}
            onChange={(e) => set('port', Number(e.target.value))}
          />
        </div>

        <div className="col-span-1">
          <label className={labelCls}>User</label>
          <input className={inputCls} value={form.user} onChange={(e) => set('user', e.target.value)} />
        </div>
        <div className="col-span-1">
          <label className={labelCls}>
            Password {editing?.hasPassword && <span className="text-slate-400">(saved)</span>}
          </label>
          <input
            type="password"
            className={inputCls}
            value={form.password ?? ''}
            onChange={(e) => set('password', e.target.value)}
            placeholder={editing?.hasPassword ? '•••••• (unchanged)' : ''}
          />
        </div>

        <div className="col-span-2">
          <label className={labelCls}>Database (optional)</label>
          <input
            className={inputCls}
            value={form.database ?? ''}
            onChange={(e) => set('database', e.target.value)}
            placeholder="Leave empty to browse all"
          />
        </div>

        <div className="col-span-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={form.ssl ?? false}
              onChange={(e) => set('ssl', e.target.checked)}
              className="h-4 w-4 rounded border-slate-400 accent-indigo-600"
            />
            Use SSL
          </label>
        </div>
      </div>
    </Modal>
  )
}
