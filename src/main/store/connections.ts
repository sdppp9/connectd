import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { ConnectionConfig, ConnectionInput, ImportOptions, ImportResult } from '../../shared/types'
import { dataFile } from './paths'
import { connectionKey, type PortableConnection } from './connectionTransfer'

interface StoredConnection {
  id: string
  name: string
  type: 'mysql' | 'postgres'
  host: string
  port: number
  user: string
  database?: string
  ssl?: boolean
  /** base64 of safeStorage-encrypted password. */
  encPassword?: string
}

const FILE = (): string => dataFile('connections.json')

function readAll(): StoredConnection[] {
  const file = FILE()
  if (!existsSync(file)) return []
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(items: StoredConnection[]): void {
  writeFileSync(FILE(), JSON.stringify(items, null, 2), 'utf-8')
}

function toConfig(s: StoredConnection): ConnectionConfig {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    host: s.host,
    port: s.port,
    user: s.user,
    database: s.database,
    ssl: s.ssl,
    hasPassword: Boolean(s.encPassword)
  }
}

export function list(): ConnectionConfig[] {
  return readAll().map(toConfig)
}

export function getConfig(id: string): ConnectionConfig | null {
  const found = readAll().find((c) => c.id === id)
  return found ? toConfig(found) : null
}

export function getPassword(id: string): string | undefined {
  const found = readAll().find((c) => c.id === id)
  if (!found?.encPassword) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(found.encPassword, 'base64'))
  } catch {
    return undefined
  }
}

export interface SaveOutcome {
  config: ConnectionConfig
  /** True when a password was provided but could not be encrypted/stored. */
  passwordNotStored: boolean
}

export function save(input: ConnectionInput): SaveOutcome {
  const items = readAll()
  const id = input.id ?? randomUUID()
  const existing = items.find((c) => c.id === id)

  let encPassword = existing?.encPassword
  let passwordNotStored = false

  if (input.password && input.password.length > 0) {
    if (safeStorage.isEncryptionAvailable()) {
      encPassword = safeStorage.encryptString(input.password).toString('base64')
    } else {
      passwordNotStored = true
    }
  }

  const record: StoredConnection = {
    id,
    name: input.name,
    type: input.type,
    host: input.host,
    port: input.port,
    user: input.user,
    database: input.database || undefined,
    ssl: input.ssl,
    encPassword
  }

  const next = existing ? items.map((c) => (c.id === id ? record : c)) : [...items, record]
  writeAll(next)
  return { config: toConfig(record), passwordNotStored }
}

export function remove(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id))
}

// ---- Export / import ----

function decrypt(enc: string | undefined): string | undefined {
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

/** The chosen connections (in saved order) with their passwords decrypted in memory. */
export function portable(ids: string[]): PortableConnection[] {
  const wanted = new Set(ids)
  return readAll()
    .filter((c) => wanted.has(c.id))
    .map((c) => ({
      name: c.name,
      type: c.type,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      ssl: c.ssl,
      password: decrypt(c.encPassword)
    }))
}

/** Adds imported connections; matches on server + user + database decide duplicates. */
export function importMany(
  incoming: PortableConnection[],
  duplicates: ImportOptions['duplicates']
): ImportResult {
  const items = readAll()
  const byKey = new Map(items.map((c) => [connectionKey(c), c]))
  const names = new Set(items.map((c) => c.name.toLowerCase()))
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const result: ImportResult = { added: 0, replaced: 0, skipped: 0, passwords: 0, passwordsNotStored: 0 }

  const encrypt = (password: string | undefined): string | undefined => {
    if (!password) return undefined
    if (!canEncrypt) {
      result.passwordsNotStored++
      return undefined
    }
    result.passwords++
    return safeStorage.encryptString(password).toString('base64')
  }
  const uniqueName = (name: string): string => {
    let candidate = name
    for (let n = 2; names.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`
    names.add(candidate.toLowerCase())
    return candidate
  }

  for (const c of incoming) {
    const key = connectionKey(c)
    const match = byKey.get(key)
    if (match && duplicates === 'skip') {
      result.skipped++
      continue
    }
    if (match && duplicates === 'replace') {
      // Keep the id so open tabs stay attached; keep the old password if the file has none.
      if (c.name.toLowerCase() !== match.name.toLowerCase()) {
        names.delete(match.name.toLowerCase())
        match.name = uniqueName(c.name)
      }
      match.ssl = c.ssl
      match.encPassword = encrypt(c.password) ?? match.encPassword
      result.replaced++
      continue
    }
    const record: StoredConnection = {
      id: randomUUID(),
      name: uniqueName(c.name),
      type: c.type,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database || undefined,
      ssl: c.ssl,
      encPassword: encrypt(c.password)
    }
    items.push(record)
    if (!match) byKey.set(key, record)
    result.added++
  }

  writeAll(items)
  return result
}
