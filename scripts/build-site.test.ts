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
