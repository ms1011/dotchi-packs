import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { artHash, checkPack, decodeBundle, extractBundle } from './bundle.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/squirrel/${name}`, import.meta.url), 'utf8')
const squirrel = () => ({ 'dotchi.json': fixture('dotchi.json'), 'art.json': fixture('art.json'), 'lines.json': fixture('lines.json') })
const make = (files: Record<string, string>, format = 1) => gzipSync(JSON.stringify({ format, files })).toString('base64')
const body = (base64: string) => `<!-- dotchi-share v1 -->\n\n**x**\n\n<details><summary>pack</summary>\n\n\`\`\`dotchi-pack\n${base64}\n\`\`\`\n</details>`
const withMeta = (change: Record<string, unknown>) => ({ ...squirrel(), 'dotchi.json': JSON.stringify({ ...JSON.parse(fixture('dotchi.json')), ...change }) })
const withLines = (lines: unknown) => ({ ...squirrel(), 'lines.json': JSON.stringify(lines) })

test('정상 묶음 → Pack', () => {
  const base64 = extractBundle(body(make(squirrel())))
  assert.equal(typeof base64, 'string')
  const files = decodeBundle(base64 as string)
  const pack = checkPack(files as Record<string, string>, 'squirrel')
  assert.ok('meta' in pack)
  assert.equal(pack.meta.id, 'squirrel')
  assert.deepEqual(Object.keys(pack.files).sort(), ['art.json', 'dotchi.json', 'lines.json'])
})

test('블록 없음 → noBundle, 두 개 → badBundle', () => {
  assert.deepEqual(extractBundle('hello'), { reject: 'noBundle' })
  assert.deepEqual(extractBundle(`${body('QUJD')}\n${body('QUJD')}`), { reject: 'badBundle' })
})

test('base64가 아니거나 gzip이 아니거나 format이 틀리면 badBundle', () => {
  assert.equal((decodeBundle('not base64 !!') as { reject: string }).reject, 'badBundle')
  assert.equal((decodeBundle(Buffer.from('plain').toString('base64')) as { reject: string }).reject, 'badBundle')
  assert.equal((decodeBundle(make(squirrel(), 2)) as { reject: string }).reject, 'badBundle')
})

test('gzip 폭탄 → tooBig, 너무 긴 base64 → tooBig', () => {
  const bomb = gzipSync(Buffer.alloc(2_000_000)).toString('base64')
  assert.ok(bomb.length < 60000)
  assert.equal((decodeBundle(bomb) as { reject: string }).reject, 'tooBig')
  assert.equal((decodeBundle('A'.repeat(60001)) as { reject: string }).reject, 'tooBig')
})

test('허용 안 된 파일 이름 → badFile', () => {
  for (const name of ['../x', 'source/a.png', 'grid/../../a.txt', '/etc/passwd', 'grid/1.TXT']) {
    assert.deepEqual(decodeBundle(make({ ...squirrel(), [name]: 'x' })), { reject: 'badFile', detail: name })
  }
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`grid/${i}.txt`, 'g']))
  assert.equal((decodeBundle(make({ ...squirrel(), ...many })) as { reject: string }).reject, 'badFile')
})

test('제목 id와 팩 id 다름 → idMismatch', () => {
  assert.deepEqual(checkPack(squirrel(), 'turtle'), { reject: 'idMismatch', detail: 'squirrel' })
})

test('깨진 파일 → badPack, detail은 파일 이름', () => {
  assert.deepEqual(checkPack({ ...squirrel(), 'art.json': '{"idle": 1}' }, 'squirrel'), { reject: 'badPack', detail: 'art.json' })
  assert.deepEqual(checkPack({ ...squirrel(), 'dotchi.json': '{}' }, 'squirrel'), { reject: 'badPack', detail: 'dotchi.json' })
  const { 'lines.json': _, ...noLines } = squirrel()
  assert.deepEqual(checkPack(noLines, 'squirrel'), { reject: 'badPack', detail: 'lines.json' })
})

test('글자 제한 → tooLong', () => {
  const set = (spinner: string[]) => ({ ko: { spinner, idle: ['a'], ending: ['b'] } })
  const cases: [Record<string, string>, string][] = [
    [withMeta({ name: { ko: 'a'.repeat(41) } }), 'name'],
    [withMeta({ description: 'a'.repeat(301) }), 'description'],
    [withLines(set(['a'.repeat(81)])), 'lines'],
    [withLines(set(Array.from({ length: 31 }, () => 'a'))), 'lines'],
  ]
  for (const [files, detail] of cases) assert.deepEqual(checkPack(files, 'squirrel'), { reject: 'tooLong', detail })
  assert.ok('meta' in checkPack(withMeta({ name: { ko: 'a'.repeat(40) }, description: 'a'.repeat(300) }), 'squirrel'))
})

test('artHash는 같은 그림이면 같고 한 칸 다르면 다르다', () => {
  const art = JSON.parse(fixture('art.json'))
  const changed = structuredClone(art)
  changed.idle[0][0] = changed.idle[0][0] === null ? 'ffffff' : null
  assert.equal(artHash(art), artHash(structuredClone(art)))
  assert.notEqual(artHash(art), artHash(changed))
})

test('BUNDLE_FILE은 플러그인의 것과 같다', async () => {
  const { BUNDLE_FILE } = await import('./bundle.ts')
  const plugin = readFileSync(new URL('../dotchi/hooks/share.ts', import.meta.url), 'utf8')
  assert.ok(plugin.includes(`export const BUNDLE_FILE = ${BUNDLE_FILE}`))
})
