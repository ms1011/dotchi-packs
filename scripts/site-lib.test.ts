import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { detectLang, filterPets, installCommand, petFromQuery, pick, sortPets } from '../site/lib.js'

const pet = (id: string, likes: number, created: string, extra: Record<string, unknown> = {}) => ({
  id, name: { ko: `${id}-ko`, en: `${id}-en` }, description: '', owner: 'o', created, updated: created, frames: 3, langs: ['ko'], frameMs: 250, likes, issue: 1, ...extra,
})

test('pick: ko → en → 첫 값, 문자열 이름', () => {
  assert.equal(pick({ ko: '다', en: 'S' }, 'ko'), '다')
  assert.equal(pick({ ko: '다', en: 'S' }, 'ja'), 'S')
  assert.equal(pick({ zh: '松' }, 'ja'), '松')
  assert.equal(pick('Plain', 'ko'), 'Plain')
})

test('detectLang: ?lang 우선, 저장값, 브라우저(zh-TW → zh, fr → en)', () => {
  assert.equal(detectLang({ query: '?lang=ja', saved: 'ko', languages: ['zh-CN'] }), 'ja')
  assert.equal(detectLang({ query: '?lang=xx', saved: 'ko', languages: ['zh-CN'] }), 'ko')
  assert.equal(detectLang({ query: '', saved: null, languages: ['zh-TW', 'en'] }), 'zh')
  assert.equal(detectLang({ query: '', saved: null, languages: ['fr-FR', 'de'] }), 'en')
  assert.equal(detectLang({ query: '', saved: null, languages: ['fr-FR', 'ko-KR'] }), 'ko')
})

test('sortPets: 인기순은 좋아요, 같으면 최신 / 최신순은 created, 같으면 좋아요', () => {
  const pets = [pet('a', 5, '2026-10-20'), pet('b', 9, '2026-10-21'), pet('c', 5, '2026-10-23'), pet('d', 1, '2026-10-23')]
  assert.deepEqual(sortPets(pets, 'likes').map(p => p.id), ['b', 'c', 'a', 'd'])
  assert.deepEqual(sortPets(pets, 'new').map(p => p.id), ['c', 'd', 'b', 'a'])
  assert.deepEqual(pets.map(p => p.id), ['a', 'b', 'c', 'd'])
})

test('filterPets: 일본어 이름, 작성자, 소개, 대소문자', () => {
  const pets = [pet('a', 0, 'x', { name: { ja: 'リス' } }), pet('b', 0, 'x', { owner: 'MochiCat' }), pet('c', 0, 'x', { description: 'Night owl' })]
  assert.deepEqual(filterPets(pets, 'リス').map(p => p.id), ['a'])
  assert.deepEqual(filterPets(pets, 'mochi').map(p => p.id), ['b'])
  assert.deepEqual(filterPets(pets, 'OWL').map(p => p.id), ['c'])
  assert.equal(filterPets(pets, '  ').length, 3)
})

test('petFromQuery: ?pet=my-cat → my-cat, 이상한 값 → null', () => {
  assert.equal(petFromQuery('?pet=my-cat'), 'my-cat')
  assert.equal(petFromQuery('?lang=ko&pet=my-cat'), 'my-cat')
  assert.equal(petFromQuery('?pet=%3Cscript%3E'), null)
  assert.equal(petFromQuery(''), null)
})

test('installCommand', () => {
  assert.equal(installCommand('my-cat'), '/dotchi install my-cat')
})

test('app.js는 팩 글을 innerHTML로 넣지 않는다', () => {
  const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')
  const assigns = app.split('\n').filter(line => /innerHTML\s*=/.test(line))
  assert.ok(assigns.length > 0)
  for (const line of assigns) assert.doesNotMatch(line, /pet\.|meta\.|lines|description|owner|name/, line)
})
