#!/usr/bin/env node
// Usage: node scripts/scrape-entries.js [YYYYMMDD]
// 指定日（デフォルト: 翌日JST）のJRA+NAR出走表を取得し、
// public/data/entries-YYYY-MM-DD.json に出力する。
// レース結果ではなく「まだ走っていないレース」の出走馬一覧が対象。

import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

function tomorrowJST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

const dateArg = process.argv[2] || tomorrowJST()
const dateISO = `${dateArg.slice(0, 4)}-${dateArg.slice(4, 6)}-${dateArg.slice(6, 8)}`
const dateDisplay = `${parseInt(dateArg.slice(4, 6))}/${parseInt(dateArg.slice(6, 8))}`

console.log(`Scraping entries for ${dateISO} (${dateDisplay})`)

async function getRaceIds(page, base, date) {
  try {
    await page.goto(`${base}/top/race_list.html?kaisai_date=${date}`, {
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
  } catch {
    return []
  }
}

async function scrapeShutuba(page, base, raceId) {
  await page.goto(`${base}/race/shutuba.html?race_id=${raceId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  })
  await page.waitForTimeout(2000)

  return await page.evaluate(() => {
    const data01 = document.querySelector('.RaceData01')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const raceName = document.querySelector('.RaceName')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const courseMatch = data01.match(/(芝|ダ|障)(\d+)m/)
    if (!courseMatch) return null
    const course = courseMatch[1] === 'ダ' ? 'ダート' : courseMatch[1] === '障' ? '障' : '芝'
    if (course === '障') return null
    const distance = parseInt(courseMatch[2])

    const data02 = document.querySelector('.RaceData02')?.textContent || ''
    // JRA: "2回 福島 6日目 ..." / NAR: 2番目のspanが会場名
    const jraVenueMatch = data02.match(/(\d+)回\s*\n?\s*(.{2,3})\s*\n?\s*(\d+)日目/)
    const data02spans = Array.from(document.querySelectorAll('.RaceData02 span')).map(s => s.textContent.trim())
    const venue = jraVenueMatch ? jraVenueMatch[2].trim() : (data02spans[1] || '')
    const raceNumText = document.querySelector('.RaceList_Item01 .RaceNum')?.textContent?.trim()
      || document.querySelector('.Race_Num span')?.textContent?.trim() || ''

    const rows = Array.from(document.querySelectorAll('table.Shutuba_Table tr, table.RaceTable01 tr'))
    const horses = []
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'))
      if (cells.length < 6) continue
      const wakuOrFrame = cells[0]?.textContent?.trim()
      if (!wakuOrFrame || !/^\d+$/.test(wakuOrFrame)) continue
      const num = cells[1]?.textContent?.trim()
      const name = cells[3]?.querySelector('a')?.textContent?.trim() || cells[3]?.textContent?.trim()
      const jockey = cells[6]?.textContent?.trim()
      const popStr = cells[10]?.textContent?.trim()
      const popularity = /^\d+$/.test(popStr) ? parseInt(popStr, 10) : null
      if (name) horses.push({ num, name, jockey, popularity })
    }
    if (horses.length === 0) return null

    return { venue, raceName, raceNumText, course, distance, horses }
  })
}

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })

  const venueRaces = {}

  for (const [label, base] of [['JRA', 'https://race.netkeiba.com'], ['NAR', 'https://nar.netkeiba.com']]) {
    console.log(`Fetching ${label} race IDs...`)
    const ids = await getRaceIds(page, base, dateArg)
    console.log(`  Found ${ids.length} ${label} races`)
    for (const raceId of ids) {
      try {
        const raceNumFromId = parseInt(raceId.slice(-2), 10)
        const raw = await scrapeShutuba(page, base, raceId)
        if (!raw || !raw.venue) continue
        const raceNum = raw.raceNumText || `${raceNumFromId}R`
        const race = {
          name: `${raw.venue}${raceNum} ${dateDisplay}`,
          raceName: raw.raceName,
          course: raw.course,
          distance: raw.distance,
          horses: raw.horses,
        }
        if (!venueRaces[raw.venue]) venueRaces[raw.venue] = []
        venueRaces[raw.venue].push(race)
        process.stdout.write('.')
      } catch {
        process.stdout.write('x')
      }
    }
    console.log('')
  }

  await browser.close()
  console.log('Done scraping entries.')

  const output = { date: dateISO, dateDisplay, venues: venueRaces }
  const outPath = path.join(DATA_DIR, `entries-${dateISO}.json`)
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`Saved ${outPath}`)
})()
