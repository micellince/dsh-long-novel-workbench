/**
 * 最小 ZIP 解包（EPUB 用）。
 *
 * 支持 store / deflate，读取中央目录；不支持 ZIP64、加密、多磁盘。
 * 返回 Map<entryName, Buffer>。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i
  }
  return -1
}

export function unzip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件（找不到目录尾）')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL) throw new Error('ZIP 中央目录损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8').replace(/\\/g, '/')

    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`ZIP 本地头损坏：${name}`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = buf.subarray(dataStart, dataStart + compressedSize)
    let content
    if (method === 0) content = Buffer.from(data)
    else if (method === 8) content = inflateRawSync(data)
    else throw new Error(`ZIP 压缩方式不支持：${method}（${name}）`)
    entries.set(name, content)
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}
