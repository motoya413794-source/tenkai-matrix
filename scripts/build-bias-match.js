#!/usr/bin/env node
// Usage: node scripts/build-bias-match.js [entries-date YYYY-MM-DD]
// 「今のトラックバイアス」（会場×コースの直近数日の平均傾向）を算出し、
// 出走予定馬の直近5走の脚質多数決と照合して、バイアスに合う馬を抽出する。
// 地方競馬は構造的に前有利が基本のため、データ不足時は前有利をデフォルトとする。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { predictTenkai, isDominant, dayTallyWeight, classWeight, favoriteBeatenSignal, classifyStyle } from '../src/tenkai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

const JRA_VENUES = ['札幌','函館','福島','新潟','東京','中山','中京','京都','阪神','小倉']
const NAR_VENUES = ['門別','盛岡','水沢','浦和','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']
const SHORT_DIRT_VENUES = ['函館','福島','小倉','札幌']
const RECENT_DAYS = 5 // 「直近数日」の対象日数
const RECENT_RACES = 5 // 馬の脚質判定に使う直近レース数

function isNARVenue(venue) { return NAR_VENUES.includes(venue) }
function useNARLogic(venue, race) {
  if (isNARVenue(venue)) return true
  if (race.course === 'ダート' && SHORT_DIRT_VENUES.includes(venue)) return true
  return false
}
function getQuantiles(venue, quantiles) {
  const q = quantiles?.[venue]
  return q && q.source === 'own' ? q : null
}
function tenkaiOpts(venue, race, quantiles) {
  const q = getQuantiles(venue, quantiles)
  if (!q || q.q1 == null || q.q3 == null) return {}
  return { quantiles: { q1: q.q1, q3: q.q3 } }
}

// ── 対象の出走表日付 ──────────────────────────────
const entriesDateArg = process.argv[2]
let entriesDate = entriesDateArg
if (!entriesDate) {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000)
  entriesDate = d.toISOString().slice(0, 10)
}
const entriesPath = path.join(DATA_DIR, `entries-${entriesDate}.json`)
if (!fs.existsSync(entriesPath)) {
  console.error(`entries file not found: ${entriesPath}`)
  process.exit(0) // 出走表がまだ無い日はエラーにせず正常終了
}
const entries = JSON.parse(fs.readFileSync(entriesPath, 'utf8'))

const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8')).sort() // 昇順
const quantiles = fs.existsSync(path.join(DATA_DIR, 'quantiles.json'))
  ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'quantiles.json'), 'utf8'))
  : null

// ── 会場×コースの「直近数日の平均傾向」バイアスを算出 ──
// 直近RECENT_DAYS日分の該当会場・コースの全レースを絶対判定で集計し、多数決で決める
function computeRecentBias(venue, course) {
  const relevantDates = index.filter(d => d < entriesDate).slice(-40) // 直近を優先しつつ十分な範囲を確保
  const counts = { front: 0, flat: 0, diff: 0 }
  let daysUsed = 0
  for (let i = relevantDates.length - 1; i >= 0 && daysUsed < RECENT_DAYS; i--) {
    const date = relevantDates[i]
    const file = path.join(DATA_DIR, `${date}.json`)
    if (!fs.existsSync(file)) continue
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const races = (data.venues?.[venue] || []).filter(r => r.course === course)
    if (races.length === 0) continue
    daysUsed++
    for (const race of races) {
      if (isDominant(race)) continue
      const nar = useNARLogic(venue, race)
      const t = predictTenkai(race.horses, race.totalGroups, nar, { legacy: true })
      if (!t || t === 'pack') continue
      const w = dayTallyWeight(race) * classWeight(race)
      const rawSig = favoriteBeatenSignal(race, nar)
      const transfer = Math.min(rawSig, 1) * w
      counts[t] += w - transfer
      counts.diff += transfer
    }
  }
  const total = counts.front + counts.flat + counts.diff
  if (total === 0) {
    // データ不足: 地方競馬は構造的に前有利がデフォルト
    return { bias: isNARVenue(venue) ? 'front' : null, source: 'default', daysUsed: 0, counts }
  }
  let bias = 'flat'
  if (counts.diff / total >= counts.front / total && counts.diff / total > counts.flat / total) bias = 'diff'
  else if (counts.front / total > counts.diff / total && counts.front / total > counts.flat / total) bias = 'front'
  return { bias, source: 'recent', daysUsed, counts }
}

