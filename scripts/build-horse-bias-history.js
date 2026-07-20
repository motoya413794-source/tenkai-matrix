#!/usr/bin/env node
// Usage: node scripts/build-horse-bias-history.js
// 蓄積済みの全結果データ(public/data/YYYY-MM-DD.json)を走査し、
// 「展開不利な位置取りをしたレース」を馬名ごとに集計して
// public/data/horse-bias-history.json に出力する。
//
// 判定は既存の展開不利馬ロジック（App.jsx/post-x.jsのUnfavorableList相当）を再利用。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { predictTenkai, isDominant } from '../src/tenkai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

const NAR_VENUES = ['門別','盛岡','水沢','浦和','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']
const SHORT_DIRT_VENUES = ['函館','福島','小倉','札幌']

function isNAR(venue) { return NAR_VENUES.includes(venue) }
function useNARLogic(venue, race) {
  if (isNAR(venue)) return true
  if (race.course === 'ダート' && SHORT_DIRT_VENUES.includes(venue)) return true
  return false
}
function getQuantiles(venue, quantiles) {
  const q = quantiles?.[venue]
  return q && q.source === 'own' ? q : null
}

const indexPath = path.join(DATA_DIR, 'index.json')
const dates = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
const quantilesPath = path.join(DATA_DIR, 'quantiles.json')
const quantiles = fs.existsSync(quantilesPath) ? JSON.parse(fs.readFileSync(quantilesPath, 'utf8')) : null

const history = {} // horseName -> [{date, venue, raceName, tenkai, finish, popularity}]

for (const date of dates) {
  const file = path.join(DATA_DIR, `${date}.json`)
  if (!fs.existsSync(file)) continue
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [venue, races] of Object.entries(data.venues || {})) {
    for (const race of races) {
      if (isDominant(race)) continue
      const nar = useNARLogic(venue, race)
      const q = getQuantiles(venue, quantiles)
      const opts = q ? { quantiles: { q1: q.q1, q3: q.q3 } } : {}
      const tenkai = predictTenkai(race.horses, race.totalGroups, nar, opts)
      if (!tenkai || tenkai === 'pack' || tenkai === 'flat') continue

      const frontThird = race.totalGroups / 3
      const unfavHorses = race.horses.filter(h => {
        if (!h.groupIdx || !h.finish) return false
        if (tenkai === 'front') return h.groupIdx > frontThird
        if (tenkai === 'diff') return h.groupIdx <= frontThird
        return false
      })

      for (const h of unfavHorses) {
        if (!history[h.name]) history[h.name] = []
        history[h.name].push({
          date,
          venue,
          raceName: race.raceName || race.name,
          tenkai,
          finish: h.finish,
          popularity: h.popularity ?? null,
        })
      }
    }
  }
}

// 新しい順に並べ替え
for (const name of Object.keys(history)) {
  history[name].sort((a, b) => b.date.localeCompare(a.date))
}

const outPath = path.join(DATA_DIR, 'horse-bias-history.json')
fs.writeFileSync(outPath, JSON.stringify(history, null, 2))
console.log(`Saved ${outPath} (${Object.keys(history).length} horses)`)
