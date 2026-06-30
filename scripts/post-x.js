#!/usr/bin/env node
// Usage: node scripts/post-x.js [YYYY-MM-DD]
// Posts daily track bias summary to X

import { TwitterApi } from 'twitter-api-v2'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { predictTenkai } from '../src/tenkai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const NAR_PATTERN = /^(門別|盛岡|水沢|船橋|大井|川崎|金沢|笠松|名古屋|園田|姫路|高知|佐賀)/
function isNAR(race) { return NAR_PATTERN.test(race.name) }
function isDominant(race) { return race.margin != null && race.margin >= 5 }

const LABEL = { front: '前残り', flat: 'フラット', diff: '差し有利' }
const EMOJI = { front: '🔴', flat: '⚪', diff: '🔵' }

const SHORT_DIRT = /^(函館|福島|小倉)/
function useNARLogic(race) {
  if (isNAR(race)) return true
  if (race.course === 'ダート' && SHORT_DIRT.test(race.name)) return true
  return false
}

function buildUnfavText(data) {
  const { dateDisplay, venues } = data
  const JRA_ORDER = ['札幌','函館','福島','新潟','東京','中山','中京','京都','阪神','小倉']
  const NAR_ORDER = ['門別','盛岡','水沢','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']
  const allVenues = [...JRA_ORDER, ...NAR_ORDER].filter(v => venues[v])

  let text = `📋 ${dateDisplay} 展開不利馬\n`

  for (const venue of allVenues) {
    const races = venues[venue] || []
    const groups = []

    races.forEach(race => {
      if (isDominant(race)) return
      const nar = useNARLogic(race)
      const tenkai = predictTenkai(race.horses, race.totalGroups, nar)
      if (!tenkai || tenkai === 'pack' || tenkai === 'flat') return
      const frontThird = race.totalGroups / 3
      const unfav = race.horses.filter(h => {
        if (!h.groupIdx || !h.finish) return false
        if (tenkai === 'front') return h.groupIdx > frontThird
        if (tenkai === 'diff')  return h.groupIdx <= frontThird
        return false
      }).sort((a, b) => parseInt(a.finish) - parseInt(b.finish))
      // 好走馬（1〜3着）のみ対象
      const notable = unfav.filter(h => parseInt(h.finish) <= 3)
      if (notable.length > 0) groups.push({ race, tenkai, unfav: notable })
    })

    if (groups.length === 0) continue
    text += `\n【${venue}】\n`
    for (const { race, tenkai, unfav } of groups) {
      const raceNum = race.name.match(/(\d+R)/)?.[1] || ''
      const raceName = race.raceName || race.name
      text += `${raceNum} ${raceName}（${LABEL[tenkai]}）\n`
      for (const h of unfav) {
        const fin = parseInt(h.finish)
        const comment = fin === 1 ? '🥇展開不利でも勝利' : fin <= 3 ? '⭐好走' : '凡走'
        text += `  ${h.finish}着 ${h.name} ${comment}\n`
      }
    }
  }

  return text
}

function venueVerdict(races) {
  const result = {}
  for (const course of ['芝', 'ダート']) {
    const filtered = races.filter(r => r.course === course && !isDominant(r))
    if (filtered.length === 0) continue
    const counts = { front: 0, flat: 0, diff: 0 }
    filtered.forEach(r => {
      const t = predictTenkai(r.horses, r.totalGroups, isNAR(r))
      if (t && t !== 'pack') counts[t]++
    })
    const total = counts.front + counts.flat + counts.diff
    if (total === 0) continue
    let verdict = 'flat'
    if (counts.front / total >= 0.5) verdict = 'front'
    else if (counts.diff / total >= 0.5) verdict = 'diff'
    result[course] = { verdict, counts, total }
  }
  return result
}

function buildTweet(data) {
  const { dateDisplay, venues } = data
  const JRA_ORDER = ['札幌','函館','福島','新潟','東京','中山','中京','京都','阪神','小倉']
  const NAR_ORDER = ['門別','盛岡','水沢','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']

  const jraVenues = JRA_ORDER.filter(v => venues[v])
  const narVenues = NAR_ORDER.filter(v => venues[v])

  let text = `🏇 ${dateDisplay} トラックバイアスまとめ\n\n`

  if (jraVenues.length > 0) {
    text += `【中央】\n`
    for (const venue of jraVenues) {
      const v = venueVerdict(venues[venue])
      const parts = Object.entries(v).map(([course, d]) =>
        `${course}:${EMOJI[d.verdict]}${LABEL[d.verdict]}(${Math.round(d.counts[d.verdict] / d.total * 100)}%)`
      )
      if (parts.length > 0) text += `${venue} ${parts.join(' ')}\n`
    }
    text += '\n'
  }

  // 実際にデータがある地方会場も含める（NAR_ORDERにない会場も）
  const allNarVenues = [...new Set([...narVenues, ...Object.keys(venues).filter(v => !jraVenues.includes(v))])]
  if (allNarVenues.length > 0) {
    text += `【地方】\n`
    for (const venue of allNarVenues) {
      const v = venueVerdict(venues[venue])
      const parts = Object.entries(v).map(([course, d]) =>
        `${course}:${EMOJI[d.verdict]}${LABEL[d.verdict]}(${Math.round(d.counts[d.verdict] / d.total * 100)}%)`
      )
      if (parts.length > 0) text += `${venue} ${parts.join(' ')}\n`
    }
    text += '\n'
  }

  text += `詳細 → https://tenkai-matrix.vercel.app\n`
  text += `#競馬 #トラックバイアス`

  return text
}

;(async () => {
  // Load data
  const dateArg = process.argv[2]
  let dateISO = dateArg
  if (!dateISO) {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
    dateISO = d.toISOString().slice(0, 10)
  }

  const dataPath = path.join(__dirname, `../public/data/${dateISO}.json`)
  if (!fs.existsSync(dataPath)) {
    console.error(`No data file: ${dataPath}`)
    process.exit(1)
  }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
  const tweet = buildTweet(data)

  const unfav = buildUnfavText(data)

  console.log('--- Tweet preview ---')
  console.log(tweet)
  console.log(`--- ${tweet.length} chars ---`)
  console.log('--- Unfav preview ---')
  console.log(unfav)

  if (!process.env.X_API_KEY) {
    console.log('No X credentials, skipping post')
    process.exit(0)
  }

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  })

  const { data: posted } = await client.v2.tweet(tweet)
  console.log(`Posted: https://x.com/i/web/status/${posted.id}`)
})()
