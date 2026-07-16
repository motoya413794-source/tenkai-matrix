#!/usr/bin/env node
// Usage: node scripts/jockey-nige-senko-stats.js
// 南関4会場（大井・川崎・船橋・浦和）データを対象に、騎手ごとの
// 1. 単純な逃げ・先行率（前1/3ゾーンで走った割合）
// 2. 「直近5走平均が逃げ・先行でない馬」を今回逃げ・先行させた率
// を算出する。前走参照は全会場（南関以外も含む）の同馬レースを対象にする。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { classifyStyle } from '../src/tenkai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

const NANKAN = ['大井', '川崎', '船橋', '浦和']
const MIN_RIDES = 20 // 集計対象とする最低騎乗数

const indexPath = path.join(DATA_DIR, 'index.json')
const dates = JSON.parse(fs.readFileSync(indexPath, 'utf8')).sort() // 昇順(古い→新しい)

// 馬ごとの全レース履歴（南関以外も含む、日付昇順）
// { horseName: [{date, venue, groupIdx, totalGroups, jockey}] }
const horseTimeline = {}

for (const date of dates) {
  const file = path.join(DATA_DIR, `${date}.json`)
  if (!fs.existsSync(file)) continue
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [venue, races] of Object.entries(data.venues || {})) {
    for (const race of races) {
      if (!race.totalGroups || race.totalGroups <= 1) continue
      for (const h of race.horses) {
        if (!h.groupIdx || !h.name) continue
        if (!horseTimeline[h.name]) horseTimeline[h.name] = []
        horseTimeline[h.name].push({
          date, venue,
          groupIdx: h.groupIdx,
          totalGroups: race.totalGroups,
          jockey: h.jockey || null,
        })
      }
    }
  }
}
// 各馬のタイムラインを日付順に確定（同日は元の並び順のまま安定ソート）
for (const name of Object.keys(horseTimeline)) {
  horseTimeline[name].sort((a, b) => a.date.localeCompare(b.date))
}

function isSenkou(groupIdx, totalGroups) {
  return classifyStyle(groupIdx, totalGroups) === 'senkou'
}

// 騎手統計
const stats = {} // jockey -> { rides, senkouRides, convBase, convHit }
function ensure(jockey) {
  if (!stats[jockey]) stats[jockey] = { rides: 0, senkouRides: 0, convBase: 0, convHit: 0 }
  return stats[jockey]
}

for (const [horseName, timeline] of Object.entries(horseTimeline)) {
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i]
    if (!NANKAN.includes(cur.venue)) continue // 集計対象は南関の騎乗のみ
    if (!cur.jockey) continue
    const s = ensure(cur.jockey)
    const curSenkou = isSenkou(cur.groupIdx, cur.totalGroups)

    // 1. 単純逃げ・先行率
    s.rides++
    if (curSenkou) s.senkouRides++

    // 2. 直近5走(このレースより前)平均が非先行の馬を、今回先行させたか
    const prev5 = timeline.slice(Math.max(0, i - 5), i)
    if (prev5.length >= 3) { // 最低3走分のサンプルがある場合のみ評価
      const prevSenkouRate = prev5.filter(p => isSenkou(p.groupIdx, p.totalGroups)).length / prev5.length
      if (prevSenkouRate < 0.5) { // 直近平均で「先行しない馬」と判定
        s.convBase++
        if (curSenkou) s.convHit++
      }
    }
  }
}

const rows = Object.entries(stats)
  .filter(([, s]) => s.rides >= MIN_RIDES)
  .map(([jockey, s]) => ({
    jockey,
    rides: s.rides,
    senkouRate: s.senkouRides / s.rides,
    convBase: s.convBase,
    convRate: s.convBase > 0 ? s.convHit / s.convBase : null,
  }))

console.log(`=== 単純 逃げ・先行率（南関、${MIN_RIDES}騎乗以上） ===`)
rows.sort((a, b) => b.senkouRate - a.senkouRate)
for (const r of rows.slice(0, 20)) {
  console.log(`${r.jockey}\t騎乗${r.rides}\t先行率${(r.senkouRate * 100).toFixed(1)}%`)
}

console.log(`\n=== 直近5走平均が非先行の馬を先行させた率（南関、対象母数10件以上） ===`)
const convRows = rows.filter(r => r.convBase >= 10)
convRows.sort((a, b) => b.convRate - a.convRate)
for (const r of convRows.slice(0, 20)) {
  console.log(`${r.jockey}\t対象${r.convBase}件\t転換率${(r.convRate * 100).toFixed(1)}%`)
}

// JSON出力（サイト用）
const output = {
  generatedAt: new Date().toISOString(),
  minRides: MIN_RIDES,
  jockeys: rows.map(r => ({
    jockey: r.jockey,
    rides: r.rides,
    senkouRate: Math.round(r.senkouRate * 1000) / 1000,
    convBase: r.convBase,
    convRate: r.convRate != null ? Math.round(r.convRate * 1000) / 1000 : null,
  })),
}
const outPath = path.join(DATA_DIR, 'nankan-jockey-stats.json')
fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
console.log(`\nSaved ${outPath}`)
