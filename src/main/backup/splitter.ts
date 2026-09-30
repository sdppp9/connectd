import type { DbType } from '../../shared/types'

type Mode = 'normal' | 'single' | 'double' | 'backtick' | 'line' | 'block' | 'dollar'

const IDENT_CHAR = /[A-Za-z0-9_$]/
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/

/**
 * Streaming SQL script splitter. Feed text chunks with `push`, get back the
 * complete statements found so far (without the trailing delimiter).
 *
 * Understands quotes, comments, MySQL backslash escapes and `DELIMITER`
 * directives (mysqldump / our trigger + routine dumps), PostgreSQL
 * dollar-quoting and E'' strings, and skips psql meta-commands (`\connect`…).
 */
export class SqlSplitter {
  private buf = ''
  private pos = 0
  private start = 0
  private mode: Mode = 'normal'
  private tag = ''
  private escapes = false
  private delimiter = ';'
  /** The current statement has something besides whitespace and comments. */
  private content = false
  /** Lines skipped because they were client directives, not SQL. */
  skippedDirectives = 0

  constructor(private readonly dialect: DbType) {}

  push(chunk: string): string[] {
    this.buf += chunk
    return this.scan(false)
  }

  end(): string[] {
    const out = this.scan(true)
    const rest = this.buf.slice(this.start).trim()
    if (rest && this.content) out.push(rest)
    this.buf = ''
    this.pos = this.start = 0
    this.content = false
    return out
  }

  private emit(out: string[], end: number, next: number): void {
    const stmt = this.buf.slice(this.start, end).trim()
    if (stmt && this.content) out.push(stmt)
    this.pos = next
    this.start = next
    this.content = false
  }

  private scan(final: boolean): string[] {
    const out: string[] = []
    const b = this.buf
    const len = b.length
    // Returns false when more input is needed to decide.
    const have = (n: number): boolean => final || this.pos + n <= len

    scan: while (this.pos < len) {
      const ch = b[this.pos]
      switch (this.mode) {
        case 'normal': {
          const lineStart = this.pos === 0 || b[this.pos - 1] === '\n'
          if (!this.content && lineStart && (ch === 'D' || ch === 'd' || ch === '\\')) {
            let eol = b.indexOf('\n', this.pos)
            if (eol < 0) {
              if (!final) break scan
              eol = len
            }
            const line = b.slice(this.pos, eol)
            const delim = this.dialect === 'mysql' ? line.match(/^DELIMITER\s+(\S+)\s*$/i) : null
            if (delim || (this.dialect === 'postgres' && ch === '\\')) {
              if (delim) this.delimiter = delim[1]
              this.skippedDirectives++
              this.pos = this.start = Math.min(eol + 1, len)
              continue
            }
          }
          if (ch === this.delimiter[0]) {
            if (!have(this.delimiter.length)) break scan
            if (b.startsWith(this.delimiter, this.pos)) {
              this.emit(out, this.pos, this.pos + this.delimiter.length)
              continue
            }
          }
          if (ch === '-' || ch === '/' || (ch === '$' && this.dialect === 'postgres')) {
            if (!have(ch === '$' ? 66 : 3)) break scan
          }
          if (ch === '-' && b[this.pos + 1] === '-') {
            // MySQL needs whitespace after "--"; PostgreSQL does not.
            const after = b[this.pos + 2]
            if (this.dialect === 'postgres' || after === undefined || /\s/.test(after)) {
              this.mode = 'line'
              this.pos += 2
              continue
            }
          }
          if (ch === '#' && this.dialect === 'mysql') {
            this.mode = 'line'
            this.pos++
            continue
          }
          if (ch === '/' && b[this.pos + 1] === '*') {
            // /*! … */ and /*+ … */ are executed by MySQL, so they count as content.
            if (b[this.pos + 2] === '!' || b[this.pos + 2] === '+') this.content = true
            this.mode = 'block'
            this.pos += 2
            continue
          }
          if (ch === "'") {
            const prev = b[this.pos - 1]
            const eStr =
              (prev === 'E' || prev === 'e') && !IDENT_CHAR.test(b[this.pos - 2] ?? ' ')
            this.escapes = this.dialect === 'mysql' || eStr
            this.mode = 'single'
            this.content = true
            this.pos++
            continue
          }
          if (ch === '"') {
            this.escapes = this.dialect === 'mysql'
            this.mode = 'double'
            this.content = true
            this.pos++
            continue
          }
          if (ch === '`' && this.dialect === 'mysql') {
            this.mode = 'backtick'
            this.content = true
            this.pos++
            continue
          }
          if (ch === '$' && this.dialect === 'postgres' && !IDENT_CHAR.test(b[this.pos - 1] ?? ' ')) {
            const m = b.slice(this.pos, this.pos + 66).match(DOLLAR_TAG)
            if (m) {
              this.tag = m[0]
              this.mode = 'dollar'
              this.content = true
              this.pos += m[0].length
              continue
            }
          }
          if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') this.content = true
          this.pos++
          break
        }

        case 'single':
        case 'double':
        case 'backtick': {
          const q = this.mode === 'single' ? "'" : this.mode === 'double' ? '"' : '`'
          const nextQ = b.indexOf(q, this.pos)
          const nextE = this.escapes && this.mode !== 'backtick' ? b.indexOf('\\', this.pos) : -1
          if (nextE >= 0 && (nextQ < 0 || nextE < nextQ)) {
            if (!final && nextE + 2 > len) {
              this.pos = nextE
              break scan
            }
            this.pos = nextE + 2
            continue
          }
          if (nextQ < 0) {
            this.pos = len
            break scan
          }
          if (nextQ + 1 >= len && !final) {
            this.pos = nextQ
            break scan
          }
          if (b[nextQ + 1] === q) {
            this.pos = nextQ + 2 // doubled quote = escaped quote
            continue
          }
          this.mode = 'normal'
          this.pos = nextQ + 1
          break
        }

        case 'line': {
          const eol = b.indexOf('\n', this.pos)
          if (eol < 0) {
            this.pos = len
            break scan
          }
          this.mode = 'normal'
          this.pos = eol + 1
          break
        }

        case 'block': {
          const end = b.indexOf('*/', this.pos)
          if (end < 0) {
            this.pos = Math.max(this.pos, len - 1)
            break scan
          }
          this.mode = 'normal'
          this.pos = end + 2
          break
        }

        case 'dollar': {
          const end = b.indexOf(this.tag, this.pos)
          if (end < 0) {
            this.pos = Math.max(this.pos, len - this.tag.length + 1)
            break scan
          }
          this.mode = 'normal'
          this.pos = end + this.tag.length
          break
        }
      }
    }

    // Drop what has been consumed so the buffer only holds the pending statement.
    if (this.start > 0) {
      this.buf = this.buf.slice(this.start)
      this.pos -= this.start
      this.start = 0
    }
    return out
  }
}
