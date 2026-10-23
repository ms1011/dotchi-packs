import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
  commit(message: string): Promise<void>
}

const REJECTS: Record<RejectCode, (id: string, detail: string) => string> = {
  noBundle: () =>
    "Couldn't find a pet in this issue. Share from Claude Code with `/dotchi share <character>` instead of opening an issue by hand.",
  badBundle: () => 'The pet in this issue is damaged. Run `/dotchi share <character>` again.',
  tooBig: () => 'This pet is too big to share. A shared pack must stay under 512 KB unpacked.',
  badFile: (_, detail) =>
    `This pet has a file the site doesn't take (${detail}). Only dotchi.json, art.json, lines.json and grid/*.txt are shared; \`/dotchi share\` picks them for you.`,
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

/** 이 Issue 하나를 처리한다: 제목이 share:/unshare:가 아니면 아무것도 하지 않는다 */
export const runIntake = async (event: IssueEvent, io: IntakeIO, now: Date): Promise<void> => {
  const { issue } = event
  const title = parseTitle(issue.title)
  if (title === null) return
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
  if (decision.ok) {
    const dir = `packs/${title.id}`
    await io.removeDir(dir)
    if (decision.pack !== undefined) {
      for (const [name, text] of Object.entries(decision.pack.files)) await io.writeText(`${dir}/${name}`, text)
    }
    await io.writeText('registry.json', `${JSON.stringify(decision.registry, null, 2)}\n`)
    await io.commit(`${title.kind}: ${title.id} (#${issue.number})`)
  }
  await io.comment(issue.number, reply(decision, title.id))
  await io.close(issue.number, decision.ok ? 'completed' : 'not_planned')
}

/** Actions에서 쓰는 실제 IO: 작업 폴더의 파일, gh, git. 명령은 인자 배열로만 (셸 없이) */
const realIO = (repo: string): IntakeIO => {
  const gh = (args: string[], input?: string) => execFileSync('gh', args, { input, encoding: 'utf8' })
  const git = (args: string[]) => execFileSync('git', args, { stdio: 'inherit' })
  return {
    readText: path => readFile(path, 'utf8').catch(() => null),
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    removeDir: path => rm(path, { recursive: true, force: true }),
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
      git(['add', '-A', 'packs', 'registry.json'])
      git(['commit', '-m', message])
      git(['pull', '--rebase'])
      git(['push'])
    },
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8')) as IssueEvent
  await runIntake(event, realIO(process.env.GITHUB_REPOSITORY ?? 'ms1011/dotchi-packs'), new Date())
}
