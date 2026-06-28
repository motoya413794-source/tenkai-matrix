#!/usr/bin/env node
// Usage: node scripts/scrape.js [YYYYMMDD]
// Scrapes JRA + NAR races for the given date (default: today JST)
// Outputs public/data/YYYY-MM-DD.json and updates public/data/index.json

import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data')

// ── Date ──────────────────────────────────────────────────
function todayJST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

const dateArg = process.argv[2] || todayJST()
const dateISO = `${dateArg.slice(0, 4)}-${dateArg.slice(4, 6)}-${dateArg.slice(6, 8)}`
const dateDisplay = `${parseInt(dateArg.slice(4, 6))}/${parseInt(dateArg.slice(6, 8))}`

console.log(`Scraping ${dateISO} (${dateDisplay})`)

// ── Corner string parser (same as tenkai.js) ──────────────
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

// ── Scrape race IDs for a date ────────────────────────────
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

// ── Scrape single JRA race ────────────────────────────────
async function scrapeJRA(page, raceId) {
  await page.goto(`https://race.netkeiba.com/race/result.html?race_id=${raceId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  })
  await page.waitForTimeout(2000)

  return await page.evaluate((rid) => {
    const data01 = document.querySelector('.RaceData01')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const raceNum = document.querySelector('.Race_Num span')?.textContent?.trim() || ''
    const raceName = document.querySelector('.RaceName')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const courseMatch = data01.match(/(芝|ダ|障)(\d+)m/)
    if (!courseMatch) return null
    const course = courseMatch[1] === 'ダ' ? 'ダート' : courseMatch[1] === '障' ? '障' : '芝'
    if (course === '障') return null
    const distance = parseInt(courseMatch[2])
    const condMatch = data01.match(/馬場[:：\s]+([良稍重不]+)/)
    const trackCondition = condMatch ? condMatch[1].replace('稍', '稍重').replace('不', '不良') : ''
    const gradeMatch = raceName.match(/\(([A-Z0-9]+)\)/) || raceName.match(/(GI|GII|GIII|L|OP)/)
    const grade = gradeMatch ? gradeMatch[1] : ''
    const data02 = document.querySelector('.RaceData02')?.textContent || ''
    const venueMatch = data02.match(/(.{2,3})\d+回/)
    const venue = venueMatch ? venueMatch[1] : ''
    const courseTypeMatch = data01.match(/\((?:右|左|直)\s*([A-D])\)/)
    const courseType = courseTypeMatch ? courseTypeMatch[1] : null

    const rows = Array.from(document.querySelectorAll('table.RaceTable01 tr'))
    const horses = []
    let winTime = ''
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'))
      if (cells.length < 6) continue
      const finish = cells[0]?.textContent?.trim()
      if (!finish || !/^\d+$/.test(finish)) continue
      const horseNum = cells[2]?.textContent?.trim()
      const name = cells[3]?.querySelector('a')?.textContent?.trim() || cells[3]?.textContent?.trim()
      const time = cells[7]?.textContent?.trim()
      if (finish === '1') winTime = time
      if (name) horses.push({ finish, num: horseNum, name })
    }

    const cornerRows = Array.from(document.querySelectorAll('.Corner_Num tr'))
    let corner4 = ''
    for (const row of cornerRows) {
      const th = row.querySelector('th')?.textContent?.trim() || ''
      if (th.includes('4') || th.includes('直')) {
        corner4 = row.querySelector('td')?.textContent?.trim()?.replace(/\s+/g, '') || ''
        break
      }
    }
    if (!corner4 && cornerRows.length > 0) {
      corner4 = cornerRows[cornerRows.length - 1].querySelector('td')?.textContent?.trim()?.replace(/\s+/g, '') || ''
    }

    return { raceNum, raceName, venue, course, distance, grade, trackCondition, courseType, winTime, corner4, horses }
  }, raceId)
}

// ── Scrape single NAR race ────────────────────────────────
async function scrapeNAR(page, raceId) {
  await page.goto(`https://nar.netkeiba.com/race/result.html?race_id=${raceId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  })
  await page.waitForTimeout(2000)

  return await page.evaluate((rid) => {
    const data01 = document.querySelector('.RaceData01')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const raceNum = document.querySelector('.Race_Num span')?.textContent?.trim() || ''
    const raceName = document.querySelector('.RaceName')?.textContent?.trim()?.replace(/\s+/g, ' ') || ''
    const courseMatch = data01.match(/(芝|ダ|障)(\d+)m/)
    if (!courseMatch) return null
    const course = courseMatch[1] === 'ダ' ? 'ダート' : courseMatch[1] === '障' ? '障' : '芝'
    if (course === '障') return null
    const distance = parseInt(courseMatch[2])
    const condMatch = data01.match(/馬場[:：\s]+([良稍重不]+)/)
    const trackCondition = condMatch ? condMatch[1].replace('稍', '稍重').replace('不', '不良') : ''
    const data02spans = Array.from(document.querySelectorAll('.RaceData02 span'))
    const venue = data02spans[1]?.textContent?.trim() || ''

    const rows = Array.from(document.querySelectorAll('table tr'))
    const horses = []
    let winTime = ''
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'))
      if (cells.length < 4) continue
      const finish = cells[0]?.textContent?.trim()
      if (!finish || !/^\d+$/.test(finish)) continue
      const horseNum = cells[2]?.textContent?.trim()
      const name = cells[3]?.textContent?.trim()
      const time = cells[7]?.textContent?.trim()
      if (finish === '1') winTime = time
      if (name) horses.push({ finish, num: horseNum, name })
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

    // 着差（2着馬の着差列）
    let margin = null
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'))
      if (cells[0]?.textContent?.trim() === '2') {
        const m = cells[8]?.textContent?.trim()
        if (m) margin = m === '大差' || m === '大' ? 99 : parseFloat(m) || null
        break
      }
    }

    return { raceNum, raceName, venue, course, distance, grade: '', trackCondition, courseType: null, winTime, corner4, horses, margin }
  }, raceId)
}

