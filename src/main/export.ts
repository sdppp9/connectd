import { writeFile } from 'fs/promises'
import ExcelJS from 'exceljs'

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

export async function writeCsv(
  path: string,
  columns: string[],
  rows: Record<string, unknown>[]
): Promise<void> {
  const lines: string[] = []
  lines.push(columns.map((c) => csvEscape(c)).join(','))
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(cellToString(row[c]))).join(','))
  }
  // Prepend BOM so Excel opens UTF-8 correctly.
  await writeFile(path, '﻿' + lines.join('\r\n'), 'utf-8')
}

export async function writeJson(path: string, rows: Record<string, unknown>[]): Promise<void> {
  await writeFile(path, JSON.stringify(rows, null, 2), 'utf-8')
}

export async function writeXlsx(
  path: string,
  columns: string[],
  rows: Record<string, unknown>[]
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Result')

  ws.columns = columns.map((c) => ({ header: c, key: c }))
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEF2FF' }
  }

  for (const row of rows) {
    const record: Record<string, unknown> = {}
    for (const c of columns) {
      const v = row[c]
      record[c] = v === null || v === undefined ? '' : v instanceof Date ? v : typeof v === 'object' ? JSON.stringify(v) : v
    }
    ws.addRow(record)
  }

  // Auto-fit column widths (bounded).
  ws.columns.forEach((col) => {
    let max = String(col.header ?? '').length
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = cellToString(cell.value).length
      if (len > max) max = len
    })
    col.width = Math.min(Math.max(max + 2, 10), 60)
  })

  await wb.xlsx.writeFile(path)
}
