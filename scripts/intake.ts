import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { RejectCode } from './bundle.ts'
import type { Decision, Registry } from './decide.ts'
import { decide, parseTitle, SHARES_PER_DAY } from './decide.ts'

export const SITE = 'https://ms1011.github.io/dotchi-packs'

export type IssueEvent = { issue: { number: number; title: string; body: string | null; user: { id: number; login: string } } }

/** 접수가 바깥과 주고받는 것: 저장소 파일, GitHub Issue, git */
export type IntakeIO = {
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  removeDir(path: string): Promise<void>
  countShares(login: string, issue: number, since: Date): Promise<number>
  comment(issue: number, body: string): Promise<void>
  close(issue: number, reason: 'completed' | 'not_planned'): Promise<void>
  /** 바뀐 게 있으면 커밋하고 push. 바뀐 게 없으면 false */
  commit(message: string): Promise<boolean>
  /** 사이트를 다시 만든다 (봇의 push는 다른 워크플로를 깨우지 않아서) */
  deploySite(): Promise<void>
}

const REJECTS: Record<RejectCode, (id: string, detail: string) => string> = {
  noBundle: () =>
    "Couldn't find a pet in this issue. Share from Claude Code with `/dotchi share <character>` instead of opening an issue by hand.",
  badBundle: () => 'The pet in this issue is damaged. Run `/dotchi share <character>` again.',
  tooBig: () => 'This pet is too big to share. A shared pack must stay under 512 KB unpacked.',
  badFile: () =>
    "This pet has a file the site doesn't take. Only dotchi.json, art.json, lines.json and up to 9 grid/*.txt files are shared; `/dotchi share` picks them for you.",
  badPack: (id, detail) => `${detail} in this pet is broken. Fix it with \`/dotchi edit ${id}\`, then share again.`,
  idMismatch: (id, detail) =>
    `The title says \`${id}\` but the pet inside is \`${detail}\`. Run \`/dotchi share\` again instead of editing the issue.`,
  tooLong: (id, detail) =>
    `The pet's ${detail} is too long for the site (names 40 characters, description 300, each line 80, 30 lines per kind). Shorten it with \`/dotchi edit ${id}\`, then share again.`,
  blocked: () => "This account can't share pets on the dotchi site.",
  rateLimited: () => `You've shared ${SHARES_PER_DAY} pets in the last 24 hours. Try again tomorrow.`,
  taken: id => `\`${id}\` already belongs to someone else on the dotchi site. Try \`/dotchi share ${id} --as ${id}-2\`.`,
  sameArt: (_, detail) =>
    `This picture is the same as \`${detail}\`, which someone else shared. Change the picture before sharing it as your own.`,
  notOwner: id => `Only the person who shared \`${id}\` can take it down.`,
  notFound: id => `There's no shared pet called \`${id}\` on the site.`,
}

/** Issue에 남길 댓글 (영어) */
export const reply = (d: Decision, id: string): string => {
  if (!d.ok) return REJECTS[d.reject](id, d.detail ?? '')
  const page = `${SITE}/?pet=${id}`
  if (d.kind === 'withdrawn') return `Took down \`${id}\`. You can share it again with \`/dotchi share ${id}\`.`
  const likes = d.kind === 'updated' && d.homeIssue !== null ? ` Likes are counted on #${d.homeIssue}.` : ' 👍 this issue to like it.'
  const verb = d.kind === 'created' ? 'is on' : 'was updated on'
  return `\`${id}\` ${verb} the dotchi site: ${page}\n\nInstall it with \`/dotchi install ${id}\`.${likes}\nThe page shows up within a minute or two.`
}

