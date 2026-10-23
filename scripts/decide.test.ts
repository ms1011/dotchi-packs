import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import type { Registry, Request } from './decide.ts'
import { decide, parseTitle } from './decide.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/squirrel/${name}`, import.meta.url), 'utf8')
/** id만 바꾼 다람쥐 팩 (그림을 바꾸려면 pixel) */
const packBody = (id: string, pixel?: string) => {
  const art = JSON.parse(fixture('art.json'))
  if (pixel !== undefined) art.idle[0][0] = pixel
  const files = {
    'dotchi.json': JSON.stringify({ ...JSON.parse(fixture('dotchi.json')), id }),
    'art.json': JSON.stringify(art),
    'lines.json': fixture('lines.json'),
  }
  const base64 = gzipSync(JSON.stringify({ format: 1, files })).toString('base64')
  return `<!-- dotchi-share v1 -->\n\n\`\`\`dotchi-pack\n${base64}\n\`\`\``
}
const ME = 777
const OTHER = 888
const req = (over: Partial<Request> = {}): Request => ({
  kind: 'share',
  id: 'my-cat',
  issue: 5,
  userId: ME,
  login: 'me',
  body: packBody(over.id ?? 'my-cat'),
  today: '2026-10-24',
  ...over,
})
const empty = (): Registry => ({ pets: {} })
const entry = (ownerId: number, state: 'published' | 'withdrawn' | 'removed' | 'reserved', issue: number | null = 3, artHash: string | null = null) => ({
  ownerId,
  ownerLogin: ownerId === ME ? 'me-old' : 'other',
  issue,
  created: '2026-10-20',
  updated: '2026-10-20',
  artHash,
  state,
})

test('parseTitle', () => {
  assert.deepEqual(parseTitle('share: my-cat'), { kind: 'share', id: 'my-cat' })
  assert.deepEqual(parseTitle('unshare:my-cat '), { kind: 'unshare', id: 'my-cat' })
  assert.equal(parseTitle('share my-cat'), null)
  assert.equal(parseTitle('Share: x'), null)
  assert.equal(parseTitle('share: My Cat'), null)
  assert.equal(parseTitle('hello'), null)
})

test('새 id → created, issue와 home은 요청 Issue', () => {
  const d = decide(req(), empty(), new Set(), 0)
  assert.equal(d.ok, true)
  if (!d.ok) return
  assert.equal(d.kind, 'created')
  assert.equal(d.homeIssue, 5)
  assert.deepEqual(d.registry.pets['my-cat'], {
    ownerId: ME, ownerLogin: 'me', issue: 5, created: '2026-10-24', updated: '2026-10-24', artHash: d.registry.pets['my-cat']!.artHash, state: 'published',
  })
  assert.equal(d.pack?.meta.id, 'my-cat')
})

test('같은 주인 다시 → updated, home은 처음 Issue, login 갱신', () => {
  const d = decide(req({ issue: 9 }), { pets: { 'my-cat': entry(ME, 'published') } }, new Set(), 0)
  assert.ok(d.ok && d.kind === 'updated')
  if (!d.ok) return
  assert.equal(d.homeIssue, 3)
  assert.equal(d.registry.pets['my-cat']!.issue, 3)
  assert.equal(d.registry.pets['my-cat']!.created, '2026-10-20')
  assert.equal(d.registry.pets['my-cat']!.ownerLogin, 'me')
})

test('남의 id → taken', () => {
  const d = decide(req(), { pets: { 'my-cat': entry(OTHER, 'published') } }, new Set(), 0)
  assert.deepEqual(d, { ok: false, reject: 'taken' })
})

test('reserved squirrel: 64572078은 게시(issue 채움), 남은 taken', () => {
  const registry: Registry = { pets: { squirrel: entry(64572078, 'reserved', null) } }
  const mine = decide(req({ id: 'squirrel', userId: 64572078, login: 'ms1011', issue: 7 }), registry, new Set(), 0)
  assert.ok(mine.ok && mine.kind === 'updated')
  if (!mine.ok) return
  assert.equal(mine.homeIssue, 7)
  assert.equal(mine.registry.pets.squirrel!.state, 'published')
  assert.equal(mine.registry.pets.squirrel!.issue, 7)
  assert.deepEqual(decide(req({ id: 'squirrel' }), registry, new Set(), 0), { ok: false, reject: 'taken' })
})

test('removed id → 주인이라도 taken', () => {
  assert.deepEqual(decide(req(), { pets: { 'my-cat': entry(ME, 'removed') } }, new Set(), 0), { ok: false, reject: 'taken' })
})

