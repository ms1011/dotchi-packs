import type { Pack, Reject, ThemePack } from './bundle.ts'
import { artHash, checkPack, checkTheme, decodeBundle, decodeTheme, extractBundle, extractTheme, isReject } from './bundle.ts'

/** 같은 사람이 24시간에 올릴 수 있는 횟수 */
export const SHARES_PER_DAY = 20

export type State = 'published' | 'withdrawn' | 'removed' | 'reserved'
export type Entry = {
  ownerId: number
  ownerLogin: string
  /** 처음 Issue: 좋아요(👍)가 모이는 곳. reserved는 아직 없다 */
  issue: number | null
  created: string
  updated: string
  artHash: string | null
  state: State
}
/** 펫과 상태 줄 테마는 id를 따로 쓴다 (같은 id가 펫이면서 테마일 수 있다) */
export type Registry = { pets: Record<string, Entry>; themes?: Record<string, Entry> }
export type Target = 'pet' | 'theme'

export type Request = {
  kind: 'share' | 'unshare'
  /** 펫(share:)인지 테마(theme-share:)인지 */
  target: Target
  id: string
  issue: number
  userId: number
  login: string
  body: string
  /** YYYY-MM-DD */
  today: string
}

export type Decision =
  | { ok: true; kind: 'created' | 'updated' | 'withdrawn'; registry: Registry; pack?: Pack; theme?: ThemePack; homeIssue: number | null }
  | ({ ok: false } & Reject)

const no = (reject: Reject): Decision => ({ ok: false, ...reject })

/** Issue 제목 'share: <id>' / 'unshare: <id>', 테마는 'theme-share: <id>' / 'theme-unshare: <id>' */
export const parseTitle = (title: string): { kind: 'share' | 'unshare'; id: string; target: Target } | null => {
  const match = /^(theme-)?(share|unshare):\s*([a-z0-9-]{1,32})\s*$/.exec(title)
  return match === null ? null : { kind: match[2] as 'share' | 'unshare', id: match[3]!, target: match[1] === undefined ? 'pet' : 'theme' }
}

/** 테마 Issue 본문을 검사한 테마. 펫과 달리 그림 지문은 없다 */
const themeOf = (req: Request): ThemePack | Reject => {
  const base64 = extractTheme(req.body)
  if (isReject(base64)) return base64
  const text = decodeTheme(base64)
  return isReject(text) ? text : checkTheme(text, req.id)
}

/** 올리기·내리기 요청을 규칙대로 판단한다. 입력은 바꾸지 않고 새 registry를 돌려준다 */
export const decide = (req: Request, registry: Registry, blocked: ReadonlySet<number>, sharesLast24h: number): Decision => {
  if (blocked.has(req.userId)) return no({ reject: 'blocked' })
  const isTheme = req.target === 'theme'
  const bucket = (isTheme ? registry.themes : registry.pets) ?? {}
  const current = bucket[req.id]
  const withEntry = (entry: Entry): Registry =>
    isTheme ? { ...registry, themes: { ...bucket, [req.id]: entry } } : { ...registry, pets: { ...bucket, [req.id]: entry } }

  if (req.kind === 'unshare') {
    if (current === undefined || current.state !== 'published') return no({ reject: 'notFound' })
    if (current.ownerId !== req.userId) return no({ reject: 'notOwner' })
    const entry = { ...current, ownerLogin: req.login, updated: req.today, state: 'withdrawn' as const }
    return { ok: true, kind: 'withdrawn', registry: withEntry(entry), homeIssue: current.issue }
  }

  if (sharesLast24h >= SHARES_PER_DAY) return no({ reject: 'rateLimited' })
  if (isTheme) {
    const theme = themeOf(req)
    if (isReject(theme)) return no(theme)
    if (current === undefined) {
      const entry: Entry = { ownerId: req.userId, ownerLogin: req.login, issue: req.issue, created: req.today, updated: req.today, artHash: null, state: 'published' }
      return { ok: true, kind: 'created', registry: withEntry(entry), theme, homeIssue: req.issue }
    }
    if (current.state === 'removed' || current.ownerId !== req.userId) return no({ reject: 'taken' })
    const issue = current.issue ?? req.issue
    const entry: Entry = { ...current, ownerLogin: req.login, issue, updated: req.today, state: 'published' }
    return { ok: true, kind: 'updated', registry: withEntry(entry), theme, homeIssue: issue }
  }
  const base64 = extractBundle(req.body)
  if (isReject(base64)) return no(base64)
  const files = decodeBundle(base64)
  if (isReject(files)) return no(files)
  const pack = checkPack(files, req.id)
  if (isReject(pack)) return no(pack)

  const hash = artHash(pack.art)
  const copied = Object.entries(registry.pets).find(
    ([id, other]) =>
      id !== req.id &&
      (other.state === 'published' || other.state === 'reserved') &&
      other.ownerId !== req.userId &&
      other.artHash === hash,
  )
  if (copied !== undefined) return no({ reject: 'sameArt', detail: copied[0] })

  if (current === undefined) {
    const entry: Entry = {
      ownerId: req.userId,
      ownerLogin: req.login,
      issue: req.issue,
      created: req.today,
      updated: req.today,
      artHash: hash,
      state: 'published',
    }
    return { ok: true, kind: 'created', registry: withEntry(entry), pack, homeIssue: req.issue }
  }
  if (current.state === 'removed' || current.ownerId !== req.userId) return no({ reject: 'taken' })
  const issue = current.issue ?? req.issue
  const entry: Entry = { ...current, ownerLogin: req.login, issue, updated: req.today, artHash: hash, state: 'published' }
  return { ok: true, kind: 'updated', registry: withEntry(entry), pack, homeIssue: issue }
}
