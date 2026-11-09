import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  applyLikes,
  growthOrder,
  stageBadge,
  detectLang,
  filterPets,
  installCommand,
  likesFromIssues,
  MOODS,
  petFromQuery,
  pick,
  previewOf,
  sortPets,
  themeFromQuery,
  themeInstallCommand,
} from '../site/lib.js'

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

test('likesFromIssues: GitHub Issue 목록에서 번호별 👍 수, PR과 모양이 틀린 것은 건너뛴다', () => {
  const page = [
    { number: 2, reactions: { '+1': 3, heart: 9 } },
    { number: 1, reactions: { '+1': 0 } },
    { number: 5, pull_request: {}, reactions: { '+1': 7 } },
    { number: 6 },
    { number: 'x', reactions: { '+1': 1 } },
  ]
  assert.deepEqual(likesFromIssues(page), { 2: 3, 1: 0 })
  assert.deepEqual(likesFromIssues({ message: 'API rate limit exceeded' }), {})
})

test('applyLikes: 최신 숫자로 바꾸고, 모르는 Issue는 빌드 때 숫자 그대로, 원래 배열은 그대로', () => {
  const pets = [pet('a', 5, 'x', { issue: 1 }), pet('b', 2, 'x', { issue: 2 })]
  const next = applyLikes(pets, { 2: 9 })
  assert.deepEqual(next.map(p => p.likes), [5, 9])
  assert.deepEqual(pets.map(p => p.likes), [5, 2])
})

test('app.js는 GitHub API에서 좋아요를 바로 가져온다', () => {
  const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')
  assert.ok(app.includes('https://api.github.com/repos/ms1011/dotchi-packs/issues'))
  assert.ok(app.includes('applyLikes('))
})

test('좋아요 요청은 브라우저 캐시를 쓰지 않고 매번 GitHub에 확인한다(해제도 바로 보이게)', () => {
  const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')
  const start = app.indexOf('fetch(`${ISSUES_API}')
  const call = app.slice(start, app.indexOf('.catch(', start))
  assert.match(call, /cache: 'no-cache'/)
  assert.match(app, /const LIKES_EVERY_MS = 10000/)
})

test('좋아요는 창에 포커스가 돌아올 때와 펫을 열 때도 다시 묻는다', () => {
  const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')
  assert.match(app, /window\.addEventListener\('focus', \(\) => refreshLikes\(\)\)/)
  const openPet = app.slice(app.indexOf('function openPet('), app.indexOf('function fillDetail('))
  assert.match(openPet, /refreshLikes\(\)/)
})

/* ---------- 상태 줄 테마 ---------- */

const LABELS = { full: '배부름', week: '주간' }

test('themeFromQuery·themeInstallCommand', () => {
  assert.equal(themeFromQuery('?theme=ocean'), 'ocean')
  assert.equal(themeFromQuery('?theme=Bad Id'), null)
  assert.equal(themeFromQuery('?pet=ocean'), null)
  assert.equal(themeInstallCommand('ocean'), '/dotchi theme install ocean')
})

test('previewOf: 기본 모양이면 플러그인과 같은 상태 줄, 강조색 pet은 라벤더', () => {
  const ok = previewOf({}, MOODS[0], LABELS)
  assert.equal(ok.status, '🐾 ♥♥♡♡♡ 40% · ⚡ 41% · ⎇ main')
  assert.deepEqual(ok.rows[0], [
    { text: '(•ᴗ•)', color: '#b8a6ff' },
    { text: ' 배부름 ', color: '#9a9ab0' },
    { text: '▰▰▰▰▱▱▱▱▱▱ 40%', color: '#8fd9b6' },
  ])
  const danger = previewOf({}, MOODS[2], LABELS)
  assert.equal(danger.status, '🐾 ♥♥♥♥♥ 93% (×_×) /compact · ⚡ 97% 🥱 · ⎇ main')
  assert.equal(danger.rows[0]![0]!.color, '#ff8fa3')
  assert.deepEqual(danger.rows[1]!.at(-1), { text: ' 🥱', color: '#9a9ab0' })
})

