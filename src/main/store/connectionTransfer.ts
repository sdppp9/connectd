import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto'
import type { DbType, ImportPreviewItem } from '../../shared/types'

/**
 * Portable connection file (export / import between machines).
 *
 * Saved passwords are encrypted with the OS keychain, which only works on the
 * machine that stored them, so an export either leaves passwords out or
 * re-encrypts them with a passphrase the user chooses (scrypt → AES-256-GCM).
 * Passwords are never written as plain text.
 */

export const FILE_FORMAT = 'connectd-connections'
const FILE_VERSION = 1
const MAX_CONNECTIONS = 1000
export const MIN_PASSPHRASE = 8
/** Encrypted with the key so a wrong passphrase is caught even without passwords. */
const CHECK_TEXT = 'connectd'

interface Sealed {
  iv: string
  tag: string
  data: string
}

interface KdfParams {
  name: 'scrypt'
  salt: string
  N: number
  r: number
  p: number
}

interface FileConnection {
  name: string
  type: DbType
  host: string
  port: number
  user: string
  database?: string
  ssl?: boolean
  password?: Sealed
}

export interface ConnectionFile {
  format: typeof FILE_FORMAT
  version: number
  exportedAt: string
  kdf?: KdfParams
  check?: Sealed
  connections: FileConnection[]
}

/** A connection as it moves in or out of the store (password in memory only). */
export interface PortableConnection {
  name: string
  type: DbType
  host: string
  port: number
  user: string
  database?: string
  ssl?: boolean
  password?: string
}

function deriveKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase,
      Buffer.from(kdf.salt, 'base64'),
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  )
}

function seal(key: Buffer, text: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

function open(key: Buffer, s: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}

/** Builds the export file. Passwords are included only when a passphrase is given. */
export async function buildConnectionFile(
  items: PortableConnection[],
  passphrase?: string
): Promise<ConnectionFile> {
  const file: ConnectionFile = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    connections: []
  }
  let key: Buffer | null = null
  if (passphrase !== undefined) {
    if (passphrase.length < MIN_PASSPHRASE) {
      throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`)
    }
    file.kdf = { name: 'scrypt', salt: randomBytes(16).toString('base64'), N: 1 << 15, r: 8, p: 1 }
    key = await deriveKey(passphrase, file.kdf)
    file.check = seal(key, CHECK_TEXT)
  }
  for (const c of items) {
    const out: FileConnection = {
      name: c.name,
      type: c.type,
      host: c.host,
      port: c.port,
      user: c.user
    }
    if (c.database) out.database = c.database
    if (c.ssl) out.ssl = true
    if (key && c.password) out.password = seal(key, c.password)
    file.connections.push(out)
  }
  return file
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isSealed = (v: unknown): v is Sealed =>
  !!v && typeof v === 'object' && isStr((v as Sealed).iv) && isStr((v as Sealed).tag) && isStr((v as Sealed).data)

/** Parses and validates an import file; throws a readable error when it isn't one. */
export function parseConnectionFile(text: string): ConnectionFile {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('Not a ConnectD connections file (invalid JSON)')
  }
  const f = raw as Partial<ConnectionFile>
  if (!f || typeof f !== 'object' || f.format !== FILE_FORMAT || !Array.isArray(f.connections)) {
    throw new Error('Not a ConnectD connections file')
  }
  if (typeof f.version !== 'number' || f.version > FILE_VERSION) {
    throw new Error('This file was made by a newer version of ConnectD')
  }
  if (f.connections.length > MAX_CONNECTIONS) throw new Error('Too many connections in file')

  const encrypted = f.connections.some((c) => c && (c as FileConnection).password !== undefined)
  if (encrypted || f.kdf) {
    const k = f.kdf
    const valid =
      !!k && k.name === 'scrypt' && isStr(k.salt) &&
      [k.N, k.r, k.p].every((n) => Number.isInteger(n) && n > 0) &&
      k.N <= 1 << 20 && k.r <= 32 && k.p <= 16 && isSealed(f.check)
    if (!valid) throw new Error('Connections file is damaged (encryption header)')
  }

  const connections = f.connections.map((c, i): FileConnection => {
    const where = `connection #${i + 1}`
    if (!c || typeof c !== 'object') throw new Error(`Invalid ${where}`)
    if (!isStr(c.name) || !c.name.trim()) throw new Error(`Invalid ${where}: missing name`)
    if (c.type !== 'mysql' && c.type !== 'postgres') throw new Error(`Invalid ${where}: unknown type`)
    if (!isStr(c.host) || !c.host.trim()) throw new Error(`Invalid ${where}: missing host`)
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
      throw new Error(`Invalid ${where}: bad port`)
    }
    if (!isStr(c.user)) throw new Error(`Invalid ${where}: missing user`)
    if (c.database !== undefined && !isStr(c.database)) throw new Error(`Invalid ${where}: bad database`)
    if (c.password !== undefined && !isSealed(c.password)) {
      throw new Error(`Invalid ${where}: damaged password`)
    }
    return {
      name: c.name.trim(),
      type: c.type,
      host: c.host.trim(),
      port: c.port,
      user: c.user,
      database: c.database || undefined,
      ssl: c.ssl === true,
      password: c.password
    }
  })
  return { ...(f as ConnectionFile), connections }
}

export function fileHasPasswords(file: ConnectionFile): boolean {
  return file.connections.some((c) => c.password)
}

/**
 * Decodes the connections. With `passphrase` the passwords are decrypted
 * (throws on a wrong passphrase); without it they are left out.
 */
export async function readConnectionFile(
  file: ConnectionFile,
  passphrase?: string
): Promise<PortableConnection[]> {
  let key: Buffer | null = null
  if (passphrase && file.kdf && file.check) {
    key = await deriveKey(passphrase, file.kdf)
    try {
      if (open(key, file.check) !== CHECK_TEXT) throw new Error()
    } catch {
      throw new Error('Wrong passphrase')
    }
  }
  return file.connections.map((c) => {
    const { password, ...rest } = c
    let plain: string | undefined
    if (key && password) {
      try {
        plain = open(key, password)
      } catch {
        throw new Error(`Password of "${c.name}" could not be decrypted (file damaged)`)
      }
    }
    return { ...rest, password: plain }
  })
}

/** Same server + login + default database ⇒ the same connection. */
export function connectionKey(c: {
  type: DbType
  host: string
  port: number
  user: string
  database?: string
}): string {
  return [c.type, c.host.toLowerCase(), c.port, c.user, c.database ?? ''].join('\u0000')
}

export function previewItems(
  file: ConnectionFile,
  existing: { id: string; name: string; type: DbType; host: string; port: number; user: string; database?: string }[]
): ImportPreviewItem[] {
  const byKey = new Map(existing.map((e) => [connectionKey(e), e]))
  return file.connections.map((c) => {
    const match = byKey.get(connectionKey(c))
    return {
      name: c.name,
      type: c.type,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      hasPassword: Boolean(c.password),
      existingName: match?.name
    }
  })
}
