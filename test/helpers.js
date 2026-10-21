/**
 * 测试共用工具：临时根目录、可选模块加载、最小 ZIP 解析与 CRC32。
 *
 * 约定：所有碰文件系统的测试都从 makeRoot() 拿一个 mkdtemp('storydesk-') 的临时根，
 * 绝不读写真实的 ~/StoryDesk；纯函数（runChecks / computeAlignment）不需要根目录。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** 创建临时 STORY_DESK 根，测试结束（无论成败）自动删除。 */
export async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'storydesk-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

/** 动态 import：模块/新导出尚未实现时返回 { error }，不炸掉整个测试文件。 */
export async function loadModule(spec) {
  try {
    return { module: await import(spec) }
  } catch (error) {
    return { error }
  }
}

/** 加载失败时给出「实现未完成」的可读错误。 */
export function requireModule(loaded, spec) {
  if (loaded.error) throw new Error(`实现未完成：无法加载 ${spec}（${loaded.error.message}）`)
  return loaded.module
}

/** 取函数；不存在时给出「实现未完成」的可读错误。 */
export function needFn(mod, name, where) {
  if (!mod || typeof mod[name] !== 'function') {
    throw new Error(`实现未完成：${where} 未导出函数 ${name}()`)
  }
  return mod[name]
}

/** 小睡一会儿：避免同一毫秒内的备份文件名撞车，让时间戳有序。 */
export function delay(ms = 3) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

let crcTable = null

function getCrcTable() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c >>> 0
  }
  return crcTable
}

/** 独立实现的 CRC32（ZIP 用），用来校验导出器自己算的 CRC。 */
export function crc32(buffer) {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 最小 ZIP 解析器（只依赖 node:zlib）：
 * 读 EOCD → 中央目录 → 本地文件头，返回每个条目解压后的数据与元信息。
 * @returns {Array<{name:string, method:number, flags:number, crc:number,
 *   compressedSize:number, uncompressedSize:number, localOffset:number, data:Buffer}>}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是合法 ZIP：数据太短')

  let eocd = -1
  const minEocd = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到中央目录结尾（EOCD）')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let p = centralOffset

  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`ZIP 中央目录第 ${i} 条记录签名错误`)
    }
    const flags = buffer.readUInt16LE(p + 8)
    const method = buffer.readUInt16LE(p + 10)
    const crc = buffer.readUInt32LE(p + 16)
    const compressedSize = buffer.readUInt32LE(p + 20)
    const uncompressedSize = buffer.readUInt32LE(p + 24)
    const nameLength = buffer.readUInt16LE(p + 28)
    const extraLength = buffer.readUInt16LE(p + 30)
    const commentLength = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8')

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 条目「${name}」的本地文件头签名错误`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed)
    else throw new Error(`ZIP 条目「${name}」用了不支持的压缩方法 ${method}`)

    entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset, data })
    p += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** 按名字取 ZIP 条目的 UTF-8 文本。 */
export function zipText(entries, name) {
  const entry = entries.find((e) => e.name === name)
  if (!entry) throw new Error(`ZIP 中缺少条目：${name}`)
  return entry.data.toString('utf8')
}
