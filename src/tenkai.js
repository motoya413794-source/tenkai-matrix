// コーナー通過順位文字列を解析して馬番→集団インデックスのマップを返す
// "-" がある場合: "-" で大きな塊に分割し、塊番号を集団インデックスとする
// "-" がない場合: 括弧グループ/単独馬をトークンとして順番に番号付け
// "()" = 同一集団（横並び）= 1トークン
// "-" = 大きなギャップ = 空きコマ1つ挿入（前後の番号が飛ぶ）
// 例: "10,15(2,6)-7,11" → 10:1, 15:2, (2,6):3, [空き=4], 7:5, 11:6
export function parseCornerStr(str, returnTotal = false) {
  const posMap = {}
  let idx = 1
  // "-" を空きコマとして扱うため、まず "-" → " GAP " に変換してトークン化
  const normalized = str.replace(/-/g, ' GAP ')
  const tokens = normalized.match(/\([^)]+\)|[^,()\s]+/g) || []
  tokens.forEach(token => {
    if (token === 'GAP') { idx++; return }
    token.replace(/[()]/g, ',').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s))
      .forEach(n => { posMap[n] = idx })
    idx++
  })
  return returnTotal ? { posMap, totalGroups: idx - 1 } : posMap
}

// 馬のグループインデックスと総グループ数から脚質を分類
export function classifyStyle(groupIdx, totalGroups) {
  if (!groupIdx || !totalGroups) return null
  if (totalGroups <= 2) return groupIdx === 1 ? 'senkou' : 'koho'
  if (totalGroups === 3) {
    if (groupIdx === 1) return 'senkou'
    if (groupIdx === 2) return 'chutan'
    return 'koho'
  }
  const ratio = groupIdx / totalGroups
  if (ratio <= 1/3) return 'senkou'
  if (ratio <= 2/3) return 'chutan'
  return 'koho'
}

// 着順の重み付け（同着は占有スロットの平均を配分）
// 例: 1着同着2頭 → (3+2)/2=2.5点ずつ
const RANK_WEIGHTS = [3, 2, 2, 1, 1]

function assignRankWeights(ranked) {
  const result = []
  let i = 0
  let slot = 0
  while (i < ranked.length && slot < RANK_WEIGHTS.length) {
    let j = i
    while (j < ranked.length && ranked[j].finNum === ranked[i].finNum) j++
    const groupSize = j - i
    const slice = RANK_WEIGHTS.slice(slot, slot + groupSize)
    const avgWeight = slice.reduce((a, b) => a + b, 0) / groupSize
    for (let k = 0; k < groupSize; k++) {
      result.push({ groupIdx: ranked[i + k].groupIdx, weight: avgWeight })
    }
    slot += groupSize
    i = j
  }
  return result
}

// 有効馬（groupIdx・finishあり）から前/後スコアを算出
// 分母は実際に使用した重みの合計（動的）
export function computeScores(horses, totalGroups) {
  const valid = horses.filter(h => h.groupIdx != null && h.finish)
  if (valid.length < 3) return null

  const ranked = valid
    .map(h => ({ groupIdx: h.groupIdx, finNum: parseInt(h.finish, 10) }))
    .filter(h => !isNaN(h.finNum))
    .sort((a, b) => a.finNum - b.finNum)

  if (ranked.length < 3) return null

  const weighted = assignRankWeights(ranked)
  const totalWeight = weighted.reduce((a, h) => a + h.weight, 0)
  if (totalWeight <= 0) return null

  const frontThird = totalGroups / 3
  const rearThird  = totalGroups * 2 / 3

  let frontScore = 0, kohoScore = 0
  weighted.forEach(h => {
    if (h.groupIdx <= frontThird) frontScore += h.weight
    else if (h.groupIdx > rearThird) kohoScore += h.weight
  })

  return { frontScore, kohoScore, totalWeight, frontRatio: frontScore / totalWeight }
}

// レース展開を判定: front / flat / diff / pack(馬群一体)
// isNAR=true の場合: 中団なし（前1/3 vs 後2/3）
// opts.legacy=true で旧固定閾値ロジック、opts.quantiles={q1,q3} でパーセンタイル方式（NAR系のみ）
export function predictTenkai(horses, totalGroups, isNAR = false, opts = {}) {
  if (totalGroups <= 1) return 'pack'

  const scores = computeScores(horses, totalGroups)
  if (!scores) return null
  const { frontScore, kohoScore, totalWeight, frontRatio } = scores

  if (isNAR) {
    if (!opts.legacy && opts.quantiles && opts.quantiles.q1 != null && opts.quantiles.q3 != null) {
      const { q1, q3 } = opts.quantiles
      if (frontRatio > q3) return 'front'
      if (frontRatio < q1) return 'diff'
      return 'flat'
    }
    // 固定閾値フォールバック（パーセンタイル基準未算出時 or legacy指定時）
    if (frontRatio >= 5 / 9) return 'front'
    if (frontRatio <= 2 / 9) return 'diff'
    return 'flat'
  }
  // JRA 3区分（前/中/後 各1/3）: 両閾値とも5/9
  if (frontScore / totalWeight >= 5 / 9) return 'front'
  if (kohoScore / totalWeight >= 5 / 9) return 'diff'
  return 'flat'
}

