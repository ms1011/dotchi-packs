import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildIndex, buildSite, likesQuery } from './build-site.ts'
import type { Registry } from './decide.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/squirrel/${name}`, import.meta.url), 'utf8')
const entry = (issue: number | null, state: 'published' | 'withdrawn' | 'removed' | 'reserved', ownerId = 777, created = '2026-10-21') => ({
  ownerId, ownerLogin: `u${ownerId}`, issue, created, updated: created, artHash: null, state,
})
const registry: Registry = {
  pets: {
    squirrel: entry(3, 'published', 64572078),
    gone: entry(4, 'withdrawn'),
    held: entry(null, 'reserved', 64572078),
    nopack: entry(6, 'published'),
  },
}
const readPack = (id: string) => {
  if (id !== 'squirrel') return null
  return { meta: JSON.parse(fixture('dotchi.json')), art: JSON.parse(fixture('art.json')), lines: JSON.parse(fixture('lines.json')) }
}

test('buildIndex: published이고 팩을 읽을 수 있는 것만, taken은 전부', () => {
  const index = buildIndex(registry, readPack, { 3: 12 })
  assert.deepEqual(index.taken, { squirrel: 64572078, gone: 777, held: 64572078, nopack: 777 })
  assert.equal(index.pets.length, 1)
  const [pet] = index.pets
  assert.deepEqual(pet, {
    id: 'squirrel',
    name: JSON.parse(fixture('dotchi.json')).name,
    description: JSON.parse(fixture('dotchi.json')).description ?? '',
    owner: 'u64572078',
    created: '2026-10-21',
    updated: '2026-10-21',
    frames: JSON.parse(fixture('art.json')).work.length,
    stages: 1,
    langs: ['ko', 'en', 'ja', 'zh'],
    frameMs: 250,
    likes: 12,
    issue: 3,
  })
})

test('buildIndex: likes 없는 Issue는 0, frameMs 없으면 250', () => {
  const plain = (id: string) => {
    const pack = readPack('squirrel')!
    return id === 'squirrel' ? { ...pack, meta: { ...pack.meta, frameMs: undefined } } : null
  }
  const [pet] = buildIndex(registry, plain, {}).pets
  assert.equal(pet!.likes, 0)
  assert.equal(pet!.frameMs, 250)
})

test('likesQuery: 별칭 i<번호>, THUMBS_UP', () => {
  const query = likesQuery([3, 12])
  assert.ok(query.includes('repository(owner: "ms1011", name: "dotchi-packs")'))
  assert.ok(query.includes('i3: issue(number: 3) { reactions(content: THUMBS_UP) { totalCount } }'))
  assert.ok(query.includes('i12: issue(number: 12)'))
})

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), 'packs-'))
  mkdirSync(join(root, 'site'), { recursive: true })
  writeFileSync(join(root, 'site/index.html'), '<!doctype html>')
  writeFileSync(join(root, 'site/app.js'), '')
  mkdirSync(join(root, 'packs/squirrel/grid'), { recursive: true })
  for (const name of ['dotchi.json', 'art.json', 'lines.json']) writeFileSync(join(root, 'packs/squirrel', name), fixture(name))
  writeFileSync(join(root, 'packs/squirrel/grid/1.txt'), 'g')
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ pets: { squirrel: entry(3, 'published', 64572078), gone: entry(4, 'withdrawn') } }))
  return root
}

test('buildSite: site 파일, index.json, 팩 JSON, zip 호출', async () => {
  const root = repo()
  const out = join(root, '_site')
  const zips: string[][] = []
  await buildSite(out, { fetchLikes: async issues => Object.fromEntries(issues.map(n => [n, 5])), zip: async (cwd, id, file) => void zips.push([cwd, id, file]) }, root)
  assert.ok(existsSync(join(out, 'index.html')))
  assert.ok(existsSync(join(out, 'app.js')))
  assert.ok(existsSync(join(out, 'packs/squirrel/art.json')))
  assert.ok(!existsSync(join(out, 'packs/squirrel/grid/1.txt')))
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
  assert.equal(index.pets[0].likes, 5)
  assert.deepEqual(zips, [[join(root, 'packs'), 'squirrel', join(out, 'packs/squirrel.dotchi.zip')]])
})

test('좋아요 가져오기 실패 → likes 0으로 계속', async () => {
  const root = repo()
  const out = join(root, '_site')
  await buildSite(out, { fetchLikes: async () => { throw new Error('rate limited') }, zip: async () => {} }, root)
  assert.equal(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).pets[0].likes, 0)
})

/* ---------- 상태 줄 테마 ---------- */

const oceanText = JSON.stringify({ format: 1, id: 'ocean', name: { en: 'Ocean' }, description: 'blue', colors: { ok: '#00aaff' } })

test('buildIndex: 게시 중이고 읽을 수 있는 테마만, 모양과 좋아요를 싣는다. takenThemes는 전부', () => {
  const withThemes: Registry = { ...registry, themes: { ocean: entry(7, 'published'), old: entry(8, 'withdrawn'), broken: entry(9, 'published') } }
  const readTheme = (id: string) => {
    if (id !== 'ocean') return null
    const parsed = JSON.parse(oceanText)
    return { meta: { format: 1 as const, id, name: parsed.name, description: 'blue' }, look: { colors: { ok: '#00aaff' } } as never }
  }
  const index = buildIndex(withThemes, readPack, { 7: 4 }, readTheme)
  assert.deepEqual(index.takenThemes, { ocean: 777, old: 777, broken: 777 })
  assert.deepEqual(index.themes, [
    { id: 'ocean', name: { en: 'Ocean' }, description: 'blue', owner: 'u777', created: '2026-10-21', updated: '2026-10-21', likes: 4, issue: 7, look: { colors: { ok: '#00aaff' } } },
  ])
  assert.equal(index.pets.length, 1)
})

test('buildSite: 테마 theme.json을 사이트에 복사하고 index에 모양을 채운다', async () => {
  const root = repo()
  mkdirSync(join(root, 'themes/ocean'), { recursive: true })
  writeFileSync(join(root, 'themes/ocean/theme.json'), oceanText)
  const reg = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ ...reg, themes: { ocean: entry(7, 'published') } }))
  const out = join(root, '_site')
  await buildSite(out, { fetchLikes: async issues => Object.fromEntries(issues.map(n => [n, n])), zip: async () => {} }, root)
  assert.equal(readFileSync(join(out, 'themes/ocean/theme.json'), 'utf8'), oceanText)
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
  assert.equal(index.themes[0].likes, 7)
  assert.equal(index.themes[0].look.colors.ok, '#00aaff')
  assert.equal(index.themes[0].look.colors.warn, '#ffd86b')
  assert.equal(index.themes[0].look.faces.ok, '(•ᴗ•)')
})

test('buildIndex: 단계 그림이 있으면 stages에 단계 수', () => {
  const staged = (id: string) => {
    const pack = readPack(id)
    if (pack === null) return null
    const art = { ...pack.art, stages: { '2': { idle: pack.art.idle, work: pack.art.work }, '3': { idle: pack.art.idle, work: pack.art.work } } }
    return { ...pack, art }
  }
  assert.equal(buildIndex(registry, staged, {}).pets[0]!.stages, 3)
})
