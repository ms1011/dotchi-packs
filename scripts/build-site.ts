import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseArt } from '../dotchi/hooks/dots.ts'
import { LANGS, parseLines, parseMeta } from '../dotchi/hooks/packs.ts'
import { parseTheme } from '../dotchi/hooks/theme.ts'
import type { Art, Lang, Look, PackLines, PackMeta, ThemeMeta } from '../dotchi/types/index.d.ts'
import type { Registry } from './decide.ts'

const PACK_JSON = ['dotchi.json', 'art.json', 'lines.json']

export type IndexPet = {
  id: string
  name: string | Partial<Record<Lang, string>>
  description: string
  owner: string
  created: string
  updated: string
  frames: number
  langs: Lang[]
  frameMs: number
  likes: number
  /** 처음 Issue 번호: 좋아요 버튼이 여기로 간다 */
  issue: number
}
/** 상태 줄 테마: 미리 보기를 그리도록 모양(look)을 함께 싣는다 */
export type IndexTheme = {
  id: string
  name: string | Partial<Record<Lang, string>>
  description: string
  owner: string
  created: string
  updated: string
  likes: number
  issue: number
  look: Look
}
/**
 * 사이트의 index.json. taken·takenThemes는 상태와 상관없이 쓰인 id → 주인의 GitHub 숫자 id
 * (플러그인이 share 전에 본다). 펫과 테마는 id를 따로 쓴다
 */
export type SiteIndex = { pets: IndexPet[]; taken: Record<string, number>; themes: IndexTheme[]; takenThemes: Record<string, number> }
type ReadPack = (id: string) => { meta: PackMeta; art: Art; lines: PackLines } | null
type ReadTheme = (id: string) => { meta: ThemeMeta; look: Look } | null

/** 게시 중이고 팩을 읽을 수 있는 펫만 목록에 */
export const buildIndex = (
  registry: Registry,
  readPack: ReadPack,
  likes: Record<number, number>,
  readTheme: ReadTheme = () => null,
): SiteIndex => {
  const pets: IndexPet[] = []
  for (const [id, entry] of Object.entries(registry.pets)) {
    if (entry.state !== 'published' || entry.issue === null) continue
    const pack = readPack(id)
    if (pack === null) continue
    pets.push({
      id,
      name: pack.meta.name,
      description: pack.meta.description ?? '',
      owner: entry.ownerLogin,
      created: entry.created,
      updated: entry.updated,
      frames: pack.art.work.length,
      langs: LANGS.filter(lang => pack.lines[lang] !== undefined),
      frameMs: pack.meta.frameMs ?? 250,
      likes: likes[entry.issue] ?? 0,
      issue: entry.issue,
    })
  }
  const taken = Object.fromEntries(Object.entries(registry.pets).map(([id, entry]) => [id, entry.ownerId]))
  const themes: IndexTheme[] = []
  for (const [id, entry] of Object.entries(registry.themes ?? {})) {
    if (entry.state !== 'published' || entry.issue === null) continue
    const theme = readTheme(id)
    if (theme === null) continue
    themes.push({
      id,
      name: theme.meta.name,
      description: theme.meta.description ?? '',
      owner: entry.ownerLogin,
      created: entry.created,
      updated: entry.updated,
      likes: likes[entry.issue] ?? 0,
      issue: entry.issue,
      look: theme.look,
    })
  }
  const takenThemes = Object.fromEntries(Object.entries(registry.themes ?? {}).map(([id, entry]) => [id, entry.ownerId]))
  return { pets, taken, themes, takenThemes }
}

/** 처음 Issue들의 👍 수를 한 번에 묻는 GraphQL (호출하는 쪽에서 100개씩 나눈다) */
export const likesQuery = (issues: number[]): string =>
  `query { repository(owner: "ms1011", name: "dotchi-packs") { ${issues
    .map(n => `i${n}: issue(number: ${n}) { reactions(content: THUMBS_UP) { totalCount } }`)
    .join(' ')} } }`

export type BuildDeps = {
  fetchLikes(issues: number[]): Promise<Record<number, number>>
  zip(cwd: string, id: string, out: string): Promise<void>
}

/** outDir에 사이트를 만든다: site/ 파일, 팩 JSON, 팩 zip, 테마 theme.json, index.json */
export const buildSite = async (outDir: string, deps: BuildDeps, root = '.'): Promise<void> => {
  const out = resolve(outDir)
  const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')) as Registry
  const texts = new Map<string, Record<string, string>>()
  for (const id of Object.keys(registry.pets)) {
    const files: Record<string, string> = {}
    for (const name of PACK_JSON) {
      const text = await readFile(join(root, 'packs', id, name), 'utf8').catch(() => null)
      if (text !== null) files[name] = text
    }
    texts.set(id, files)
  }
  const readPack: ReadPack = id => {
    const files = texts.get(id) ?? {}
    const meta = parseMeta(files['dotchi.json'] ?? '')
    const art = parseArt(files['art.json'] ?? '')
    const lines = parseLines(files['lines.json'] ?? '')
    return meta === null || art === null || lines === null ? null : { meta, art, lines }
  }
  const themeTexts = new Map<string, string>()
  for (const id of Object.keys(registry.themes ?? {})) {
    const text = await readFile(join(root, 'themes', id, 'theme.json'), 'utf8').catch(() => null)
    if (text !== null) themeTexts.set(id, text)
  }
  const readTheme: ReadTheme = id => parseTheme(themeTexts.get(id) ?? '')
  const issues = [...Object.values(registry.pets), ...Object.values(registry.themes ?? {})].flatMap(entry =>
    entry.state === 'published' && entry.issue !== null ? [entry.issue] : [],
  )
  const likes = await deps.fetchLikes(issues).catch((error: unknown) => {
    console.warn(`::warning::Couldn't count likes: ${String(error)}`)
    return {}
  })
  const index = buildIndex(registry, readPack, likes, readTheme)

  await mkdir(out, { recursive: true })
  await cp(join(root, 'site'), out, { recursive: true })
  for (const pet of index.pets) {
    await mkdir(join(out, 'packs', pet.id), { recursive: true })
    for (const [name, text] of Object.entries(texts.get(pet.id)!)) await writeFile(join(out, 'packs', pet.id, name), text)
    await deps.zip(resolve(root, 'packs'), pet.id, join(out, 'packs', `${pet.id}.dotchi.zip`))
  }
  for (const theme of index.themes) {
    await mkdir(join(out, 'themes', theme.id), { recursive: true })
    await writeFile(join(out, 'themes', theme.id, 'theme.json'), themeTexts.get(theme.id)!)
  }
  await writeFile(join(out, 'index.json'), JSON.stringify(index))
}

/** gh로 좋아요 수를 묻는다 (100개씩) */
const fetchLikes = async (issues: number[]): Promise<Record<number, number>> => {
  const likes: Record<number, number> = {}
  for (let i = 0; i < issues.length; i += 100) {
    const chunk = issues.slice(i, i + 100)
    const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${likesQuery(chunk)}`], { encoding: 'utf8' })
    const repo = (JSON.parse(out) as { data: { repository: Record<string, { reactions: { totalCount: number } } | null> } }).data.repository
    for (const n of chunk) likes[n] = repo[`i${n}`]?.reactions.totalCount ?? 0
  }
  return likes
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildSite(process.argv[2] ?? '_site', {
    fetchLikes,
    zip: async (cwd, id, file) => void execFileSync('zip', ['-qr', file, id], { cwd }),
  })
}
