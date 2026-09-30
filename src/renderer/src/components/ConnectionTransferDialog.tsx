import { useEffect, useMemo, useState } from 'react'
import { FileOutput, FileInput, KeyRound, Eye, EyeOff, AlertTriangle, Loader2 } from 'lucide-react'
import type { ConnectionConfig, ImportOptions, ImportPreview } from '../../../shared/types'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { useToast } from './ui/Toast'

const MIN_PASSPHRASE = 8

const inputCls =
  'h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
const selCls =
  'h-8 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200'

function PassphraseInput({
  value,
  onChange,
  placeholder,
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input
        type={shown ? 'text' : 'password'}
        className={`${inputCls} pr-8`}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown((s) => !s)}
        title={shown ? 'Hide' : 'Show'}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
      >
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

/** Checkbox list shared by export and import. */
function PickList<T>({
  items,
  selected,
  onToggle,
  onToggleAll,
  render
}: {
  items: T[]
  selected: Set<number>
  onToggle: (i: number) => void
  onToggleAll: (all: boolean) => void
  render: (item: T) => React.ReactNode
}): React.JSX.Element {
  const all = items.length > 0 && selected.size === items.length
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-700">
      <label className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
        <input type="checkbox" checked={all} onChange={(e) => onToggleAll(e.target.checked)} />
        {selected.size} of {items.length} selected
      </label>
      <ul className="max-h-64 overflow-auto py-1">
        {items.map((item, i) => (
          <li key={i}>
            <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800/60">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(i)}
                onChange={() => onToggle(i)}
              />
              <div className="min-w-0 flex-1">{render(item)}</div>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

function useSelection(count: number, initial: (i: number) => boolean = () => true) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  useEffect(() => {
    setSelected(new Set([...Array(count).keys()].filter(initial)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count])
  return {
    selected,
    toggle: (i: number) =>
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      }),
    toggleAll: (all: boolean) => setSelected(all ? new Set([...Array(count).keys()]) : new Set())
  }
}

function ConnLine({
  name,
  type,
  host,
  port,
  user,
  database,
  hasPassword
}: {
  name: string
  type: string
  host: string
  port: number
  user: string
  database?: string
  hasPassword?: boolean
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium text-slate-700 dark:text-slate-200">{name}</span>
        {hasPassword && (
          <span title="Has a saved password">
            <KeyRound size={12} className="shrink-0 text-amber-500" />
          </span>
        )}
      </div>
      <div className="truncate text-[11px] text-slate-400">
        {type} · {user}@{host}:{port}
        {database ? ` / ${database}` : ''}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- Export

export function ExportConnectionsDialog({
  open,
  connections,
  onClose
}: {
  open: boolean
  connections: ConnectionConfig[]
  onClose: () => void
}): React.JSX.Element | null {
  const toast = useToast()
  const sel = useSelection(open ? connections.length : 0)
  const [withPasswords, setWithPasswords] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setWithPasswords(false)
      setPass('')
      setPass2('')
    }
  }, [open])

  const chosen = connections.filter((_, i) => sel.selected.has(i))
  const passwordCount = chosen.filter((c) => c.hasPassword).length
  const includePasswords = withPasswords && passwordCount > 0
  const passError = !includePasswords
    ? null
    : pass.length < MIN_PASSPHRASE
      ? `At least ${MIN_PASSPHRASE} characters`
      : pass !== pass2
        ? 'Passphrases do not match'
        : null

  const run = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.exportConnections(
      chosen.map((c) => c.id),
      includePasswords ? pass : undefined
    )
    setBusy(false)
    if (!res.ok) return toast.error(res.error)
    if (!res.data.saved) return
    const pw = res.data.passwords ? ` (${res.data.passwords} with password)` : ' (no passwords)'
    toast.success(`Exported ${res.data.count} connection(s)${pw}`)
    onClose()
  }

  return (
    <Modal
      open={open}
      title="Export connections"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={busy ? <Loader2 size={15} className="animate-spin" /> : <FileOutput size={15} />}
            disabled={busy || chosen.length === 0 || !!passError}
            onClick={run}
          >
            Export {chosen.length || ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <PickList
          items={connections}
          selected={sel.selected}
          onToggle={sel.toggle}
          onToggleAll={sel.toggleAll}
          render={(c) => <ConnLine {...c} />}
        />

        <label
          className={`flex items-center gap-2 text-sm ${passwordCount === 0 ? 'opacity-50' : ''}`}
        >
          <input
            type="checkbox"
            disabled={passwordCount === 0}
            checked={includePasswords}
            onChange={(e) => setWithPasswords(e.target.checked)}
          />
          Include saved passwords
          <span className="text-xs text-slate-400">({passwordCount} saved)</span>
        </label>

        {includePasswords ? (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Passwords are encrypted with this passphrase (never stored as plain text). Whoever imports
              the file needs it. Send the passphrase separately, not together with the file.
            </p>
            <PassphraseInput value={pass} onChange={setPass} placeholder="Passphrase" autoFocus />
            <PassphraseInput value={pass2} onChange={setPass2} placeholder="Repeat passphrase" />
            {passError && (pass || pass2) && <p className="text-xs text-rose-500">{passError}</p>}
          </div>
        ) : (
          <p className="text-xs text-slate-400">
            Without passwords, the recipient adds them with <b>Edit</b> after importing.
          </p>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- Import

export function ImportConnectionsDialog({
  preview,
  onClose,
  onImported
}: {
  preview: ImportPreview | null
  onClose: () => void
  onImported: () => void
}): React.JSX.Element | null {
  const toast = useToast()
  const items = useMemo(() => preview?.items ?? [], [preview])
  const sel = useSelection(items.length)
  const [duplicates, setDuplicates] = useState<ImportOptions['duplicates']>('skip')
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDuplicates('skip')
    setPass('')
    setError(null)
  }, [preview])

  if (!preview) return null
  const dupCount = items.filter((it, i) => it.existingName && sel.selected.has(i)).length
  const fileName = preview.filePath.split(/[\\/]/).pop()

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await window.api.importConnections(preview.filePath, {
      indexes: [...sel.selected],
      duplicates,
      passphrase: preview.encrypted && pass ? pass : undefined
    })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    const r = res.data
    const parts = [
      r.added && `${r.added} added`,
      r.replaced && `${r.replaced} replaced`,
      r.skipped && `${r.skipped} skipped (already saved)`
    ].filter(Boolean)
    toast.success(`Import done: ${parts.join(', ') || 'nothing to import'}`)
    if (r.passwordsNotStored) {
      toast.error(`${r.passwordsNotStored} password(s) could not be stored — OS encryption is unavailable`)
    }
    onImported()
    onClose()
  }

  return (
    <Modal
      open
      title="Import connections"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={busy ? <Loader2 size={15} className="animate-spin" /> : <FileInput size={15} />}
            disabled={busy || sel.selected.size === 0}
            onClick={run}
          >
            Import {sel.selected.size || ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs text-slate-400">
          <span className="font-medium text-slate-600 dark:text-slate-300">{fileName}</span>
          {preview.exportedAt && ` · exported ${new Date(preview.exportedAt).toLocaleString()}`}
        </div>

        <PickList
          items={items}
          selected={sel.selected}
          onToggle={sel.toggle}
          onToggleAll={sel.toggleAll}
          render={(it) => (
            <>
              <ConnLine {...it} />
              {it.existingName && (
                <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                  Already saved as “{it.existingName}”
                </div>
              )}
            </>
          )}
        />

        {dupCount > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600 dark:text-slate-300">
              {dupCount} already saved:
            </span>
            <select
              className={selCls}
              value={duplicates}
              onChange={(e) => setDuplicates(e.target.value as ImportOptions['duplicates'])}
            >
              <option value="skip">Skip them</option>
              <option value="replace">Replace (update name, SSL, password)</option>
              <option value="copy">Add as a copy</option>
            </select>
          </label>
        )}

        {preview.encrypted && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-slate-600 dark:text-slate-300">
              Passphrase for the passwords
            </label>
            <PassphraseInput value={pass} onChange={setPass} placeholder="Passphrase" autoFocus />
            <p className="text-xs text-slate-400">
              Leave empty to import without passwords (add them later with Edit).
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