test('남의 펫과 그림 같음 → sameArt, 자기 펫과 같음은 통과, 한 칸 다르면 통과', () => {
  const first = decide(req({ id: 'cat-a', userId: OTHER }), empty(), new Set(), 0)
  assert.ok(first.ok)
  if (!first.ok) return
  assert.deepEqual(decide(req({ id: 'cat-b' }), first.registry, new Set(), 0), { ok: false, reject: 'sameArt', detail: 'cat-a' })
  assert.equal(decide(req({ id: 'cat-c', userId: OTHER }), first.registry, new Set(), 0).ok, true)
  assert.equal(decide({ ...req({ id: 'cat-d' }), body: packBody('cat-d', 'abcdef') }, first.registry, new Set(), 0).ok, true)
})

test('blocked → blocked, sharesLast24h 19 통과, 20 rateLimited', () => {
  assert.deepEqual(decide(req(), empty(), new Set([ME]), 0), { ok: false, reject: 'blocked' })
  assert.equal(decide(req(), empty(), new Set(), 19).ok, true)
  assert.deepEqual(decide(req(), empty(), new Set(), 20), { ok: false, reject: 'rateLimited' })
})

test('검사 실패는 그대로 거절로', () => {
  assert.deepEqual(decide(req({ body: 'no bundle' }), empty(), new Set(), 0), { ok: false, reject: 'noBundle' })
  assert.deepEqual(decide(req({ id: 'other-id', body: packBody('my-cat') }), empty(), new Set(), 0), {
    ok: false, reject: 'idMismatch', detail: 'my-cat',
  })
})

test('unshare: 주인 → withdrawn, 남 → notOwner, 없음·내린 것 → notFound', () => {
  const registry: Registry = { pets: { 'my-cat': entry(ME, 'published') } }
  const mine = decide(req({ kind: 'unshare', body: '' }), registry, new Set(), 0)
  assert.ok(mine.ok && mine.kind === 'withdrawn')
  if (!mine.ok) return
  assert.equal(mine.registry.pets['my-cat']!.state, 'withdrawn')
  assert.deepEqual(decide(req({ kind: 'unshare', userId: OTHER, body: '' }), registry, new Set(), 0), { ok: false, reject: 'notOwner' })
  assert.deepEqual(decide(req({ kind: 'unshare', body: '' }), empty(), new Set(), 0), { ok: false, reject: 'notFound' })
  assert.deepEqual(decide(req({ kind: 'unshare', body: '' }), mine.registry, new Set(), 0), { ok: false, reject: 'notFound' })
  assert.equal(decide(req({ kind: 'unshare', body: '' }), registry, new Set(), 25).ok, true)
})

test('withdrawn id: 같은 주인 share → updated(published), 남 → taken', () => {
  const registry: Registry = { pets: { 'my-cat': entry(ME, 'withdrawn') } }
  const mine = decide(req(), registry, new Set(), 0)
  assert.ok(mine.ok && mine.kind === 'updated')
  if (mine.ok) assert.equal(mine.registry.pets['my-cat']!.state, 'published')
  assert.deepEqual(decide(req({ userId: OTHER }), registry, new Set(), 0), { ok: false, reject: 'taken' })
})

test('decide는 입력 registry를 바꾸지 않는다', () => {
  const registry: Registry = { pets: { 'my-cat': entry(ME, 'published') } }
  const before = structuredClone(registry)
  decide(req(), registry, new Set(), 0)
  decide(req({ kind: 'unshare', body: '' }), registry, new Set(), 0)
  assert.deepEqual(registry, before)
})

test('예약된 기본 펫의 그림과 같으면 sameArt', () => {
  const first = decide(req({ id: 'cat-a', userId: OTHER }), empty(), new Set(), 0)
  assert.ok(first.ok)
  if (!first.ok) return
  const hash = first.registry.pets['cat-a']!.artHash
  const registry: Registry = { pets: { squirrel: entry(64572078, 'reserved', null, hash) } }
  assert.deepEqual(decide(req({ id: 'my-squirrel' }), registry, new Set(), 0), { ok: false, reject: 'sameArt', detail: 'squirrel' })
})

test('registry.json의 기본 펫 지문은 플러그인 기본 펫 그림과 같다', async () => {
  const { artHash } = await import('./bundle.ts')
  const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8')) as Registry
  for (const id of ['squirrel', 'turtle']) {
    const art = JSON.parse(readFileSync(new URL(`../dotchi/characters/${id}/art.json`, import.meta.url), 'utf8'))
    assert.equal(registry.pets[id]!.artHash, artHash(art), id)
  }
})