test('previewOf: 테마 모양을 따르고, 색이 이상하면 기본 색으로', () => {
  const look = {
    colors: { ok: '#000001', warn: '#000002', danger: 'red', dim: '#000004', accent: '#000005' },
    faces: { ok: 'A', warn: 'B', danger: 'C' },
    hearts: ['#', '.'],
    bar: ['=', '-'],
    symbols: { week: 'wk', tired: 'zz', reset: '@', time: 't' },
  }
  const warn = previewOf(look, MOODS[1], LABELS)
  assert.equal(warn.status, '🐾 ####. 78% B · wk 83% · ⎇ main')
  assert.deepEqual(warn.rows[0]![0], { text: 'B', color: '#000002' })
  assert.deepEqual(warn.rows[1]!.at(-1), { text: ' @ 09:00', color: '#000004' })
  assert.equal(warn.rows[2]![0]!.text, 't 12m · Opus 5.5 · 1M')
  assert.equal(previewOf(look, MOODS[2], LABELS).rows[0]![0]!.color, '#ff8fa3')
  assert.equal(previewOf(look, MOODS[0], LABELS).rows[0]![0]!.color, '#000005')
})

test('growthOrder: 단계마다 움직임을 두 바퀴, 차례로', () => {
  assert.deepEqual(growthOrder([3, 2]), [
    [0, 0], [0, 1], [0, 2], [0, 0], [0, 1], [0, 2],
    [1, 0], [1, 1], [1, 0], [1, 1],
  ])
  assert.deepEqual(growthOrder([4], 1), [[0, 0], [0, 1], [0, 2], [0, 3]])
  assert.deepEqual(growthOrder([]), [])
})

test('stageBadge: 단계가 둘 이상이면 ★n', () => {
  assert.equal(stageBadge({ stages: 3 }), '★3')
  assert.equal(stageBadge({ stages: 1 }), null)
  assert.equal(stageBadge({}), null)
})

test('카드 함수는 자기 인자만 쓴다: 테마 카드가 펫을, 펫 카드가 테마를 부르지 않는다', () => {
  const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')
  const body = (name: string) => {
    const start = app.indexOf(`function ${name}(`)
    assert.ok(start >= 0, name)
    const next = app.indexOf('\nfunction ', start + 1)
    return app.slice(start, next < 0 ? undefined : next)
  }
  assert.doesNotMatch(body('themeCard'), /\bpet\b/)
  assert.match(body('card'), /stageBadge\(pet\)/)
})

test('성장 단계와 모션 칸의 이름표는 네 언어 모두에 있다', async () => {
  const { STRINGS } = await import('../site/strings.js')
  for (const lang of ['ko', 'en', 'ja', 'zh']) {
    const s = STRINGS[lang]
    for (const key of ['growTitle', 'motionTitle', 'motionIdle', 'motionWork']) assert.equal(typeof s[key], 'string', `${lang}.${key}`)
    assert.equal(s.stageRange.length, 3, lang)
    assert.equal(typeof s.stage(1), 'string', lang)
    assert.equal(typeof s.cut(1), 'string', lang)
  }
})

test('상세 화면에 큰 펫, 단계 칩, 성장 단계 칸, 모션 칸이 있다', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8')
  for (const id of ['d-canvas', 'd-chips', 'd-grow', 'd-grow-grid', 'd-motion', 'd-motion-grid']) assert.match(html, new RegExp(`id="${id}"`), id)
  assert.doesNotMatch(html, /id="d-stages"/)
})

test('부연 설명 문장은 화면에 넣지 않는다', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8')
  for (const key of ['pasteHint', 'likeHint', 'firstTime', 'needGithub', 'growHint', 'petNote', 'themePasteHint', 's1Body', 's2Body', 's3Body']) {
    assert.doesNotMatch(html, new RegExp(`data-t="${key}"`), key)
  }
})
