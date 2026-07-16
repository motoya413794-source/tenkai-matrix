#!/usr/bin/env node
// Usage: node scripts/backfill-nankan-jockey.js YYYY-MM-DD
// 指定日の南関4会場（大井・川崎・船橋・浦和）のNAR結果を再取得し、
// 既存の public/data/YYYY-MM-DD.json にjockeyフィールドを追加してマージする。
// 他会場のデータはそのまま維持する。

import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

const NANKAN = ['大井', '川崎', '船橋', '浦和']

const dateISO = process.argv[2]
if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
  console.error('Usage: node scripts/backfill-nankan-jockey.js YYYY-MM-DD')
  process.exit(1)
}
const dateArg = dateISO.replace(/-/g, '')
const dateDisplay = `${parseInt(dateISO.slice(5, 7))}/${parseInt(dateISO.slice(8, 10))}`

function parseCornerStr(str) {
  if (!str) return { posMap: {}, totalGroups: 0 }
  const posMap = {}
  let idx = 1
  const tokens = str.replace(/-/g, ' GAP ').match(/\([^)]+\)|[^,()\s]+/g) || []
  tokens.forEach(token => {
    if (token === 'GAP') { idx++; return }
    token.replace(/[()=*]/g, ',').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s))
      .forEach(n => { posMap[n] = idx })
    idx++
  })
  return { posMap, totalGroups: idx - 1 }
}

async function getRaceIds(page, date) {
  await page.goto(`https://nar.netkeiba.com/top/race_list.html?kaisai_date=${date}`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  })
  await page.waitForTimeout(2000)
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="race_id="]'))
    const ids = links.map(a => {
      const m = a.href.match(/race_id=(\d{12})/)
      return m ? m[1] : null
    }).filter(Boolean)
    return [...new Set(ids)]
  })
}

async function scrapeNAR(page, raceId) {
  await page.goto(`https://nar.netkeiba.com/race/result.html?race_id=${raceId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  })
  await page.waitForTimeout(1500)

  return await page.evaluate(() => {
    const data01 = document.querySelector('.RaceData01')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const raceNum = document.querySelector('.Race_Num span')?.textContent?.trim() || ''
    const raceName = document.querySelector('.RaceName')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const courseMatch = data01.match(/(芝|ダ|障)(\d+)m/)
    if (!courseMatch) return null
    const course = courseMatch[1] === 'ダ' ? 'ダート' : courseMatch[1] === '障' ? '障' : '芝'
    if (course === '障') return null
    const data02spans = Array.from(document.querySelectorAll('.RaceData02 span'))
    const venue = data02spans[1]?.textContent?.trim() || ''

    const rows = Array.from(document.querySelectorAll('table tr'))
    const horses = []
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'))
      if (cells.length < 4) continue
      const finish = cells[0]?.textContent?.trim()
      if (!finish || !/^\d+$/.test(finish)) continue
      const horseNum = cells[2]?.textContent?.trim()
      const name = cells[3]?.textContent?.trim()
      const jockey = cells[6]?.textContent?.trim() || null
      const popStr = cells[9]?.textContent?.trim()
      const popularity = /^\d+$/.test(popStr) ? parseInt(popStr, 10) : null
      if (name) horses.push({ finish, num: horseNum, name, jockey, popularity })
    }

    const cornerRows = Array.from(document.querySelectorAll('table.Corner_Num tr'))
    let corner4 = ''
    for (const row of cornerRows) {
      const th = row.querySelector('th')?.textContent?.trim() || ''
      if (th.includes('4')) { corner4 = row.querySelector('td')?.textContent?.trim()?.replace(/\s+/g, '') || ''; break }
    }
    if (!corner4 && cornerRows.length > 0) {
      corner4 = cornerRows[cornerRows.length - 1].querySelector('td')?.textContent?.trim()?.replace(/\s+/g, '') || ''
    }

    return { raceNum, raceName, venue, course, horses, corner4 }
  })
}

;(async () => {
  const filePath = path.join(DATA_DIR, `${dateISO}.json`)
  if (!fs.existsSync(filePath)) {
    console.log(`skip (no file): ${dateISO}`)
    return
  }
  const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const targetVenues = NANKAN.filter(v => existing.venues[v])
  if (targetVenues.length === 0) {
    console.log(`skip (no nankan venue): ${dateISO}`)
    return
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })

  const ids = await getRaceIds(page, dateArg)
  const freshByVenue = {}

  for (const raceId of ids) {
    try {
      const raceNumFromId = parseInt(raceId.slice(-2), 10)
      const raw = await scrapeNAR(page, raceId)
      if (!raw || !raw.venue || !targetVenues.includes(raw.venue)) continue
      const { posMap, totalGroups } = parseCornerStr(raw.corner4)
      const maxGi = Math.max(...Object.values(posMap), 0) || totalGroups
      const horses = raw.horses.map(h => ({
        finish: h.finish,
        name: h.name,
        jockey: h.jockey ?? null,
        popularity: h.popularity ?? null,
        groupIdx: posMap[String(h.num)] ?? (Object.keys(posMap).length > 0 ? maxGi : null),
      }))
      const raceNum = raw.raceNum || `${raceNumFromId}R`
      const raceKey = `${raw.venue}${raceNum} ${dateDisplay}`
      if (!freshByVenue[raw.venue]) freshByVenue[raw.venue] = {}
      freshByVenue[raw.venue][raceKey] = horses
      process.stdout.write('.')
    } catch {
      process.stdout.write('x')
    }
  }
  await browser.close()

  // 既存レコードにjockeyだけをマージ（馬名で突き合わせ）
  let updated = 0
  for (const venue of targetVenues) {
    const freshRaces = freshByVenue[venue] || {}
    for (const race of existing.venues[venue]) {
      const freshHorses = freshRaces[race.name]
      if (!freshHorses) continue
      const jockeyByName = {}
      freshHorses.forEach(h => { jockeyByName[h.name] = h.jockey })
      race.horses.forEach(h => {
        if (jockeyByName[h.name] !== undefined) {
          h.jockey = jockeyByName[h.name]
          updated++
        }
      })
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2))
  console.log(`\n${dateISO}: updated ${updated} horses across ${targetVenues.join(',')}`)
})()
