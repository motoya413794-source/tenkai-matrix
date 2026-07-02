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

// グループ頭数に対する理論上限重み（上位5頭の重み体系で頭打ち）
// 頭数1→3, 2→5, 3→7, 4→8, 5以上→9
// 6着以下の馬は重み体系外のため理論上限にも実獲得にも影響しない
function theoreticalMax(groupSize) {
  let sum = 0
  for (let i = 0; i < Math.min(groupSize, RANK_WEIGHTS.length); i++) sum += RANK_WEIGHTS[i]
  return sum
}

// 有効馬（groupIdx・finishあり）からゾーン別の達成率を算出
// 達成率 = そのゾーンの馬が実際に獲得した重み合計 ÷ そのゾーンの頭数から決まる理論上限
// ゾーンに1頭もいない場合はnull（ゼロ割回避、判定では「主張なし」扱い）
// isNAR=true: 2区分（前1/3 vs 後2/3、中団なし）/ false: 3区分（前/中/後 各1/3）
export function computeScores(horses, totalGroups, isNAR = false) {
  const valid = horses.filter(h => h.groupIdx != null && h.finish)
  if (valid.length < 3) return null

  const ranked = valid
    .map(h => ({ groupIdx: h.groupIdx, finNum: parseInt(h.finish, 10) }))
    .filter(h => !isNaN(h.finNum))
    .sort((a, b) => a.finNum - b.finNum)

  if (ranked.length < 3) return null

  const frontThird = totalGroups / 3
  const rearThird  = totalGroups * 2 / 3
  const zoneOf = gi => {
    if (gi <= frontThird) return 'front'
    if (isNAR || gi > rearThird) return 'rear'
    return 'mid'
  }

  // ゾーン頭数（有効な全出走馬でカウント、6着以下も頭数には含む）
  const sizes = { front: 0, mid: 0, rear: 0 }
  ranked.forEach(h => { sizes[zoneOf(h.groupIdx)]++ })

  // 実獲得重み（上位5頭のみ、同着は占有スロット平均）
  const weighted = assignRankWeights(ranked)
  const earned = { front: 0, mid: 0, rear: 0 }
  weighted.forEach(h => { earned[zoneOf(h.groupIdx)] += h.weight })

  const rate = zone => {
    const max = theoreticalMax(sizes[zone])
    return max > 0 ? earned[zone] / max : null
  }

  return {
    frontRate: rate('front'),
    midRate: isNAR ? null : rate('mid'),
    rearRate: rate('rear'),
    sizes,
    earned,
  }
}

// 絶対判定の固定閾値（達成率ベース・暫定値、実データを見て調整する）
export const ABS_FRONT_THRESHOLD = 0.7
export const ABS_DIFF_THRESHOLD = 0.7

// レース展開を判定: front / flat / diff / pack(馬群一体)
// isNAR=true の場合: 中団なし（前1/3 vs 後2/3）
// opts.quantiles={q1,q3} 指定時は相対判定（コース別の達成率分布パーセンタイル）
// 未指定（またはopts.legacy=true）時は絶対判定（達成率の固定閾値）
export function predictTenkai(horses, totalGroups, isNAR = false, opts = {}) {
  if (totalGroups <= 1) return 'pack'

  const scores = computeScores(horses, totalGroups, isNAR)
  if (!scores) return null
  const { frontRate, rearRate } = scores

  // 相対判定: 前達成率をコース別分布のQ1/Q3と比較
  // Q3が達成率の上限1.0に張り付いている分布では「>Q3」が数学的に不成立となり
  // 前寄りが構造的に出なくなるため、上限到達（=1.0）をQ3超え扱いにする（下限0も対称に補正）
  if (!opts.legacy && opts.quantiles && opts.quantiles.q1 != null && opts.quantiles.q3 != null) {
    if (frontRate == null) return 'flat'
    const { q1, q3 } = opts.quantiles
    const EPS = 1e-9
    if (frontRate > q3 + EPS || (q3 >= 1 - EPS && frontRate >= 1 - EPS)) return 'front'
    if (frontRate < q1 - EPS || (q1 <= EPS && frontRate <= EPS)) return 'diff'
    return 'flat'
  }

  // 絶対判定: 前後それぞれの達成率を固定閾値と比較（両方超えたら高い方を採用）
  const frontHit = frontRate != null && frontRate >= ABS_FRONT_THRESHOLD
  const rearHit  = rearRate != null && rearRate >= ABS_DIFF_THRESHOLD
  if (frontHit && rearHit) return frontRate >= rearRate ? 'front' : 'diff'
  if (frontHit) return 'front'
  if (rearHit) return 'diff'
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
    const scores = computeScores(race.horses, race.totalGroups, true)
    if (!scores || scores.frontRate == null) return
    ratios.push(scores.frontRate)
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

// 相対判定（コース平年比）用ラベル
export const TENKAI_REL_LABEL = {
  front: '前寄り',
  flat:  '平年並み',
  diff:  '差し寄り',
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
