import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { SavedQuery } from '../../shared/types'
import { dataFile } from './paths'

const FILE = (): string => dataFile('saved-queries.json')

function readAll(): SavedQuery[] {
  const file = FILE()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(items: SavedQuery[]): void {
  writeFileSync(FILE(), JSON.stringify(items, null, 2), 'utf-8')
}

export function list(): SavedQuery[] {
  return readAll().sort((a, b) => b.ts - a.ts)
}

export function add(entry: { name: string; sql: string; dbType?: SavedQuery['dbType'] }): SavedQuery {
  const full: SavedQuery = { ...entry, id: randomUUID(), ts: Date.now() }
  writeAll([full, ...readAll()])
  return full
}

export function remove(id: string): void {
  writeAll(readAll().filter((q) => q.id !== id))
}
