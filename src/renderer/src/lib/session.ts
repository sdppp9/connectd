import type { DbType } from '../../../shared/types'

export interface PersistedTab {
  title: string
  sql: string
  connectionId: string | null
  connectionName: string | null
  dbType: DbType | null
  currentDatabase: string | null
}

export interface PersistedSession {
  tabs: PersistedTab[]
  activeIndex: number
}

const KEY = 'connectd.session'

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedSession
    if (!parsed || !Array.isArray(parsed.tabs)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveSession(session: PersistedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    // Ignore quota / private-mode failures — persistence is best-effort.
  }
}
