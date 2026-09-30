// Generates build/icon.png — a rounded indigo tile with a white database
// cylinder. Self-contained: uses only Node's zlib to encode the PNG.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 256
const W = SIZE
const H = SIZE
const buf = new Uint8Array(W * H * 4)

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  const na = a / 255
  const oa = buf[i + 3] / 255
  const outA = na + oa * (1 - na)
  if (outA === 0) return
  buf[i] = Math.round((r * na + buf[i] * oa * (1 - na)) / outA)
  buf[i + 1] = Math.round((g * na + buf[i + 1] * oa * (1 - na)) / outA)
  buf[i + 2] = Math.round((b * na + buf[i + 2] * oa * (1 - na)) / outA)
  buf[i + 3] = Math.round(outA * 255)
}

// Rounded-rect indigo background with a subtle vertical gradient.
const radius = 52
function inRounded(x, y) {
  const rx = Math.min(x, W - 1 - x)
  const ry = Math.min(y, H - 1 - y)
  if (rx >= radius || ry >= radius) return true
  const dx = radius - rx
  const dy = radius - ry
  return dx * dx + dy * dy <= radius * radius
}
for (let y = 0; y < H; y++) {
  const t = y / H
  const r = Math.round(99 - 20 * t) // 4f -> darker
  const g = Math.round(102 - 30 * t)
  const b = Math.round(241 - 20 * t)
  for (let x = 0; x < W; x++) {
    if (inRounded(x, y)) setPx(x, y, r, g, b, 255)
  }
}

// White database cylinder.
const cx = 128
const rx = 60
const ry = 20
const topY = 84
const botY = 176
function inEllipse(x, y, ey) {
  const nx = (x - cx) / rx
  const ny = (y - ey) / ry
  return nx * nx + ny * ny <= 1
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const body = x >= cx - rx && x <= cx + rx && y >= topY && y <= botY
    const bottomCap = inEllipse(x, y, botY)
    const inside = (body && !inEllipse(x, y, topY)) || bottomCap || inEllipse(x, y, topY)
    // Solid cylinder: top cap + body + bottom cap.
    if ((body || bottomCap || inEllipse(x, y, topY)) && inside) {
      setPx(x, y, 255, 255, 255, 255)
    }
  }
}
// Two indigo "bands" to suggest disk platters.
for (const bandY of [120, 150]) {
  for (let x = cx - rx; x <= cx + rx; x++) {
    for (let y = bandY - 2; y <= bandY + 2; y++) {
      if (inEllipse(x, y, bandY)) setPx(x, y, 79, 70, 229, 255)
    }
  }
}

// --- PNG encode ---
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}
function crc32(bytes) {
  let c = ~0
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0
  for (let x = 0; x < W * 4; x++) {
    raw[y * (W * 4 + 1) + 1 + x] = buf[y * W * 4 + x]
  }
}
const idat = deflateSync(raw)
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const out = join(dirname(fileURLToPath(import.meta.url)), 'icon.png')
writeFileSync(out, png)
console.log('Wrote', out, png.length, 'bytes')