// ── Build race object ─────────────────────────────────────
function buildRace(raw, raceId, dateDisplay, isNar) {
  const venueCode = raceId.slice(4, 6)
  const { posMap, totalGroups } = parseCornerStr(raw.corner4)
  const maxGi = Math.max(...Object.values(posMap), 0) || totalGroups

  const horses = raw.horses.map(h => ({
    finish: h.finish,
    name: h.name,
    groupIdx: posMap[String(h.num)] ?? (Object.keys(posMap).length > 0 ? maxGi : null),
  }))

  return {
    name: `${raw.venue}${raw.raceNum} ${dateDisplay}`,
    raceName: raw.raceName,
    course: raw.course,
    distance: raw.distance,
    grade: raw.grade || '',
    trackCondition: raw.trackCondition,
    courseType: raw.courseType || null,
    winTime: raw.winTime,
    totalHorses: raw.horses.length,
    totalGroups,
    horses,
    margin: raw.margin ?? null,
    _corner4: raw.corner4,
  }
}

// ── Main ──────────────────────────────────────────────────
;(async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })

  const venueRaces = {} // { venue: [race, ...] }

  // ── JRA ──
  console.log('Fetching JRA race IDs...')
  const jraIds = await getRaceIds(page, 'https://race.netkeiba.com', dateArg)
  console.log(`  Found ${jraIds.length} JRA races`)

  for (const raceId of jraIds) {
    try {
      const raw = await scrapeJRA(page, raceId)
      if (!raw || !raw.venue) continue
      const race = buildRace(raw, raceId, dateDisplay, false)
      if (!venueRaces[raw.venue]) venueRaces[raw.venue] = []
      venueRaces[raw.venue].push(race)
      process.stdout.write('.')
    } catch (e) {
      process.stdout.write('x')
    }
  }

  // ── NAR ──
  console.log('\nFetching NAR race IDs...')
  const narIds = await getRaceIds(page, 'https://nar.netkeiba.com', dateArg)
  console.log(`  Found ${narIds.length} NAR races`)

  for (const raceId of narIds) {
    try {
      const raw = await scrapeNAR(page, raceId)
      if (!raw || !raw.venue) continue
      const race = buildRace(raw, raceId, dateDisplay, true)
      if (!venueRaces[raw.venue]) venueRaces[raw.venue] = []
      venueRaces[raw.venue].push(race)
      process.stdout.write('.')
    } catch (e) {
      process.stdout.write('x')
    }
  }

  await browser.close()
  console.log('\nDone scraping.')

  // ── Save ──
  const output = { date: dateISO, dateDisplay, venues: venueRaces }
  const outPath = path.join(DATA_DIR, `${dateISO}.json`)
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`Saved ${outPath}`)

  // Update index.json
  const indexPath = path.join(DATA_DIR, 'index.json')
  let index = []
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  }
  if (!index.includes(dateISO)) {
    index.unshift(dateISO)
    index = index.slice(0, 30) // keep last 30 days
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))
    console.log('Updated index.json')
  }
})()
