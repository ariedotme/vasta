// Width and height of an image from its header (PNG, JPEG, GIF, WebP), so pages can reserve the
// space before the picture loads. Anything else, or a header that does not parse, gives undefined.
export interface ImageSize {
  width: number
  height: number
}

export function imageSize(data: Uint8Array): ImageSize | undefined {
  try {
    return png(data) ?? jpeg(data) ?? gif(data) ?? webp(data)
  } catch {
    return undefined
  }
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength)
const ascii = (data: Uint8Array, start: number, length: number) => String.fromCharCode(...data.subarray(start, start + length))
const valid = (size: ImageSize) => (size.width > 0 && size.height > 0 ? size : undefined)

function png(data: Uint8Array): ImageSize | undefined {
  if (data.length < 24 || ascii(data, 1, 3) !== 'PNG' || ascii(data, 12, 4) !== 'IHDR') return undefined
  const v = view(data)
  return valid({ width: v.getUint32(16), height: v.getUint32(20) })
}

function gif(data: Uint8Array): ImageSize | undefined {
  if (data.length < 10 || ascii(data, 0, 3) !== 'GIF') return undefined
  const v = view(data)
  return valid({ width: v.getUint16(6, true), height: v.getUint16(8, true) })
}

/** Walk the JPEG segments to the first start-of-frame; EXIF rotation swaps the sides. */
function jpeg(data: Uint8Array): ImageSize | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined
  const v = view(data)
  let rotated = false
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined
    const marker = data[offset + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = v.getUint16(offset + 2)
    if (marker === 0xe1 && ascii(data, offset + 4, 4) === 'Exif') rotated = exifRotated(data, offset + 10)
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = v.getUint16(offset + 5)
      const width = v.getUint16(offset + 7)
      return valid(rotated ? { width: height, height: width } : { width, height })
    }
    offset += 2 + length
  }
  return undefined
}

/** Orientation 5–8 in the EXIF block means the picture is shown turned by 90°. */
function exifRotated(data: Uint8Array, tiff: number): boolean {
  if (tiff + 8 > data.length) return false
  const v = view(data)
  const little = ascii(data, tiff, 2) === 'II'
  const ifd = tiff + v.getUint32(tiff + 4, little)
  if (ifd + 2 > data.length) return false
  const count = v.getUint16(ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > data.length) return false
    if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little) >= 5
  }
  return false
}

function webp(data: Uint8Array): ImageSize | undefined {
  if (data.length < 30 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP') return undefined
  const v = view(data)
  const chunk = ascii(data, 12, 4)
  if (chunk === 'VP8 ') return valid({ width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff })
  if (chunk === 'VP8L') {
    const bits = v.getUint32(21, true)
    return valid({ width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 })
  }
  if (chunk === 'VP8X') {
    const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16))
    const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16))
    return valid({ width, height })
  }
  return undefined
}
