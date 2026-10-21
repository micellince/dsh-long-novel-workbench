/**
 * 零依赖 ZIP 打包（EPUB / DOCX 用）。
 *
 * 只实现「store」与「deflate」两种压缩方式，不含 ZIP64、加密、多磁盘。
 * 文件名统一按 UTF-8 写入（通用位标记 0x0800）。
 */

import { deflateRawSync } from 'node:zlib'

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_SIGNATURE = 0x06054b50
// 固定为 1980-01-01 00:00，保证同样输入得到同样字节（DOS 时间格式）。
const DOS_TIME = 0x0000
const DOS_DATE = 0x0021

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32（IEEE 多项式），返回无符号 32 位。 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  return Buffer.from(String(data ?? ''), 'utf8')
}

/**
 * 打包成 ZIP。
 * @param {Array<{name:string, data:string|Buffer|Uint8Array, store?:boolean}>} entries
 * @returns {Buffer}
 */
export function createZip(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP 至少需要一个条目')
  if (entries.length > 0xffff) throw new Error('ZIP 条目过多（不含 ZIP64 支持）')

  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (!name) throw new Error('ZIP 条目缺少文件名')
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = toBuffer(entry.data)
    const store = entry.store === true
    const body = store ? raw : deflateRawSync(raw)
    const crc = crc32(raw)
    const method = store ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度
    localParts.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
    central.writeUInt16LE(20, 4) // 创建版本
    central.writeUInt16LE(20, 6) // 解压所需版本
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段长度
    central.writeUInt16LE(0, 32) // 注释长度
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地头偏移
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_SIGNATURE, 0)
  end.writeUInt16LE(0, 4) // 当前磁盘号
  end.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...localParts, centralBuf, end])
}