const blockedIds = (text: string | null): Set<number> =>
  new Set(
    (text ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
      .map(Number)
      .filter(Number.isInteger),
  )

/** 이 Issue 하나를 처리한다: 제목이 share:/unshare:가 아니면 아무것도 하지 않는다. 저장소가 바뀌었으면 true */
export const runIntake = async (event: IssueEvent, io: IntakeIO, now: Date): Promise<boolean> => {
  const { issue } = event
  const title = parseTitle(issue.title)
  if (title === null) return false
  const registry = JSON.parse((await io.readText('registry.json')) ?? '{"pets":{}}') as Registry
  const blocked = blockedIds(await io.readText('blocked.txt'))
  const shares =
    title.kind === 'share' ? await io.countShares(issue.user.login, issue.number, new Date(now.getTime() - 24 * 3600 * 1000)) : 0
  const request = {
    kind: title.kind,
    id: title.id,
    issue: issue.number,
    userId: issue.user.id,
    login: issue.user.login,
    body: issue.body ?? '',
    today: now.toISOString().slice(0, 10),
  }
  const decision = decide(request, registry, blocked, shares)
  let committed = false
  if (decision.ok) {
    const dir = `packs/${title.id}`
    await io.removeDir(dir)
    if (decision.pack !== undefined) {
      for (const [name, text] of Object.entries(decision.pack.files)) await io.writeText(`${dir}/${name}`, text)
    }
    await io.writeText('registry.json', `${JSON.stringify(decision.registry, null, 2)}\n`)
    committed = await io.commit(`${title.kind}: ${title.id} (#${issue.number})`)
  }
  await io.comment(issue.number, reply(decision, title.id))
  await io.close(issue.number, decision.ok ? 'completed' : 'not_planned')
  return committed
}

/**
 * 열린 share:/unshare: Issue를 오래된 것부터 모두 처리한다. 하나가 실패해도 나머지는 계속하고,
 * 실패한 Issue는 열린 채로 두어 다음 실행이 다시 처리한다. 게시가 하나라도 있으면 사이트를 한 번 다시 만든다
 */
export const runSweep = async (
  issues: IssueEvent['issue'][],
  io: IntakeIO,
  now: Date,
): Promise<{ committed: number; failed: number[] }> => {
  let committed = 0
  const failed: number[] = []
  // 커밋 뒤 댓글에서 실패해도 게시는 된 것이라 사이트를 다시 만들어야 한다: 커밋은 여기서 센다
  const counting: IntakeIO = {
    ...io,
    commit: async message => {
      const changed = await io.commit(message)
      if (changed) committed++
      return changed
    },
  }
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    try {
      await runIntake({ issue }, counting, now)
    } catch (error) {
      console.error(`::error::Issue #${issue.number}: ${String(error)}`)
      failed.push(issue.number)
    }
  }
  if (committed > 0) await io.deploySite()
  return { committed, failed }
}

/** Actions에서 쓰는 실제 IO: 작업 폴더(cwd)의 파일, gh, git. 명령은 인자 배열로만 (셸 없이) */
export const realIO = (repo: string, cwd = '.'): IntakeIO => {
  const gh = (args: string[], input?: string) => execFileSync('gh', args, { input, encoding: 'utf8', cwd })
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const at = (path: string) => join(cwd, path)
  return {
    readText: path => readFile(at(path), 'utf8').catch(() => null),
    writeText: async (path, text) => {
      await mkdir(dirname(at(path)), { recursive: true })
      await writeFile(at(path), text)
    },
    removeDir: path => rm(at(path), { recursive: true, force: true }),
    countShares: async (login, issue, since) => {
      const jq = '.[] | select(.pull_request == null) | [.number, .title, .created_at] | @tsv'
      const out = gh(['api', '-X', 'GET', `repos/${repo}/issues`, '-f', `creator=${login}`, '-f', 'state=all', '-f', `since=${since.toISOString()}`, '--paginate', '--jq', jq])
      return out
        .split('\n')
        .filter(Boolean)
        .map(line => line.split('\t'))
        .filter(([number, title, created]) => Number(number) !== issue && title!.startsWith('share:') && new Date(created!) >= since).length
    },
    comment: async (issue, body) => {
      gh(['issue', 'comment', String(issue), '--repo', repo, '--body-file', '-'], body)
    },
    close: async (issue, reason) => {
      gh(['issue', 'close', String(issue), '--repo', repo, '--reason', reason === 'completed' ? 'completed' : 'not planned'])
    },
    commit: async message => {
      git(['add', '-A', '--', 'registry.json'])
      // packs/가 아직 없거나(첫 게시 전) 통째로 지워졌을 수 있다: 맞는 파일이 없으면 git이 실패하므로 따로
      try {
        git(['add', '-A', '--', 'packs'])
      } catch {}
      if (git(['diff', '--cached', '--name-only']).trim() === '') return false
      git(['commit', '-q', '-m', message])
      git(['pull', '-q', '--rebase'])
      git(['push', '-q'])
      return true
    },
    deploySite: async () => {
      gh(['workflow', 'run', 'site.yml', '--repo', repo])
    },
  }
}

/** 열린 share:/unshare: Issue 목록 (PR 제외) */
const openRequests = (repo: string): IssueEvent['issue'][] => {
  const jq =
    '.[] | select(.pull_request == null) | select(.title | test("^(un)?share:")) | {number, title, body, user: {id: .user.id, login: .user.login}} | @json'
  const out = execFileSync('gh', ['api', '-X', 'GET', `repos/${repo}/issues`, '-f', 'state=open', '-f', 'per_page=100', '--paginate', '--jq', jq], {
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as IssueEvent['issue'])
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY ?? 'ms1011/dotchi-packs'
  const { failed } = await runSweep(openRequests(repo), realIO(repo), new Date())
  if (failed.length > 0) process.exitCode = 1
}