// ── 馬ごとの直近5走の脚質履歴（全会場対象）──────────
const horseTimeline = {}
for (const date of index) {
  if (date >= entriesDate) continue
  const file = path.join(DATA_DIR, `${date}.json`)
  if (!fs.existsSync(file)) continue
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [venue, races] of Object.entries(data.venues || {})) {
    for (const race of races) {
      if (!race.totalGroups || race.totalGroups <= 1) continue
      for (const h of race.horses) {
        if (!h.groupIdx || !h.name) continue
        const style = classifyStyle(h.groupIdx, race.totalGroups)
        if (!style) continue
        if (!horseTimeline[h.name]) horseTimeline[h.name] = []
        horseTimeline[h.name].push({ date, venue, style })
      }
    }
  }
}
for (const name of Object.keys(horseTimeline)) {
  horseTimeline[name].sort((a, b) => a.date.localeCompare(b.date))
}

// 直近5走の多数決で脚質を決定（同数の場合はnull=判定不能）
function recentStyle(horseName) {
  const tl = horseTimeline[horseName]
  if (!tl || tl.length === 0) return null
  const last5 = tl.slice(-RECENT_RACES)
  const counts = { senkou: 0, chutan: 0, koho: 0 }
  last5.forEach(r => { counts[r.style]++ })
  const max = Math.max(counts.senkou, counts.chutan, counts.koho)
  const top = Object.entries(counts).filter(([, v]) => v === max).map(([k]) => k)
  return { style: top.length === 1 ? top[0] : null, counts, races: last5 }
}

// ── バイアス⇔脚質の適合判定 ──────────────────────
function matches(bias, style) {
  if (bias === 'front') return style === 'senkou'
  if (bias === 'diff') return style === 'koho'
  return false
}

// ── メイン ────────────────────────────────────────
const allVenues = [...JRA_VENUES, ...NAR_VENUES].filter(v => entries.venues[v])
const result = { date: entries.date, dateDisplay: entries.dateDisplay, generatedAt: new Date().toISOString(), venues: {} }

for (const venue of allVenues) {
  const races = entries.venues[venue]
  const courseSet = [...new Set(races.map(r => r.course))]
  const biasByCourse = {}
  for (const course of courseSet) {
    biasByCourse[course] = computeRecentBias(venue, course)
  }

  const raceGroups = []
  for (const race of races) {
    const biasInfo = biasByCourse[race.course]
    if (!biasInfo || !biasInfo.bias) continue
    const matched = []
    for (const h of race.horses) {
      const rs = recentStyle(h.name)
      if (!rs || !rs.style) continue
      if (matches(biasInfo.bias, rs.style)) {
        matched.push({ num: h.num, name: h.name, jockey: h.jockey, popularity: h.popularity, style: rs.style, recentRaces: rs.races })
      }
    }
    if (matched.length > 0) {
      raceGroups.push({ race, bias: biasInfo, horses: matched })
    }
  }
  if (raceGroups.length > 0) {
    result.venues[venue] = { biasByCourse, races: raceGroups }
  }
}

const outPath = path.join(DATA_DIR, `bias-match-${entries.date}.json`)
fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
const totalHorses = Object.values(result.venues).reduce((s, v) => s + v.races.reduce((s2, r) => s2 + r.horses.length, 0), 0)
console.log(`Saved ${outPath} (${totalHorses} horses matched across ${Object.keys(result.venues).length} venues)`)
