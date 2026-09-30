import { createWriteStream, unlink, type WriteStream } from 'fs'
import { createGzip, type Gzip } from 'zlib'
import { once } from 'events'

/** Thrown when the user cancels a running backup / restore. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

export interface Job {
  cancelled: boolean
}

export function checkCancelled(job: Job): void {
  if (job.cancelled) throw new CancelledError()
}

/** Buffered, back-pressure aware writer for .sql / .sql.gz dump files. */
export class DumpWriter {
  private file: WriteStream
  private gzip: Gzip | null
  private pending: string[] = []
  private pendingLen = 0
  /** Uncompressed bytes written so far. */
  bytes = 0

  constructor(
    readonly path: string,
    compress: boolean
  ) {
    this.file = createWriteStream(path)
    this.gzip = compress ? createGzip({ level: 6 }) : null
    if (this.gzip) this.gzip.pipe(this.file)
  }

  private get sink(): NodeJS.WritableStream {
    return this.gzip ?? this.file
  }

  async write(text: string): Promise<void> {
    this.pending.push(text)
    this.pendingLen += text.length
    if (this.pendingLen >= 256 * 1024) await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return
    const chunk = Buffer.from(this.pending.join(''), 'utf8')
    this.pending = []
    this.pendingLen = 0
    this.bytes += chunk.length
    if (!this.sink.write(chunk)) await once(this.sink as NodeJS.EventEmitter, 'drain')
  }

  async close(): Promise<void> {
    await this.flush()
    const done = once(this.file, 'close')
    this.sink.end()
    await done
  }

  /** Stops writing and deletes the partial file. */
  async abort(): Promise<void> {
    this.gzip?.destroy()
    this.file.destroy()
    await new Promise<void>((resolve) => unlink(this.path, () => resolve()))
  }
}

/** Calls `fn` at most every `ms` milliseconds (plus a final flush via `.flush()`). */
export function throttle<T>(fn: (v: T) => void, ms = 150): ((v: T) => void) & { flush: () => void } {
  let last = 0
  let queued: T | null = null
  const wrapped = ((v: T) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      queued = null
      fn(v)
    } else {
      queued = v
    }
  }) as ((v: T) => void) & { flush: () => void }
  wrapped.flush = () => {
    if (queued !== null) fn(queued)
    queued = null
  }
  return wrapped
}
