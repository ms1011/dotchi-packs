// 사이트의 순수 함수: 브라우저와 테스트(node:test)에서 함께 쓴다

export const LANGS = ['ko', 'en', 'ja', 'zh']
const ID = /^[a-z0-9-]{1,32}$/

/** 언어별 값 고르기 (플러그인과 같은 규칙): 지금 언어 → 영어 → 처음 나오는 값. 문자열이면 그대로 */
export const pick = (byLang, lang) =>
  typeof byLang === 'string' ? byLang : byLang[lang] ?? byLang.en ?? LANGS.map(l => byLang[l]).find(v => v !== undefined) ?? ''

/** 화면 언어: ?lang= → 이전에 고른 값 → 브라우저 언어 → 영어 */
export const detectLang = ({ query, saved, languages }) => {
  const asked = new URLSearchParams(query).get('lang')
  if (LANGS.includes(asked)) return asked
  if (LANGS.includes(saved)) return saved
  for (const tag of languages ?? []) {
    const code = String(tag).slice(0, 2).toLowerCase()
    if (LANGS.includes(code)) return code
  }
  return 'en'
}

/** 인기순(좋아요, 같으면 최신) / 최신순(올린 날, 같으면 좋아요). 원래 배열은 그대로 */
export const sortPets = (pets, mode) =>
  [...pets].sort((a, b) =>
    mode === 'new'
      ? b.created.localeCompare(a.created) || b.likes - a.likes
      : b.likes - a.likes || b.created.localeCompare(a.created),
  )

/** 이름(모든 언어), id, 작성자, 소개로 찾기. 대소문자 무시 */
export const filterPets = (pets, query) => {
  const q = query.trim().toLowerCase()
  if (q === '') return pets
  const names = pet => (typeof pet.name === 'string' ? [pet.name] : Object.values(pet.name))
  return pets.filter(pet => [...names(pet), pet.id, pet.owner, pet.description].some(text => String(text).toLowerCase().includes(q)))
}

/** 주소의 ?pet=<id> (id 모양일 때만) */
export const petFromQuery = search => {
  const id = new URLSearchParams(search).get('pet')
  return id !== null && ID.test(id) ? id : null
}

export const installCommand = id => `/dotchi install ${id}`

/** GitHub Issue 목록(REST) 한 페이지에서 Issue 번호 → 👍 수. PR이나 모양이 틀린 항목, 오류 응답은 건너뛴다 */
export const likesFromIssues = items => {
  const likes = {}
  if (!Array.isArray(items)) return likes
  for (const item of items) {
    const count = item?.reactions?.['+1']
    if (item?.pull_request !== undefined || !Number.isInteger(item?.number) || !Number.isInteger(count)) continue
    likes[item.number] = count
  }
  return likes
}

/** 최신 👍 수로 바꾼 새 목록. 모르는 Issue는 빌드 때 숫자 그대로 */
export const applyLikes = (pets, likes) => pets.map(pet => (likes[pet.issue] === undefined ? pet : { ...pet, likes: likes[pet.issue] }))

/* ---------- 상태 줄 테마 ---------- */

const COLOR = /^#[0-9a-f]{6}$/i
/** 'pet'(펫 색)이거나 이상한 값이면 대신 쓰는 강조색: 라벤더 */
const FALLBACK_ACCENT = '#b8a6ff'
/** 플러그인의 기본 모양과 같다: 빠진 칸은 이것으로 */
export const DEFAULT_LOOK = {
  colors: { ok: '#8fd9b6', warn: '#ffd86b', danger: '#ff8fa3', dim: '#9a9ab0', accent: 'pet' },
  faces: { ok: '(•ᴗ•)', warn: '(•_•;)', danger: '(×_×)' },
  hearts: ['♥', '♡'],
  bar: ['▰', '▱'],
  symbols: { week: '⚡', tired: '🥱', reset: '↻', time: '⏱' },
}

/** 주소의 ?theme=<id> (id 모양일 때만) */
export const themeFromQuery = search => {
  const id = new URLSearchParams(search).get('theme')
  return id !== null && ID.test(id) ? id : null
}

export const themeInstallCommand = id => `/dotchi theme install ${id}`

/** 미리 보기의 세 장면: 괜찮을 때, 배부를 때, 꽉 찼을 때 (컨텍스트 %, 주간 %) */
export const MOODS = [
  { level: 'ok', context: 40, week: 41 },
  { level: 'warn', context: 78, week: 83 },
  { level: 'danger', context: 93, week: 97 },
]

const fill = (pair, percent, cells) => {
  const k = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))
  return pair[0].repeat(k) + pair[1].repeat(cells - k)
}

/**
 * 한 장면의 미리 보기: 상태 줄(글자만, 터미널처럼 색 없이)과 옆 패널 카드 세 줄([{ text, color }] 조각).
 * 색은 #rrggbb만 쓴다 (페이지 스타일에 그대로 넣으므로). labels: { full, week }
 */
export const previewOf = (look, mood, labels) => {
  const pick2 = (key, fallback) => (Array.isArray(look?.[key]) && look[key].length === 2 ? look[key] : fallback)
  const colors = { ...DEFAULT_LOOK.colors, ...look?.colors }
  const faces = { ...DEFAULT_LOOK.faces, ...look?.faces }
  const symbols = { ...DEFAULT_LOOK.symbols, ...look?.symbols }
  const hearts = pick2('hearts', DEFAULT_LOOK.hearts)
  const bar = pick2('bar', DEFAULT_LOOK.bar)
  const paint = key => {
    const value = colors[key]
    if (key === 'accent') return COLOR.test(value) ? value : FALLBACK_ACCENT
    return COLOR.test(value) ? value : DEFAULT_LOOK.colors[key]
  }
  const { level, context, week } = mood
  const weekLevel = week >= 95 ? 'danger' : week >= 80 ? 'warn' : 'ok'
  const face = level === 'ok' ? '' : ` ${faces[level]}${level === 'danger' ? ' /compact' : ''}`
  const tired = weekLevel === 'danger' ? ` ${symbols.tired}` : ''
  const status = `🐾 ${fill(hearts, context, 5)} ${context}%${face} · ${symbols.week} ${week}%${tired} · ⎇ main`
  const rows = [
    [
      { text: faces[level], color: level === 'ok' ? paint('accent') : paint(level) },
      { text: ` ${labels.full} `, color: paint('dim') },
      { text: `${fill(bar, context, 10)} ${context}%`, color: paint(level) },
      { text: level === 'danger' ? ' /compact' : '', color: paint('dim') },
    ],
    [
      { text: symbols.week, color: paint(weekLevel) },
      { text: ` ${labels.week} `, color: paint('dim') },
      { text: `${fill(bar, week, 10)} ${week}%`, color: paint(weekLevel) },
      { text: weekLevel === 'danger' ? ` ${symbols.tired}` : ` ${symbols.reset} 09:00`, color: paint('dim') },
    ],
    [{ text: `${symbols.time} 12m · Opus 5.5 · 1M`, color: paint('dim') }],
  ]
  return { status, rows: rows.map(row => row.filter(part => part.text !== '')) }
}

/**
 * 자라는 모습의 순서: 단계마다 움직임 컷을 loops바퀴 돈 뒤 다음 단계로.
 * stageWork는 단계별 움직임 컷 수. [[단계 번호(0부터), 컷 번호], …]
 */
export const growthOrder = (stageWork, loops = 2) =>
  stageWork.flatMap((count, stage) =>
    Array.from({ length: loops * count }, (_, i) => [stage, i % count]),
  )