// isDominant用の着差閾値: 芝5馬身・ダート7馬身
export function marginThreshold(course) {
  return course === 'ダート' ? 7 : 5
}

// コース単位（分布不足時は全体プール）でQ1/Q3/中央値を算出
// races: buildRace()の出力配列、対象コースに絞り込んで渡すこと
// periodMonths は将来のローリング窓対応のため引数化（現状は呼び出し側でフィルタ済み前提）
export function computeQuantiles(races, isNARFn, minSampleSize = 30) {
  const ratios = []
  races.forEach(race => {
    const margin = race.margin
    const threshold = marginThreshold(race.course)
    if (margin != null && margin >= threshold) return // isDominant除外
    if (race.totalGroups <= 1) return // pack除外
    const scores = computeScores(race.horses, race.totalGroups)
    if (!scores) return
    ratios.push(scores.frontRatio)
  })
  if (ratios.length === 0) return null
  ratios.sort((a, b) => a - b)
  return {
    q1: percentile(ratios, 25),
    q3: percentile(ratios, 75),
    median: percentile(ratios, 50),
    sampleSize: ratios.length,
    reliable: ratios.length >= minSampleSize,
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

export const TENKAI_LABEL = {
  front: '前残り',
  flat:  '前後フラット',
  diff:  '差し有利',
  pack:  '馬群一体',
}

export const STYLE_LABEL = {
  senkou: '先行',
  chutan: '中団',
  koho:   '後方',
}

export const STYLE_KEYS = ['senkou', 'chutan', 'koho']
export const TENKAI_KEYS = ['front', 'flat', 'diff']

// 函館の平均勝ちタイム（秒）— course-db.com の2021〜2026集計値
// grade: 'GI'|'GII'|'GIII'|'OP'|'3勝'|'2勝'|'1勝'|'未勝利'|'新馬'
export const BASE_TIMES = {
  '芝': {
    1200: { OP:68.8, '3勝':68.8, '2勝':68.1, '1勝':69.2, '未勝利':69.9, '新馬':70.1 },
    1800: { OP:107.3, '3勝':107.8, '2勝':107.8, '1勝':108.2, '未勝利':108.4, '新馬':111.2 },
    2000: { OP:120.3, '3勝':120.7, '2勝':120.3, '1勝':121.9, '未勝利':121.8, '新馬':123.1 },
  },
  'ダート': {
    1000: { '2勝':58.3, '1勝':58.7, '未勝利':59.1, '新馬':59.4 },
    1700: { OP:103.7, '3勝':104.8, '2勝':104.7, '1勝':105.4, '未勝利':106.3, '新馬':107.3 },
  },
}

// gradeキーを正規化（GI/GII/GIIIはOPとして扱う）
function normalizeGrade(grade) {
  if (!grade) return null
  if (grade === 'GI' || grade === 'G1' || grade === 'GII' || grade === 'G2' || grade === 'GIII' || grade === 'G3' || grade === 'L') return 'OP'
  return grade
}

// "1:09.5" または "69.5" 形式の文字列を秒数に変換
export function parseTimeStr(str) {
  if (!str) return null
  const s = str.trim()
  const m = s.match(/^(\d+):(\d+\.\d+)$/)
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2])
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

// 勝ちタイムと基準タイムの差を秒で返す（マイナス=高速）
// grade省略時はそのコース・距離の全グレード平均を使用
export function calcTrackVariant(course, distance, winTimeSec, grade) {
  const byGrade = BASE_TIMES[course]?.[distance]
  if (!byGrade || winTimeSec == null) return null
  const key = normalizeGrade(grade)
  let base
  if (key && byGrade[key] != null) {
    base = byGrade[key]
  } else {
    const vals = Object.values(byGrade)
    base = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10
  }
  return Math.round((winTimeSec - base) * 10) / 10
}

// gradeに対応する基準タイム（秒）を返す
export function getBaseTime(course, distance, grade) {
  const byGrade = BASE_TIMES[course]?.[distance]
  if (!byGrade) return null
  const key = normalizeGrade(grade)
  if (key && byGrade[key] != null) return byGrade[key]
  const vals = Object.values(byGrade)
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10
}
