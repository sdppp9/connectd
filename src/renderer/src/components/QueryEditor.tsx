import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql, MySQL, PostgreSQL, type SQLDialect } from '@codemirror/lang-sql'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { acceptCompletion } from '@codemirror/autocomplete'
import type { DbType, SchemaSnapshot } from '../../../shared/types'
import { buildCmSchema, pickDefaultSchema } from '../lib/sqlSchema'
import { clamp, readNumberPref, writePref } from '../lib/prefs'

const FONT_KEY = 'connectd.editorFontSize'
const FONT_DEFAULT = 13
const FONT_MIN = 9
const FONT_MAX = 32
/** Wheel delta per step: one mouse-wheel notch (~100) = 1px; touchpad pinches accumulate. */
const WHEEL_STEP = 100

interface Props {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  schema: SchemaSnapshot | null
  currentDatabase: string | null
  dbType: DbType | null
  dark: boolean
  disabled?: boolean
  /** Receives the selected text ('' when nothing is selected). */
  onSelectionChange?: (text: string) => void
}

export function QueryEditor({
  value,
  onChange,
  onRun,
  schema,
  currentDatabase,
  dbType,
  dark,
  disabled,
  onSelectionChange
}: Props): React.JSX.Element {
  // Keep the latest onRun in a ref so the keymap always calls the current one.
  const runRef = useRef(onRun)
  runRef.current = onRun
  const selectionRef = useRef(onSelectionChange)
  selectionRef.current = onSelectionChange

  // Ctrl/Cmd + mouse wheel changes the editor font size (remembered between runs).
  const wrapRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [fontSize, setFontSize] = useState(() => readNumberPref(FONT_KEY, FONT_DEFAULT, FONT_MIN, FONT_MAX))
  const [showSize, setShowSize] = useState(false)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let acc = 0
    let hide: ReturnType<typeof setTimeout> | undefined
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault() // otherwise Chromium zooms the whole window
      acc += e.deltaY
      if (Math.abs(acc) < WHEEL_STEP) return
      const steps = Math.trunc(acc / WHEEL_STEP)
      acc -= steps * WHEEL_STEP
      setFontSize((s) => {
        const next = clamp(s - steps, FONT_MIN, FONT_MAX)
        writePref(FONT_KEY, next)
        return next
      })
      setShowSize(true)
      clearTimeout(hide)
      hide = setTimeout(() => setShowSize(false), 1200)
    }
    // Non-passive so preventDefault works.
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      clearTimeout(hide)
    }
  }, [])
  // Line heights are cached by CodeMirror; re-measure after the font changes.
  useEffect(() => {
    viewRef.current?.requestMeasure()
  }, [fontSize])

  const extensions = useMemo(() => {
    const dialect: SQLDialect = dbType === 'postgres' ? PostgreSQL : MySQL
    const cmSchema = buildCmSchema(schema)
    const defaultSchema = pickDefaultSchema(schema, currentDatabase)
    return [
      sql({ dialect, schema: cmSchema, defaultSchema, upperCaseKeywords: true }),
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet && !u.docChanged) return
        const { from, to } = u.state.selection.main
        selectionRef.current?.(from === to ? '' : u.state.sliceDoc(from, to))
      }),
      Prec.highest(
        keymap.of([
          // Tab accepts the highlighted suggestion (Enter still works too). With no
          // popup open acceptCompletion returns false and Tab indents as usual.
          { key: 'Tab', run: acceptCompletion },
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              runRef.current()
              return true
            }
          }
        ])
      )
    ]
    // Rebuild when schema, database, or dialect changes.
  }, [schema, currentDatabase, dbType])

  return (
    <div
      ref={wrapRef}
      className="relative h-full"
      style={{ '--sql-font-size': `${fontSize}px` } as React.CSSProperties}
    >
    <CodeMirror
      value={value}
      onCreateEditor={(view) => (viewRef.current = view)}
      onChange={onChange}
      theme={dark ? 'dark' : 'light'}
      extensions={extensions}
      editable={!disabled}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true
      }}
      height="100%"
      style={{ height: '100%' }}
    />
      {showSize && (
        <div className="pointer-events-none absolute right-3 top-2 rounded bg-slate-900/80 px-2 py-0.5 text-[11px] text-white">
          {fontSize}px
        </div>
      )}
    </div>
  )
}
