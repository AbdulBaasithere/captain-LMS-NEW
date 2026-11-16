export interface ParsedEmployeeRow {
  full_name: string
  email: string
  department: string
}

/**
 * Parses a simple CSV with a header row containing Name, Email, Department (any order, case-insensitive).
 * Handles basic quoted fields but not embedded newlines — fine for a standard spreadsheet export.
 */
export function parseEmployeeCsv(text: string): ParsedEmployeeRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) return []

  function splitLine(line: string): string[] {
    return line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''))
  }

  const header = splitLine(lines[0] as string).map((h) => h.toLowerCase())
  const nameIdx = header.findIndex((h) => h.includes('name'))
  const emailIdx = header.findIndex((h) => h.includes('email'))
  const deptIdx = header.findIndex((h) => h.includes('department'))
  if (nameIdx === -1 || emailIdx === -1) return []

  const rows: ParsedEmployeeRow[] = []
  for (const line of lines.slice(1)) {
    const cells = splitLine(line)
    const full_name = cells[nameIdx]?.trim()
    const email = cells[emailIdx]?.trim()
    const department = (deptIdx !== -1 ? cells[deptIdx]?.trim() : '') || 'General'
    if (!full_name || !email || !email.includes('@')) continue
    rows.push({ full_name, email, department })
  }
  return rows
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

export interface CsvSection {
  title?: string
  headers: string[]
  rows: unknown[][]
}

/**
 * Escapes a cell value according to RFC 4180 and guards string cells against
 * spreadsheet formula injection (=, +, -, @, tab, CR) when opened in Excel/Sheets.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''

  let str: string
  if (value instanceof Date) {
    str = Number.isNaN(value.getTime()) ? '' : value.toISOString()
  } else if (typeof value === 'boolean') {
    str = value ? 'Yes' : 'No'
  } else if (typeof value === 'number') {
    str = Number.isFinite(value) ? String(value) : ''
  } else {
    str = String(value)
    // Protect non-numeric strings starting with formula trigger chars
    if (/^[=+\-@\t\r]/.test(str) && !/^-\d+(\.\d+)?$/.test(str)) {
      str = `'${str}`
    }
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Serializes a typed data table into an RFC-4180 CSV string with optional UTF-8 BOM.
 */
export function serializeTableToCsv<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
  options: { includeBom?: boolean; lineEnding?: '\r\n' | '\n' } = {},
): string {
  const { includeBom = true, lineEnding = '\r\n' } = options
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(',')
  const bodyLines = rows.map((row) => columns.map((c) => escapeCsvCell(c.value(row))).join(','))
  const csv = [headerLine, ...bodyLines].join(lineEnding)
  return includeBom ? `\uFEFF${csv}` : csv
}

/**
 * Serializes one or more labeled KPI sections into a single offline CSV workbook.
 */
export function serializeSectionsToCsv(
  sections: readonly CsvSection[],
  options: { includeBom?: boolean; lineEnding?: '\r\n' | '\n' } = {},
): string {
  const { includeBom = true, lineEnding = '\r\n' } = options
  const blocks: string[] = []

  for (const section of sections) {
    const lines: string[] = []
    if (section.title) {
      lines.push(escapeCsvCell(section.title))
    }
    if (section.headers.length) {
      lines.push(section.headers.map(escapeCsvCell).join(','))
    }
    for (const row of section.rows) {
      lines.push(row.map(escapeCsvCell).join(','))
    }
    if (lines.length) {
      blocks.push(lines.join(lineEnding))
    }
  }

  const csv = blocks.join(`${lineEnding}${lineEnding}`)
  return includeBom ? `\uFEFF${csv}` : csv
}

/**
 * Triggers a client-side file download for a CSV string.
 */
export function downloadCsvFile(csvContent: string, filename: string): void {
  const safeName = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = safeName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Convenience helper to serialize a typed data table and download it as CSV.
 * Returns the number of data rows exported.
 */
export function exportTableToCsv<T>(params: {
  filename: string
  columns: readonly CsvColumn<T>[]
  rows: readonly T[]
}): number {
  const csv = serializeTableToCsv(params.columns, params.rows, { includeBom: true })
  downloadCsvFile(csv, params.filename)
  return params.rows.length
}

