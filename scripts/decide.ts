import type { Pack, Reject } from './bundle.ts'
import { artHash, checkPack, decodeBundle, extractBundle, isReject } from './bundle.ts'

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
export type Registry = { pets: Record<string, Entry> }

export type Request = {
  kind: 'share' | 'unshare'
  id: string
  issue: number
  userId: number
  login: string
  body: string
  /** YYYY-MM-DD */
  today: string
}

export type Decision =
  | { ok: true; kind: 'created' | 'updated' | 'withdrawn'; registry: Registry; pack?: Pack; homeIssue: number | null }
  | ({ ok: false } & Reject)

const no = (reject: Reject): Decision => ({ ok: false, ...reject })

/** Issue 제목 'share: <id>' / 'unshare: <id>' */
export const parseTitle = (title: string): { kind: 'share' | 'unshare'; id: string } | null => {
  const match = /^(share|unshare):\s*([a-z0-9-]{1,32})\s*$/.exec(title)
  return match === null ? null : { kind: match[1] as 'share' | 'unshare', id: match[2]! }
}

/** 올리기·내리기 요청을 규칙대로 판단한다. 입력은 바꾸지 않고 새 registry를 돌려준다 */
export const decide = (req: Request, registry: Registry, blocked: ReadonlySet<number>, sharesLast24h: number): Decision => {
  if (blocked.has(req.userId)) return no({ reject: 'blocked' })
  const current = registry.pets[req.id]
  const withEntry = (entry: Entry): Registry => ({ pets: { ...registry.pets, [req.id]: entry } })

  if (req.kind === 'unshare') {
    if (current === undefined || current.state !== 'published') return no({ reject: 'notFound' })
    if (current.ownerId !== req.userId) return no({ reject: 'notOwner' })
    const entry = { ...current, ownerLogin: req.login, updated: req.today, state: 'withdrawn' as const }
    return { ok: true, kind: 'withdrawn', registry: withEntry(entry), homeIssue: current.issue }
  }

  if (sharesLast24h >= SHARES_PER_DAY) return no({ reject: 'rateLimited' })
  const base64 = extractBundle(req.body)
  if (isReject(base64)) return no(base64)
  const files = decodeBundle(base64)
  if (isReject(files)) return no(files)
  const pack = checkPack(files, req.id)
  if (isReject(pack)) return no(pack)

  const hash = artHash(pack.art)
  const copied = Object.entries(registry.pets).find(
    ([id, other]) => id !== req.id && other.state === 'published' && other.ownerId !== req.userId && other.artHash === hash,
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
