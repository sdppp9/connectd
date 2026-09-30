export interface DisplayValue {
  text: string
  isNull: boolean
}

/** Formats a raw cell value for display. */
export function formatCell(v: unknown): DisplayValue {
  if (v === null || v === undefined) return { text: 'NULL', isNull: true }
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', isNull: false }
  if (v instanceof Date) return { text: v.toISOString(), isNull: false }
  if (typeof v === 'object') return { text: JSON.stringify(v), isNull: false }
  return { text: String(v), isNull: false }
}

/** Value used inside an editable input (empty string for null). */
export function toEditString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v)
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** Loose equality for detecting whether an edit actually changed the value. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  return toEditString(a) === toEditString(b)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${Math.max(s, ms < 1000 ? 0 : 1)}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
