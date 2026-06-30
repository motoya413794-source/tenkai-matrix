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

// レース展開を判定: front / flat / diff / pack(馬群一体)
// 1着=3点, 2着=2点, 3着=2点, 4着=1点, 5着=1点 で重み付け
// isNAR=true の場合: 中団なし（前1/3 vs 残り全部）、閾値60%
export function predictTenkai(horses, totalGroups, isNAR = false) {
  if (totalGroups <= 2) return 'pack'

  const valid = horses.filter(h => h.groupIdx != null && h.finish)
  if (valid.length < 3) return null

  const ranked = valid
    .map(h => ({ groupIdx: h.groupIdx, finNum: parseInt(h.finish, 10) }))
    .filter(h => !isNaN(h.finNum))
    .sort((a, b) => a.finNum - b.finNum)

  if (ranked.length < 3) return null

  const top5 = ranked.slice(0, 5)
  const WEIGHTS = [3, 2, 2, 1, 1]
  const totalWeight = WEIGHTS.slice(0, top5.length).reduce((a, b) => a + b, 0)

  const frontThird = totalGroups / 3
  const rearThird  = totalGroups * 2 / 3

  let frontScore = 0, kohoScore = 0
  top5.forEach((h, i) => {
    const w = WEIGHTS[i]
    if (h.groupIdx <= frontThird) frontScore += w
    else if (isNAR || h.groupIdx > rearThird) kohoScore += w
  })

  const frontThreshold = 0.5
  const diffThreshold  = isNAR ? 0.2 : 0.3
  if (frontScore / totalWeight >= frontThreshold) return 'front'
  if (kohoScore / totalWeight >= diffThreshold) return 'diff'
  return 'flat'
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
