#!/usr/bin/env node
// Usage: node scripts/compute-quantiles.js [--months N]
// 2区分ロジック（NAR + 函館/福島/小倉/札幌ダート）対象コースの
// 前スコア分布からQ1/Q3/中央値をコース単位で算出し、
// public/data/quantiles.json に出力する。
//
// 母数不足（<30レース）のコースは地方全体プール／JRAダートプールへフォールバックする。
// 期間はmonthsで指定（初期実装は直近1ヶ月固定運用、将来ローリング窓に切替可能なよう引数化）

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeScores, isDominant } from '../src/tenkai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

const NAR_VENUES = ['門別', '盛岡', '水沢', '浦和', '船橋', '大井', '川崎', '金沢', '笠松', '名古屋', '園田', '姫路', '高知', '佐賀']
const SHORT_DIRT_VENUES = ['函館', '福島', '小倉', '札幌'] // JRA 2区分ダート対象

const monthsArg = process.argv.indexOf('--months')
const months = monthsArg !== -1 ? parseInt(process.argv[monthsArg + 1], 10) : 1

function isTargetRace(race, venue) {
  if (race.course !== 'ダート' && !(NAR_VENUES.includes(venue) && race.course === '芝')) {
    // NARは芝もありうる（例: 盛岡）が、2区分対象は「NARロジック適用レース」全体
  }
  return NAR_VENUES.includes(venue) || (SHORT_DIRT_VENUES.includes(venue) && race.course === 'ダート')
}

function isExcluded(race) {
  if (isDominant(race)) return true
  if (race.totalGroups <= 1) return true
  return false
}

// ── データ読み込み ──────────────────────────────
const indexPath = path.join(DATA_DIR, 'index.json')
const allDates = JSON.parse(fs.readFileSync(indexPath, 'utf8'))

const latestDate = allDates.slice().sort((a, b) => b.localeCompare(a))[0]
const cutoff = new Date(latestDate)
cutoff.setMonth(cutoff.getMonth() - months)
const cutoffISO = cutoff.toISOString().slice(0, 10)

const targetDates = allDates.filter(d => d >= cutoffISO)
console.log(`対象期間: ${cutoffISO} 〜 ${latestDate}（${targetDates.length}日分）`)

const byVenue = {} // venue -> ratio[]
const narPool = []
const jraDirtPool = []

for (const date of targetDates) {
  const file = path.join(DATA_DIR, `${date}.json`)
  if (!fs.existsSync(file)) continue
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [venue, races] of Object.entries(data.venues || {})) {
    for (const race of races) {
      if (!isTargetRace(race, venue)) continue
      if (isExcluded(race)) continue
      // 母集団は2区分の前ゾーン達成率（v2仕様）
      const scores = computeScores(race.horses, race.totalGroups, true)
      if (!scores || scores.frontRate == null) continue
      if (!byVenue[venue]) byVenue[venue] = []
      byVenue[venue].push(scores.frontRate)
      if (NAR_VENUES.includes(venue)) narPool.push(scores.frontRate)
      else jraDirtPool.push(scores.frontRate)
    }
  }
}

// numpy.percentile 互換（linear interpolation）
function percentile(sortedArr, p) {
  const n = sortedArr.length
  if (n === 0) return null
  if (n === 1) return sortedArr[0]
  const idx = (p / 100) * (n - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedArr[lo]
  const frac = idx - lo
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * frac
}

function stats(ratios) {
  const sorted = [...ratios].sort((a, b) => a - b)
  return {
    q1: percentile(sorted, 25),
    q3: percentile(sorted, 75),
    median: percentile(sorted, 50),
    sampleSize: sorted.length,
    reliable: sorted.length >= 30,
  }
}

const MIN_SAMPLE = 30
const result = {}

for (const [venue, ratios] of Object.entries(byVenue)) {
  const own = stats(ratios)
  if (own.sampleSize >= MIN_SAMPLE) {
    result[venue] = { ...own, source: 'own' }
  } else {
    const pool = NAR_VENUES.includes(venue) ? narPool : jraDirtPool
    const poolStats = stats(pool)
    result[venue] = { ...poolStats, source: NAR_VENUES.includes(venue) ? 'nar_pool' : 'jra_dirt_pool', ownSampleSize: own.sampleSize }
  }
}

result._nar_pool = { ...stats(narPool), source: 'pool' }
result._jra_dirt_pool = { ...stats(jraDirtPool), source: 'pool' }
result._meta = { periodStart: cutoffISO, periodEnd: latestDate, months, generatedAt: new Date().toISOString() }

const outPath = path.join(DATA_DIR, 'quantiles.json')
fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
console.log(`Saved ${outPath}`)
for (const [venue, v] of Object.entries(result)) {
  if (venue.startsWith('_')) continue
  console.log(`  ${venue}: q1=${v.q1?.toFixed(3)} median=${v.median?.toFixed(3)} q3=${v.q3?.toFixed(3)} n=${v.sampleSize}(own:${v.ownSampleSize ?? v.sampleSize}) source=${v.source}`)
}
