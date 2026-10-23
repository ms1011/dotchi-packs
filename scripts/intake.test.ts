import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import type { IntakeIO, IssueEvent } from './intake.ts'
import { realIO, reply, runIntake, runSweep } from './intake.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/squirrel/${name}`, import.meta.url), 'utf8')
const shareBody = (id: string) => {
  const files = {
    'dotchi.json': JSON.stringify({ ...JSON.parse(fixture('dotchi.json')), id }),
    'art.json': fixture('art.json'),
    'lines.json': fixture('lines.json'),
    'grid/1.txt': 'g',
  }
  return `\`\`\`dotchi-pack\n${gzipSync(JSON.stringify({ format: 1, files })).toString('base64')}\n\`\`\``
}
const event = (title: string, body: string | null, number = 5, user = { id: 777, login: 'me' }): IssueEvent => ({
  issue: { number, title, body, user },
})
const NOW = new Date('2026-10-24T12:00:00Z')

/** 메모리 파일 + 호출 기록 */
const fakeIO = (files: Record<string, string> = {}, shares = 0, changed = true) => {
  const calls: string[] = []
  const comments: string[] = []
  const io: IntakeIO = {
    readText: async path => files[path] ?? null,
    writeText: async (path, text) => {
      calls.push(`write ${path}`)
      files[path] = text
    },
    removeDir: async path => {
      calls.push(`remove ${path}`)
      for (const k of Object.keys(files)) if (k.startsWith(`${path}/`)) delete files[k]
    },
    countShares: async () => shares,
    comment: async (_, body) => {
      calls.push('comment')
      comments.push(body)
    },
    close: async (_, reason) => {
      calls.push(`close ${reason}`)
    },
    commit: async message => {
      calls.push(`commit ${message}`)
      return changed
    },
    deploySite: async () => {
      calls.push('deploy')
    },
  }
  return { io, files, calls, comments }
}

test('share 통과: packs/<id>/ 파일, registry, 그다음 commit → comment → close(completed)', async () => {
  const { io, files, calls, comments } = fakeIO({ 'registry.json': '{"pets":{}}\n', 'packs/my-cat/old.txt': 'x' })
  await runIntake(event('share: my-cat', shareBody('my-cat')), io, NOW)
  assert.deepEqual(calls.slice(-3), ['commit share: my-cat (#5)', 'comment', 'close completed'])
  assert.ok(calls.indexOf('remove packs/my-cat') < calls.indexOf('write packs/my-cat/art.json'))
  assert.equal(files['packs/my-cat/old.txt'], undefined)
  assert.deepEqual(Object.keys(files).filter(k => k.startsWith('packs/')).sort(), [
    'packs/my-cat/art.json', 'packs/my-cat/dotchi.json', 'packs/my-cat/grid/1.txt', 'packs/my-cat/lines.json',
  ])
  const registry = JSON.parse(files['registry.json']!)
  assert.equal(registry.pets['my-cat'].ownerId, 777)
  assert.equal(registry.pets['my-cat'].created, '2026-10-24')
  assert.ok(files['registry.json']!.endsWith('}\n'))
  assert.ok(files['registry.json']!.includes('\n  "pets"'))
  assert.ok(comments[0]!.includes('https://ms1011.github.io/dotchi-packs/?pet=my-cat'))
  assert.ok(comments[0]!.includes('/dotchi install my-cat'))
})

test('업데이트 댓글은 처음 Issue를 알려 준다', async () => {
  const registry = { pets: { 'my-cat': { ownerId: 777, ownerLogin: 'me', issue: 3, created: '2026-10-20', updated: '2026-10-20', artHash: null, state: 'published' } } }
  const { io, comments } = fakeIO({ 'registry.json': JSON.stringify(registry) })
  await runIntake(event('share: my-cat', shareBody('my-cat'), 9), io, NOW)
  assert.ok(comments[0]!.includes('#3'))
})

test('거절: 파일·registry·commit 없음, comment 후 close(not_planned), 문구에 고칠 방법', async () => {
  const registry = { pets: { 'my-cat': { ownerId: 1, ownerLogin: 'other', issue: 3, created: '2026-10-20', updated: '2026-10-20', artHash: null, state: 'published' } } }
  const { io, calls, comments, files } = fakeIO({ 'registry.json': JSON.stringify(registry) })
  await runIntake(event('share: my-cat', shareBody('my-cat')), io, NOW)
  assert.deepEqual(calls, ['comment', 'close not_planned'])
  assert.ok(comments[0]!.includes('/dotchi share my-cat --as my-cat-2'))
  assert.equal(files['registry.json'], JSON.stringify(registry))
})

test('blocked.txt의 사용자와 하루 20번 제한', async () => {
  const blocked = fakeIO({ 'registry.json': '{"pets":{}}', 'blocked.txt': '# ids\n777\n' })
  await runIntake(event('share: my-cat', shareBody('my-cat')), blocked.io, NOW)
  assert.deepEqual(blocked.calls, ['comment', 'close not_planned'])
  const limited = fakeIO({ 'registry.json': '{"pets":{}}' }, 20)
  await runIntake(event('share: my-cat', shareBody('my-cat')), limited.io, NOW)
  assert.ok(limited.comments[0]!.includes('20'))
})

test('제목이 share:/unshare: 아님 → IO 호출 없음', async () => {
  const { io, calls } = fakeIO({ 'registry.json': '{"pets":{}}' })
  await runIntake(event('Bug: the turtle is too fast', 'hi'), io, NOW)
  assert.deepEqual(calls, [])
})

