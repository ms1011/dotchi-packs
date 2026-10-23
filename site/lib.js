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
