import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { parseArt } from '../dotchi/hooks/dots.ts'
import { LANGS, parseLines, parseMeta } from '../dotchi/hooks/packs.ts'
import type { Art, PackLines, PackMeta } from '../dotchi/types/index.d.ts'

/** 플러그인 hooks/share.ts의 BUNDLE_FILE과 같아야 한다 (테스트가 확인) */
export const BUNDLE_FILE = /^(dotchi\.json|art\.json|lines\.json|grid\/[a-z0-9_-]{1,16}\.txt)$/
const MAX_BASE64 = 60000
const MAX_UNZIPPED = 512 * 1024
const MAX_FILES = 12
/** 사이트용 글자 제한 */
export const LIMITS = { name: 40, description: 300, line: 80, linesPerKind: 30 }

export type Pack = { meta: PackMeta; art: Art; lines: PackLines; files: Record<string, string> }
export type RejectCode =
  | 'noBundle'
  | 'badBundle'
  | 'tooBig'
  | 'badFile'
  | 'badPack'
  | 'idMismatch'
  | 'tooLong'
  | 'blocked'
  | 'rateLimited'
  | 'taken'
  | 'sameArt'
  | 'notOwner'
  | 'notFound'
export type Reject = { reject: RejectCode; detail?: string }

export const isReject = (value: unknown): value is Reject =>
  typeof value === 'object' && value !== null && 'reject' in value

/** Issue 본문에서 ```dotchi-pack 블록 하나의 base64 */
export const extractBundle = (body: string): string | Reject => {
  const blocks = [...body.matchAll(/```dotchi-pack\r?\n([\s\S]*?)\r?\n```/g)]
  if (blocks.length === 0) return { reject: 'noBundle' }
  if (blocks.length > 1) return { reject: 'badBundle' }
  return blocks[0]![1]!.trim()
}

/** base64 → gunzip(크기 상한) → { format: 1, files }. 팩 파일 이름만, 12개까지 */
export const decodeBundle = (base64: string): Record<string, string> | Reject => {
  if (base64.length > MAX_BASE64) return { reject: 'tooBig' }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return { reject: 'badBundle' }
  let text: string
  try {
    text = gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: MAX_UNZIPPED }).toString('utf8')
  } catch (error) {
    return { reject: (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'tooBig' : 'badBundle' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { reject: 'badBundle' }
  }
  const bundle = raw as { format?: unknown; files?: unknown }
  if (bundle?.format !== 1 || typeof bundle.files !== 'object' || bundle.files === null || Array.isArray(bundle.files)) {
    return { reject: 'badBundle' }
  }
  const entries = Object.entries(bundle.files as Record<string, unknown>)
  if (entries.length > MAX_FILES) return { reject: 'badFile', detail: `more than ${MAX_FILES} files` }
  const files: Record<string, string> = {}
  for (const [name, content] of entries) {
    if (!BUNDLE_FILE.test(name)) return { reject: 'badFile', detail: name }
    if (typeof content !== 'string') return { reject: 'badBundle' }
    files[name] = content
  }
  return files
}

const tooLong = (meta: PackMeta, lines: PackLines): string | null => {
  const names = typeof meta.name === 'string' ? [meta.name] : Object.values(meta.name)
  if (names.some(name => name !== undefined && [...name].length > LIMITS.name)) return 'name'
  if (meta.description !== undefined && [...meta.description].length > LIMITS.description) return 'description'
  for (const lang of LANGS) {
    const set = lines[lang]
    if (set === undefined) continue
    for (const kind of [set.spinner, set.idle, set.ending]) {
      if (kind.length > LIMITS.linesPerKind || kind.some(line => [...line].length > LIMITS.line)) return 'lines'
    }
  }
  return null
}

/** 플러그인과 같은 규칙으로 팩을 검사하고, 제목의 id와 맞는지, 사이트 글자 제한을 지키는지 */
export const checkPack = (files: Record<string, string>, titleId: string): Pack | Reject => {
  const meta = parseMeta(files['dotchi.json'] ?? '')
  if (meta === null) return { reject: 'badPack', detail: 'dotchi.json' }
  const art = parseArt(files['art.json'] ?? '')
  if (art === null) return { reject: 'badPack', detail: 'art.json' }
  const lines = parseLines(files['lines.json'] ?? '')
  if (lines === null) return { reject: 'badPack', detail: 'lines.json' }
  if (meta.id !== titleId) return { reject: 'idMismatch', detail: meta.id }
  const long = tooLong(meta, lines)
  if (long !== null) return { reject: 'tooLong', detail: long }
  return { meta, art, lines, files }
}

/** 그림만 보고 만든 지문: 남의 펫을 그대로 다시 올리는 것을 알아본다 */
export const artHash = (art: Art): string => createHash('sha256').update(JSON.stringify([art.idle, art.work])).digest('hex')
