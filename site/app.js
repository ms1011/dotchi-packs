// dotchi 펫 사이트: index.json으로 목록을 그리고, 펫의 art.json·lines.json은 필요할 때 받는다.
// 팩에서 온 글(이름·소개·대사·작성자)은 모두 textContent로만 넣는다. innerHTML은 strings.js 문구와 아이콘뿐
import { LANG_NAMES, STRINGS } from './strings.js'
import { applyLikes, detectLang, filterPets, installCommand, LANGS, likesFromIssues, petFromQuery, pick, sortPets } from './lib.js'

const REPO = 'https://github.com/ms1011/dotchi-packs'
const ISSUES_API = 'https://api.github.com/repos/ms1011/dotchi-packs/issues'
/** 좋아요를 다시 물을 최소 간격: 로그인 없는 GitHub API는 IP당 시간당 60번까지라 아껴 쓴다 */
const LIKES_EVERY_MS = 10000
const HEART =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 14s-5.5-3.3-5.5-7.2A3.1 3.1 0 0 1 8 4.6a3.1 3.1 0 0 1 5.5 2.2C13.5 10.7 8 14 8 14Z"/></svg>'
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>'
const CARD =
  '<div class="stage"><canvas width="32" height="32"></canvas></div><h3><span class="title"></span></h3><div class="meta"><span class="who"></span><span class="likes"></span></div>'
const HEX = /^[0-9a-f]{6}$/

const $ = id => document.getElementById(id)
const readSaved = () => {
  try {
    return localStorage.getItem('dotchi-lang')
  } catch {
    return null
  }
}
let lang = detectLang({ query: location.search, saved: readSaved(), languages: navigator.languages ?? [navigator.language] })
let sort = 'likes'
let pets = []
let current = null
const t = key => STRINGS[lang][key]
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fmtDate = day => new Date(`${day}T00:00:00`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : lang, { year: 'numeric', month: 'short', day: 'numeric' })

/* ---------- 그림 ---------- */

