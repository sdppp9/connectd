// Wraps build/icon.png (256x256) into a single-image build/icon.ico.
// Modern Windows (Vista+) supports PNG-compressed ICO entries.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const png = readFileSync(join(dir, 'icon.png'))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // image count

const entry = Buffer.alloc(16)
entry.writeUInt8(0, 0) // width 0 => 256
entry.writeUInt8(0, 1) // height 0 => 256
entry.writeUInt8(0, 2) // color palette
entry.writeUInt8(0, 3) // reserved
entry.writeUInt16LE(1, 4) // color planes
entry.writeUInt16LE(32, 6) // bits per pixel
entry.writeUInt32LE(png.length, 8) // size of image data
entry.writeUInt32LE(6 + 16, 12) // offset of image data

writeFileSync(join(dir, 'icon.ico'), Buffer.concat([header, entry, png]))
console.log('Wrote build/icon.ico', 6 + 16 + png.length, 'bytes')