test('unshare 통과: packs/<id>/ 삭제, state withdrawn', async () => {
  const registry = { pets: { 'my-cat': { ownerId: 777, ownerLogin: 'me', issue: 3, created: '2026-10-20', updated: '2026-10-20', artHash: null, state: 'published' } } }
  const { io, calls, files } = fakeIO({ 'registry.json': JSON.stringify(registry), 'packs/my-cat/art.json': '{}' })
  await runIntake(event('unshare: my-cat', '<!-- dotchi-unshare v1 -->'), io, NOW)
  assert.equal(files['packs/my-cat/art.json'], undefined)
  assert.equal(JSON.parse(files['registry.json']!).pets['my-cat'].state, 'withdrawn')
  assert.deepEqual(calls.slice(-3), ['commit unshare: my-cat (#5)', 'comment', 'close completed'])
})

test('body null → noBundle 거절', async () => {
  const { io, calls, comments } = fakeIO({ 'registry.json': '{"pets":{}}' })
  await runIntake(event('share: my-cat', null), io, NOW)
  assert.deepEqual(calls, ['comment', 'close not_planned'])
  assert.ok(comments[0]!.includes('/dotchi share'))
})

test('본문이 셸에 들어가지 않는다', () => {
  const source = readFileSync(new URL('./intake.ts', import.meta.url), 'utf8')
  assert.ok(!source.includes('execSync('))
  assert.ok(!source.includes('shell: true'))
  assert.ok(source.includes("['issue', 'comment', String(issue), '--repo', repo, '--body-file', '-']"))
})

test('runSweep: 오래된 것부터, 하나가 실패해도 계속, 게시가 있으면 사이트를 한 번 다시 만든다', async () => {
  const { io, calls } = fakeIO({ 'registry.json': '{"pets":{}}' })
  const failing: IntakeIO = { ...io, comment: async (issue, body) => (issue === 6 ? Promise.reject(new Error('gh down')) : io.comment(issue, body)) }
  const issues = [event('share: cat-b', shareBody('cat-b'), 6).issue, event('share: cat-a', shareBody('cat-a'), 5).issue, event('hello', 'x', 4).issue]
  const result = await runSweep(issues, failing, NOW)
  assert.deepEqual(result, { committed: 2, failed: [6] })
  assert.ok(calls.indexOf('commit share: cat-a (#5)') < calls.indexOf('commit share: cat-b (#6)'))
  assert.equal(calls.filter(c => c === 'deploy').length, 1)
  assert.equal(calls.at(-1), 'deploy')
})

test('runSweep: 거절만 있으면 사이트를 다시 만들지 않는다', async () => {
  const { io, calls } = fakeIO({ 'registry.json': '{"pets":{}}' })
  await runSweep([event('share: my-cat', 'no bundle').issue], io, NOW)
  assert.ok(!calls.includes('deploy'))
})

test('바뀐 게 없는 다시 올리기: commit이 false여도 댓글과 닫기, 사이트는 다시 만들지 않는다', async () => {
  const { io, calls } = fakeIO({ 'registry.json': '{"pets":{}}' }, 0, false)
  await runSweep([event('share: my-cat', shareBody('my-cat')).issue], io, NOW)
  assert.deepEqual(calls.slice(-2), ['comment', 'close completed'])
  assert.ok(!calls.includes('deploy'))
})

test('badFile 댓글은 묶음 속 파일 이름을 그대로 옮기지 않는다', () => {
  const text = reply({ ok: false, reject: 'badFile', detail: '@everyone [x](https://evil) ' + 'a'.repeat(70000) }, 'my-cat')
  assert.ok(!text.includes('@everyone'))
  assert.ok(text.length < 400)
})

test('realIO.commit: 바뀐 게 없으면 false(오류 없음), 있으면 커밋하고 push', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'intake-git-'))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  git(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
  git(base, 'clone', '-q', join(base, 'remote.git'), 'work')
  const work = join(base, 'work')
  git(work, 'config', 'user.email', 't@example.com')
  git(work, 'config', 'user.name', 't')
  writeFileSync(join(work, 'registry.json'), '{"pets":{}}\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'init')
  git(work, 'push', '-q', '-u', 'origin', 'main')
  const io = realIO('ms1011/dotchi-packs', work)
  assert.equal(await io.commit('nothing'), false)
  await io.writeText('packs/my-cat/art.json', '{}')
  assert.equal(await io.commit('share: my-cat (#5)'), true)
  assert.ok(git(join(base, 'remote.git'), 'log', '--oneline', 'main').includes('share: my-cat (#5)'))
})

test('워크플로: 접수는 쓸고 지나가는 방식(예약·수동 실행, actions: write), 사이트 배포는 중간에 취소하지 않는다', () => {
  const intake = readFileSync(new URL('../.github/workflows/intake.yml', import.meta.url), 'utf8')
  assert.match(intake, /schedule:/)
  assert.match(intake, /workflow_dispatch:/)
  assert.match(intake, /actions: write/)
  assert.match(intake, /^    concurrency:/m)
  // Issue 이벤트는 Issue가 열린 순간의 커밋을 준다: 앞선 접수가 막 push한 것을 보려면 최신 main을 받아야 한다
  assert.match(intake, /uses: actions\/checkout@v4\n        with:\n          ref: main\n/)
  const site = readFileSync(new URL('../.github/workflows/site.yml', import.meta.url), 'utf8')
  assert.match(site, /cancel-in-progress: false/)
})