const frameCanvas = frame => {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  frame.forEach((row, y) =>
    row.forEach((px, x) => {
      if (typeof px === 'string' && HEX.test(px)) {
        ctx.fillStyle = `#${px}`
        ctx.fillRect(x, y, 1, 1)
      }
    }),
  )
  return canvas
}
const artCache = new Map()
/** 펫의 컷들 (멈춤 1장 + 움직임) */
const framesOf = id => {
  if (!artCache.has(id)) {
    artCache.set(
      id,
      fetch(`packs/${id}/art.json`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then(art => ({ idle: frameCanvas(art.idle), work: art.work.map(frameCanvas) })),
    )
  }
  return artCache.get(id)
}
const linesCache = new Map()
const linesOf = id => {
  if (!linesCache.has(id)) linesCache.set(id, fetch(`packs/${id}/lines.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({})))
  return linesCache.get(id)
}
const paint = (canvas, src) => {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 32, 32)
  ctx.drawImage(src, 0, 0)
}
/** 움직임 컷을 돌린다. 멈추는 함수를 돌려준다 */
const play = (canvas, frames, frameMs) => {
  let i = 0
  paint(canvas, frames.work[0])
  const timer = setInterval(() => paint(canvas, frames.work[++i % frames.work.length]), frameMs)
  return () => clearInterval(timer)
}

/* ---------- 목록 ---------- */

const grid = $('grid')
const stops = []
const observer =
  'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          entry.target.dispatchEvent(new Event('visible'))
        }
      })
    : null

const showNotice = key => {
  grid.replaceChildren()
  const p = document.createElement('p')
  p.className = 'notice'
  p.textContent = t(key)
  grid.append(p)
}

function drawList() {
  stops.splice(0).forEach(stop => stop())
  const list = sortPets(filterPets(pets, $('q').value), sort)
  $('count').textContent = t('count')(list.length)
  if (list.length === 0) return showNotice('empty')
  grid.replaceChildren(...list.map(card))
}

function card(pet) {
  const el = document.createElement('button')
  el.className = 'card'
  el.innerHTML = CARD
  el.querySelector('.title').textContent = pick(pet.name, lang)
  if (pet.created === localToday()) {
    const badge = document.createElement('span')
    badge.className = 'new-badge'
    badge.textContent = 'NEW'
    el.querySelector('h3').append(badge)
  }
  el.querySelector('.who').textContent = `@${pet.owner}`
  const likes = el.querySelector('.likes')
  likes.innerHTML = HEART
  likes.append(String(pet.likes))
  const canvas = el.querySelector('canvas')
  let frames = null
  let stop = null
  const load = () =>
    framesOf(pet.id)
      .then(f => {
        frames = f
        if (stop === null) paint(canvas, f.idle)
      })
      .catch(() => {})
  if (observer === null) load()
  else {
    el.addEventListener('visible', load)
    observer.observe(el)
  }
  const start = () => {
    if (stop !== null || frames === null) return
    stop = play(canvas, frames, pet.frameMs)
    stops.push(stop)
  }
  const end = () => {
    if (stop === null) return
    stop()
    stop = null
    paint(canvas, frames.idle)
  }
  el.addEventListener('mouseenter', start)
  el.addEventListener('mouseleave', end)
  el.addEventListener('focus', start)
  el.addEventListener('blur', end)
  el.addEventListener('click', () => openPet(pet))
  return el
}

/* ---------- 소개의 두 펫 ---------- */

function drawHero() {
  const byId = id => pets.find(pet => pet.id === id)
  const chosen = [byId('squirrel') ?? pets[0], byId('turtle') ?? pets[1]].filter(Boolean)
  const unique = chosen.filter((pet, i) => chosen.indexOf(pet) === i)
  $('duo').hidden = unique.length === 0
  ;['hero-a', 'hero-b'].forEach((id, i) => {
    const pet = unique[i]
    $(id).parentElement.hidden = pet === undefined
    if (pet !== undefined) framesOf(pet.id).then(f => play($(id), f, pet.frameMs)).catch(() => {})
  })
}

/* ---------- 상세 창 ---------- */

const dlg = $('dlg')
let detailStop = null
let bubbleTimer = null

function setPetInAddress(id) {
  const url = new URL(location.href)
  if (id === null) url.searchParams.delete('pet')
  else url.searchParams.set('pet', id)
  history.replaceState(null, '', url)
}

function openPet(pet) {
  current = pet
  fillDetail()
  if (!dlg.open) dlg.showModal()
  setPetInAddress(pet.id)
}

function fillDetail() {
  const pet = current
  $('d-name').textContent = pick(pet.name, lang)
  $('d-by').textContent = t('by')(pet.owner, fmtDate(pet.created))
  $('d-desc').textContent = pet.description || t('noDesc')
  const facts = $('d-facts')
  facts.replaceChildren(
    ...[pet.id, t('frames')(pet.frames), `💬 ${pet.langs.map(l => LANG_NAMES[l]).join(' · ')}`].map((text, i) => {
      const span = document.createElement('span')
      if (i === 0) span.className = 'mono'
      span.textContent = text
      return span
    }),
  )
  $('d-cmd').textContent = installCommand(pet.id)
  $('d-like-n').textContent = t('like')(pet.likes)
  $('d-like').href = `${REPO}/issues/${pet.issue}`
  $('d-zip').href = `packs/${pet.id}.dotchi.zip`
  detailStop?.()
  clearInterval(bubbleTimer)
  const canvas = $('d-canvas')
  canvas.getContext('2d').clearRect(0, 0, 32, 32)
  framesOf(pet.id)
    .then(f => {
      if (current === pet) detailStop = play(canvas, f, pet.frameMs)
    })
    .catch(() => {})
  const bubble = $('d-bubble')
  bubble.hidden = true
  linesOf(pet.id).then(all => {
    if (current !== pet) return
    const available = LANGS.filter(l => all[l] !== undefined)
    const set = all[available.includes(lang) ? lang : available.includes('en') ? 'en' : available[0]]
    const pool = set === undefined ? [] : [...(set.spinner ?? []), ...(set.idle ?? [])].filter(s => typeof s === 'string')
    if (pool.length === 0) return
    let k = 0
    bubble.hidden = false
    bubble.textContent = pool[0]
    bubbleTimer = setInterval(() => {
      bubble.textContent = pool[++k % pool.length]
    }, 2200)
  })
}

dlg.addEventListener('close', () => {
  detailStop?.()
  detailStop = null
  clearInterval(bubbleTimer)
  current = null
  setPetInAddress(null)
})
dlg.addEventListener('click', e => {
  if (e.target === dlg) dlg.close()
})
$('d-close').addEventListener('click', () => dlg.close())

/* ---------- 복사 ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text })
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}
const labelCopy = btn => {
  btn.innerHTML = `${COPY_ICON}<span></span>`
  btn.querySelector('span').textContent = t('copy')
}
const wireCopy = (btn, getText) =>
  btn.addEventListener('click', async () => {
    await copyText(getText())
    btn.querySelector('span').textContent = t('copied')
    setTimeout(() => labelCopy(btn), 1600)
  })
document.querySelectorAll('[data-copy]').forEach(btn => wireCopy(btn, () => btn.dataset.copy))
wireCopy($('d-copy'), () => $('d-cmd').textContent)

/* ---------- 언어·정렬·검색 ---------- */

function applyLang() {
  document.documentElement.lang = lang
  $('lang').value = lang
  document.querySelectorAll('[data-t]').forEach(el => {
    el.innerHTML = t(el.dataset.t)
  })
  document.querySelectorAll('.copy').forEach(labelCopy)
  $('q').placeholder = t('search')
  $('q').setAttribute('aria-label', t('search'))
  document.querySelector('.sort').setAttribute('aria-label', t('sortLabel'))
  $('d-close').setAttribute('aria-label', t('close'))
  if (pets.length > 0) drawList()
  if (current !== null) fillDetail()
}

$('lang').addEventListener('change', e => {
  lang = e.target.value
  try {
    localStorage.setItem('dotchi-lang', lang)
  } catch {}
  applyLang()
})
document.querySelectorAll('.sort button').forEach(btn =>
  btn.addEventListener('click', () => {
    sort = btn.dataset.sort
    document.querySelectorAll('.sort button').forEach(other => other.setAttribute('aria-pressed', String(other === btn)))
    drawList()
  }),
)
$('q').addEventListener('input', drawList)

/* ---------- 좋아요 ---------- */

let likesAskedAt = 0
/**
 * 좋아요(처음 Issue의 👍)를 GitHub API에서 바로 가져온다. 빌드 때 숫자는 예비용:
 * 한도를 넘었거나 응답이 없으면 그대로 둔다. Issue 100개씩, 필요한 것을 다 찾을 때까지 5페이지까지
 */
async function refreshLikes() {
  if (pets.length === 0 || Date.now() - likesAskedAt < LIKES_EVERY_MS) return
  likesAskedAt = Date.now()
  const likes = {}
  const missing = () => pets.some(pet => likes[pet.issue] === undefined)
  for (let page = 1; page <= 5 && missing(); page++) {
    const response = await fetch(`${ISSUES_API}?state=all&per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json' },
      // GitHub 응답은 60초 캐시라고 오지만, 해제한 👍도 바로 보이게 매번 확인한다(바뀌지 않았으면 304)
      cache: 'no-cache',
    }).catch(() => null)
    if (response === null || !response.ok) break
    const items = await response.json().catch(() => null)
    Object.assign(likes, likesFromIssues(items))
    if (!Array.isArray(items) || items.length < 100) break
  }
  if (Object.keys(likes).length === 0) return
  pets = applyLikes(pets, likes)
  drawList()
  if (current !== null) {
    current = pets.find(pet => pet.id === current.id) ?? current
    $('d-like-n').textContent = t('like')(current.likes)
  }
}
// GitHub에서 👍를 누르고 돌아오면 다시 묻는다
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshLikes()
})

/* ---------- 시작 ---------- */

applyLang()
fetch('index.json', { cache: 'no-cache' })
  .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
  .then(index => {
    pets = Array.isArray(index.pets) ? index.pets : []
    drawHero()
    drawList()
    const wanted = petFromQuery(location.search)
    const pet = pets.find(p => p.id === wanted)
    if (pet !== undefined) openPet(pet)
    refreshLikes()
  })
  .catch(() => {
    $('duo').hidden = true
    $('count').textContent = ''
    showNotice('loadError')
  })
