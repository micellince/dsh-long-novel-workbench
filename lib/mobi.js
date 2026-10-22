/**
 * MOBI / PalmDOC 解析（纯 JS，无外部依赖）。
 *
 * 支持未加密、compression=1（无压缩）或 2（PalmDOC LZ77）的 MOBI；
 * HUFF/CDIC（17480）会标记 HUFF，由调用方决定是否退回 Calibre。
 */

import { htmlToText } from './htmltext.js'

/** PalmDOC LZ77 解压（算法对齐 libmobi / KindleUnpack）。 */
export function decompressPalmDoc(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    const byte = data[i]
    i += 1
    if (byte >= 0xc0) {
      out.push(32, byte ^ 0x80)
    } else if (byte >= 0x80) {
      const next = data[i] ?? 0
      i += 1
      const distance = (((byte << 8) | next) >> 3) & 0x7ff
      const length = (next & 0x07) + 3
      let start = out.length - distance
      for (let k = 0; k < length; k += 1) out.push(start + k >= 0 ? out[start + k] ?? 0 : 0)
    } else if (byte >= 0x09) {
      out.push(byte)
    } else if (byte >= 0x01) {
      for (let k = 0; k < byte && i < data.length; k += 1) out.push(data[i++])
    } else {
      out.push(0)
    }
  }
  return Uint8Array.from(out)
}

function decode(buffer, encoding) {
  if (encoding === 65001) return buffer.toString('utf8')
  if (encoding === 1252 || encoding === 0) {
    try {
      return new TextDecoder('windows-1252').decode(buffer)
    } catch {
      return buffer.toString('latin1')
    }
  }
  return buffer.toString('utf8')
}

/** 解析 MOBI 文件，返回 { title, text }；HUFF/CDIC 抛 code=HUFF。 */
export function parseMobi(buffer, fallbackTitle = '正文') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 86 || buf.toString('ascii', 60, 68) !== 'BOOKMOBI') {
    // 有些文件前 60 字节不是 BOOKMOBI，仍按 PDB 结构尝试
  }
  const numRecords = buf.readUInt16BE(76)
  if (!numRecords || 78 + numRecords * 8 > buf.length) throw new Error('不是有效的 MOBI/PDB 文件')
  const offsets = []
  for (let i = 0; i < numRecords; i += 1) offsets.push(buf.readUInt32BE(78 + i * 8))
  const record0 = buf.subarray(offsets[0], offsets[1] ?? buf.length)
  const compression = record0.readUInt16BE(0)
  const textLength = record0.readUInt32BE(4)
  const textRecords = record0.readUInt16BE(8)
  const encryption = record0.readUInt16BE(12)
  if (encryption) throw new Error('MOBI 文件带 DRM，无法导入')
  let textEncoding = 65001
  let title = fallbackTitle
  if (record0.length >= 20 && record0.toString('ascii', 16, 20) === 'MOBI') {
    textEncoding = record0.readUInt32BE(28) || 65001
    const nameOffset = record0.readUInt32BE(84)
    const nameLength = record0.readUInt32BE(88)
    if (nameOffset > 0 && nameLength > 0 && nameOffset + nameLength <= record0.length) {
      title = decode(record0.subarray(nameOffset, nameOffset + nameLength), textEncoding) || fallbackTitle
    }
  }
  if (compression !== 1 && compression !== 2 && compression !== 17480) throw new Error(`MOBI 压缩方式不支持：${compression}`)
  if (compression === 17480) {
    const error = new Error('MOBI 使用 HUFF/CDIC 压缩，暂不支持；可先转成 EPUB/TXT')
    error.code = 'HUFF'
    throw error
  }
  const chunks = []
  for (let k = 1; k <= textRecords; k += 1) {
    const start = offsets[k]
    if (start === undefined) break
    const end = offsets[k + 1] ?? buf.length
    const record = buf.subarray(start, end)
    chunks.push(compression === 2 ? decompressPalmDoc(record) : record)
  }
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, textLength)
  let text = decode(raw, textEncoding)
  if (/<[a-z][\s\S]*>/i.test(text)) text = htmlToText(text)
  return { title, text: text.replace(/\u0000/g, '').trim() }
}
