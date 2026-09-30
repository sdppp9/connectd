import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { HistoryEntry } from '../../shared/types'
import { dataFile } from './paths'

const FILE = (): string => dataFile('history.json')
const MAX_ENTRIES = 200

function readAll(): HistoryEntry[] {
  const file = FILE()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(items: HistoryEntry[]): void {
  writeFileSync(FILE(), JSON.stringify(items, null, 2), 'utf-8')
}

export function list(): HistoryEntry[] {
  return readAll()
}

export function add(entry: Omit<HistoryEntry, 'id' | 'ts'>): HistoryEntry {
  const full: HistoryEntry = { ...entry, id: randomUUID(), ts: Date.now() }
  const next = [full, ...readAll()].slice(0, MAX_ENTRIES)
  writeAll(next)
  return full
}

export function clear(): void {
  writeAll([])
}
