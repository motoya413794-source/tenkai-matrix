import { useState, useEffect } from 'react'
import {
  predictTenkai, computeScores, isDominant, dayTallyWeight,
  TENKAI_LABEL, TENKAI_REL_LABEL, STYLE_LABEL, STYLE_KEYS, TENKAI_KEYS,
  parseTimeStr, calcTrackVariant,
} from './tenkai.js'

// ── Helpers ───────────────────────────────────────────────
function gradeInfo(grade) {
  if (!grade) return { label: '', cls: '' }
  if (grade === 'GI'  || grade === 'G1')  return { label: 'GI',     cls: 'g1' }
  if (grade === 'GII' || grade === 'G2')  return { label: 'GII',    cls: 'g2' }
  if (grade === 'GIII'|| grade === 'G3')  return { label: 'GIII',   cls: 'g3' }
  if (grade === 'OP'  || grade === 'L')   return { label: 'OP',     cls: 'op' }
  if (grade === '3勝') return { label: '3勝クラス', cls: 'sannsho' }
  if (grade === '2勝') return { label: '2勝クラス', cls: 'nishoo' }
  if (grade === '1勝') return { label: '1勝クラス', cls: 'issho' }
  if (grade === '未勝利') return { label: '未勝利',  cls: 'mishouuri' }
  if (grade === '新馬')   return { label: '新馬',    cls: 'shinma' }
  return { label: grade, cls: 'tokubetsu' }
}

function trackLabel(variant) {
  if (variant == null) return null
  if (variant <= -0.5) return { label: 'スピード馬場', cls: 'fast' }
  if (variant >= 0.5)  return { label: 'タフ馬場',    cls: 'slow' }
  return                      { label: '標準馬場',    cls: 'even' }
}

const NAR_PATTERN = /^(門別|盛岡|水沢|浦和|船橋|大井|川崎|金沢|笠松|名古屋|園田|姫路|高知|佐賀)/
const JRA_VENUES = ['札幌','函館','福島','新潟','東京','中山','中京','京都','阪神','小倉']
const NAR_VENUES = ['門別','盛岡','水沢','浦和','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']

function isNAR(race) { return NAR_PATTERN.test(race.name) }

// 函館・福島・小倉・札幌のダートはNARロジック（中団なし・2区分パーセンタイル）を適用
const SHORT_DIRT_PATTERN = /^(函館|福島|小倉|札幌)/
function useNARLogic(race) {
  if (isNAR(race)) return true
  if (race.course === 'ダート' && SHORT_DIRT_PATTERN.test(race.name)) return true
  return false
}

// 判定ラベルに対応する達成率（前残り/前寄り→前ゾーン達成率、差し有利/差し寄り→後ゾーン達成率）
function biasPct(verdict, scores) {
  if (!scores) return 0
  if (verdict === 'front') return scores.frontRate ?? 0
  if (verdict === 'diff') return scores.rearRate ?? 0
  return scores.frontRate ?? 0
}

// 会場名をレースから抽出
function raceVenue(race) {
  const all = [...JRA_VENUES, ...NAR_VENUES]
  return all.find(v => race.name.startsWith(v)) || null
}

// venueの基準点（quantiles.json）を取得
// 自会場の母数が足りている(source==='own')場合のみ相対判定に使う。
// プール借用の基準は会場のクセを反映せず誤判定の原因になるため使わない
// （母数不足の会場は絶対判定にフォールバック）
function getQuantiles(venue, quantiles) {
  const q = quantiles?.[venue]
  return q && q.source === 'own' ? q : null
}

// predictTenkai用のoptsを組み立て
// パーセンタイル基準は2区分対象（NAR＋函館/福島/小倉/札幌ダート）のみに適用。
// それ以外のJRAレースに流用するとダート分布で芝を測る誤判定になるため必ず除外する
function tenkaiOpts(race, quantiles) {
  if (!useNARLogic(race)) return {}
  const venue = raceVenue(race)
  const q = getQuantiles(venue, quantiles)
  if (!q || q.q1 == null || q.q3 == null) return {}
  return { quantiles: { q1: q.q1, q3: q.q3 } }
}

// ── Day bias logic ────────────────────────────────────────
function tallyVerdict(races, course, opts) {
  const filtered = races.filter(r => r.course === course && !isDominant(r))
  const counts = { front: 0, flat: 0, diff: 0 }
  filtered.forEach(r => {
    const t = predictTenkai(r.horses, r.totalGroups, useNARLogic(r), typeof opts === 'function' ? opts(r) : opts)
    if (t && t !== 'pack') counts[t] += dayTallyWeight(r)
  })
  const total = counts.front + counts.flat + counts.diff
  if (total === 0) return { verdict: null, counts }
  let verdict = 'flat'
  if (counts.front / total >= 0.5) verdict = 'front'
  else if (counts.diff / total >= 0.5) verdict = 'diff'
  return { verdict, counts }
}

function dayCourseVerdict(races, course, quantiles) {
  const filtered = races.filter(r => r.course === course && !isDominant(r))
  if (filtered.length === 0) return null
  const variants = []
  filtered.forEach(r => {
    if (r.winTime && r.distance) {
      const sec = parseTimeStr(r.winTime)
      const v = calcTrackVariant(course, r.distance, sec, r.grade)
      if (v != null) variants.push(v)
    }
  })
  const abs = tallyVerdict(races, course, { legacy: true })
  // 相対判定は自会場基準を持つレースのみ対象（基準なし＝母数不足の会場はrel自体をnullに）
  const relRaces = races.filter(r => tenkaiOpts(r, quantiles).quantiles)
  const rel = relRaces.length > 0 ? tallyVerdict(relRaces, course, r => tenkaiOpts(r, quantiles)) : null
  const avgVariant = variants.length > 0
    ? Math.round(variants.reduce((a, b) => a + b, 0) / variants.length * 10) / 10
    : null
  return { abs, rel, avgVariant }
}

// ── DaySummary ────────────────────────────────────────────
function DaySummary({ races, compact = false, onCardClick, quantiles }) {
  return (
    <div className="day-summary">
      {['芝', 'ダート'].map(course => {
        const data = dayCourseVerdict(races, course, quantiles)
        if (!data) return null
        const { abs, rel, avgVariant } = data
        const courseKey = course === '芝' ? 'turf' : 'dirt'
        const t = trackLabel(avgVariant)
        const VerdictBadge = ({ label, v, relative = false }) => {
          const total = v.counts.front + v.counts.flat + v.counts.diff
          const pct = v.verdict && total > 0 ? Math.round(v.counts[v.verdict] / total * 100) : null
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '9px', color: 'var(--muted)' }}>{label}</span>
              {v.verdict
                ? <span className={`tenkai-badge ${v.verdict}`}>{(relative ? TENKAI_REL_LABEL : TENKAI_LABEL)[v.verdict]}{pct != null ? ` ${pct}%` : ''}</span>
                : <span className="tenkai-badge none">判定不能</span>
              }
            </span>
          )
        }
        if (compact) {
          return (
            <div key={course} className={`day-summary-card compact ${courseKey}`} onClick={onCardClick} role="button">
              <span className={`day-course-label ${courseKey}`}>{course}</span>
              <div className="compact-badges" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '3px' }}>
                <VerdictBadge label="絶対" v={abs} />
                {rel && <VerdictBadge label="相対" v={rel} relative />}
                {t && <span className={`track-variant ${t.cls}`}>{t.label}</span>}
              </div>
            </div>
          )
        }
        return (
          <div key={course} className={`day-summary-card ${courseKey}`}>
            <div className="day-summary-head" style={{ flexWrap: 'wrap', rowGap: '6px' }}>
              <span className={`day-course-label ${courseKey}`}>{course}</span>
              <VerdictBadge label="絶対判定" v={abs} />
              {rel && <VerdictBadge label="相対判定" v={rel} relative />}
              {t && <span className={`track-variant ${t.cls}`}>{t.label}</span>}
            </div>
            {[['絶対判定（達成率・固定閾値）', abs, TENKAI_LABEL], ...(rel ? [['相対判定（コース平年比）', rel, TENKAI_REL_LABEL]] : [])].map(([title, v, labels]) => {
              const total = v.counts.front + v.counts.flat + v.counts.diff
              return (
                <div key={title} style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '10px', color: 'var(--muted)', marginBottom: '4px' }}>{title}</div>
                  <div className="day-summary-bars">
                    {[['front', labels.front], ['flat', labels.flat === '前後フラット' ? 'フラット' : labels.flat], ['diff', labels.diff]].map(([key, label]) => (
                      <div key={key} className="day-bar-row">
                        <span className="day-bar-label">{label}</span>
                        <div className="day-bar-track">
                          <div className={`day-bar-fill ${key}`} style={{ width: total > 0 ? `${v.counts[key]/total*100}%` : '0%' }} />
                        </div>
                        <span className="day-bar-count">{v.counts[key]}R {total > 0 ? `${Math.round(v.counts[key]/total*100)}%` : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ── 展開不利馬 ─────────────────────────────────────────────
function UnfavRaceGroup({ race, tenkai, horses, raceNum, onNavigate }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="unfav-race-group">
      <div className="unfav-race-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        {raceNum && <span className="unfav-race-num">{raceNum}</span>}
        <span className="unfav-race-name">{race.raceName || race.name}</span>
        <span className={`tenkai-badge ${tenkai}`}>{TENKAI_LABEL[tenkai]}</span>
        <span className="unfav-race-arrow">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="unfav-horse-list">
          {horses.map((h, i) => {
            const fin = parseInt(h.finish)
            let comment, commentCls
            if (fin === 1) {
              comment = '展開不利の中でも勝利で、高く評価できる'
              commentCls = 'unfav-comment top'
            } else if (fin <= 3) {
              comment = '展開不利の中でも好走しており、評価できる'
              commentCls = 'unfav-comment good'
            } else {
              comment = tenkai === 'front' ? '後方から不発' : '先行して不発'
              commentCls = 'unfav-comment'
            }
            return (
              <div key={i} className="unfav-horse-row">
                <span className="unfav-finish">{h.finish}着</span>
                <span className="unfav-name">{h.name}</span>
                {h.popularity != null && (
                  <span className="unfav-popularity">{h.popularity}人気</span>
                )}
                <span className={commentCls}>{comment}</span>
              </div>
            )
          })}
          <button className="unfav-nav-btn" onClick={onNavigate}>詳細を見る →</button>
        </div>
      )}
    </div>
  )
}

function UnfavorableList({ races, onRaceClick, quantiles }) {
  const [open, setOpen] = useState(false)
  const groups = []

  races.forEach(race => {
    if (isDominant(race)) return
    const nar = useNARLogic(race)
    const tenkai = predictTenkai(race.horses, race.totalGroups, nar, tenkaiOpts(race, quantiles))
    if (!tenkai || tenkai === 'pack' || tenkai === 'flat') return
    const frontThird = race.totalGroups / 3
    const unfavHorses = race.horses.filter(h => {
      if (!h.groupIdx || !h.finish) return false
      if (tenkai === 'front') return h.groupIdx > frontThird
      if (tenkai === 'diff')  return h.groupIdx <= frontThird
      return false
    }).sort((a, b) => parseInt(a.finish) - parseInt(b.finish))
    if (unfavHorses.length > 0) groups.push({ race, tenkai, horses: unfavHorses })
  })

  if (groups.length === 0) return null
  const total = groups.reduce((s, g) => s + g.horses.length, 0)

  return (
    <div className="unfav-section">
      <button className="unfav-toggle" onClick={() => setOpen(o => !o)}>
        <span>展開不利馬</span>
        <span className="unfav-toggle-count">{total}頭</span>
        <span className="unfav-toggle-arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="unfav-body">
          {groups.map(({ race, tenkai, horses }) => {
            const raceNumMatch = race.name.match(/(\d+R)/)
            const raceNum = raceNumMatch ? raceNumMatch[1] : ''
            return (
              <UnfavRaceGroup
                key={race.name}
                race={race}
                tenkai={tenkai}
                horses={horses}
                raceNum={raceNum}
                onNavigate={() => onRaceClick?.(race)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Race card ─────────────────────────────────────────────
function RaceCard({ race, quantiles }) {
  const [open, setOpen] = useState(false)
  const dominant = isDominant(race)
  const narLogic = useNARLogic(race)
  const tenkaiAbs = dominant ? null : predictTenkai(race.horses, race.totalGroups, narLogic, { legacy: true })
  const relOpts = tenkaiOpts(race, quantiles)
  const tenkaiRel = dominant || !relOpts.quantiles ? null : predictTenkai(race.horses, race.totalGroups, narLogic, relOpts)
  const scores = dominant ? null : computeScores(race.horses, race.totalGroups, narLogic)
  const g = gradeInfo(race.grade)

  const frontThird = race.totalGroups / 3
  const rearThird  = race.totalGroups * 2 / 3
  const grouped = { front: [], mid: [], rear: [] }
  const sorted = [...race.horses].sort((a, b) => parseInt(a.finish) - parseInt(b.finish))
  sorted.forEach(h => {
    if (!h.groupIdx) return
    if (h.groupIdx <= frontThird) grouped.front.push(h)
    else if (!narLogic && h.groupIdx <= rearThird) grouped.mid.push(h)
    else grouped.rear.push(h)
  })

  const groups = [['前', grouped.front], ['中', narLogic ? [] : grouped.mid], ['後', grouped.rear]]

  return (
    <div
      id={`race-card-${race.name.replace(/\s/g, '-')}`}
      className={`race-card course-${race.course === '芝' ? 'turf' : 'dirt'}${dominant ? ' dominant' : ''}`}
      style={{ flexDirection: 'column', alignItems: 'stretch', cursor: 'pointer' }}
      onClick={() => setOpen(o => !o)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div className="race-card-info">
          <div className="race-card-name">
            {g.label && <span className={`grade-badge ${g.cls}`}>{g.label}</span>}
            {race.raceName || race.name}
            {dominant && <span className="dominant-badge">⚠ 勝ち馬突出</span>}
          </div>
          <div className="race-card-meta">
            {race.course}{race.distance}m
            {race.trackCondition && <span className="track-cond-inline">{race.trackCondition}</span>}
            {race.winTime && <span className="win-time">{race.winTime}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-end' }}>
          {dominant ? (
            <span className="tenkai-badge none">参考外</span>
          ) : (
            <>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '9px', color: 'var(--muted)', minWidth: '38px', textAlign: 'right' }}>絶対判定</span>
                <span className={`tenkai-badge ${tenkaiAbs || 'none'}`}>
                  {tenkaiAbs ? `${TENKAI_LABEL[tenkaiAbs]} ${Math.round(biasPct(tenkaiAbs, scores) * 100)}%` : 'データ不足'}
                </span>
              </span>
              {tenkaiRel && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '9px', color: 'var(--muted)', minWidth: '38px', textAlign: 'right' }}>相対判定</span>
                  <span className={`tenkai-badge ${tenkaiRel}`}>
                    {TENKAI_REL_LABEL[tenkaiRel]} {Math.round(biasPct(tenkaiRel, scores) * 100)}%
                  </span>
                </span>
              )}
            </>
          )}
        </div>
        <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: '12px' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px' }}>
          {groups.filter(([, grpH]) => grpH.length > 0).map(([lbl, grpH], gi) => {
            const laneColor = lbl === '前'
              ? 'rgba(239,68,68,0.08)' : lbl === '中'
              ? 'rgba(234,179,8,0.08)' : 'rgba(59,130,246,0.08)'
            const labelColor = lbl === '前' ? '#ef4444' : lbl === '中' ? '#ca8a04' : '#3b82f6'
            return (
              <div key={lbl} style={{ marginBottom: gi < groups.filter(([,g])=>g.length>0).length-1 ? '8px' : 0, background: laneColor, borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: labelColor, marginBottom: '6px', letterSpacing: '0.05em' }}>{lbl}ポジション ({grpH.length}頭)</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {grpH.map((h, i) => {
                    const fin = parseInt(h.finish)
                    const isTop = fin <= 3
                    const medal = fin === 1 ? '🥇' : fin === 2 ? '🥈' : fin === 3 ? '🥉' : null
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: '4px',
                        background: isTop ? 'var(--card)' : 'transparent',
                        border: isTop ? '1px solid var(--border)' : '1px solid transparent',
                        borderRadius: '20px', padding: '3px 8px',
                        fontSize: '13px',
                        fontWeight: isTop ? 700 : 400,
                      }}>
                        {medal
                          ? <span style={{ fontSize: '14px' }}>{medal}</span>
                          : <span style={{ color: 'var(--muted)', fontSize: '11px', minWidth: '18px' }}>{h.finish}着</span>
                        }
                        <span>{h.name}</span>
                        {h.popularity != null && (
                          <span style={{ color: 'var(--muted)', fontSize: '10px' }}>{h.popularity}人気</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Venue section ─────────────────────────────────────────
function VenueSection({ venue, races, tab, setTab, quantiles }) {
  const condChips = ['芝', 'ダート'].map(surf => {
    const r = races.find(r => r.course === surf && r.trackCondition)
    if (!r) return null
    return <span key={surf} className={`track-cond-chip ${surf === '芝' ? 'turf' : 'dirt'}`}>{surf} {r.trackCondition}</span>
  }).filter(Boolean)

  return (
    <div id={`venue-${venue}`}>
      <div className="venue-section-head">
        {venue}
        {condChips.length > 0 && <span className="track-cond-chips">{condChips}</span>}
      </div>
      <div className="sec-head"><span className="sec-title">1日まとめ</span></div>
      <DaySummary races={races} quantiles={quantiles} />
      <div className="sec-head" style={{ marginTop: '24px' }}><span className="sec-title">記録済みレース</span></div>
      <div className="race-list">
        {races.map((race, i) => <RaceCard key={i} race={race} quantiles={quantiles} />)}
      </div>
      <UnfavorableList
        races={races}
        quantiles={quantiles}
        onRaceClick={race => {
          const league = NAR_VENUES.includes(venue) ? 'nar' : 'jra'
          setTab(league)
          setTimeout(() => {
            const id = `race-card-${race.name.replace(/\s/g, '-')}`
            document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }, 50)
        }}
      />
    </div>
  )
}

// ── Day view ──────────────────────────────────────────────
function DayView({ data, quantiles }) {
  const [tab, setTab] = useState('jra')

  const venues = data.venues || {}
  const jraVenues = JRA_VENUES.filter(v => venues[v])
  const narVenues = NAR_VENUES.filter(v => venues[v])
  const hasJRA = jraVenues.length > 0
  const hasNAR = narVenues.length > 0

  const activeVenues = tab === 'jra' ? jraVenues : narVenues

  return (
    <div>
      {/* トップサマリー */}
      <div className="track-bias-label">トラックバイアスまとめ</div>
      {[['中央', jraVenues], ['地方', narVenues]].map(([label, vs]) => {
        if (vs.length === 0) return null
        return (
          <div key={label}>
            <div className="league-head">{label}</div>
            <div className="top-summary-grid">
              {vs.map(venue => (
                <div key={venue} className="top-summary-venue">
                  <div className="top-summary-venue-name">{venue}</div>
                  <DaySummary
                    races={venues[venue]}
                    quantiles={quantiles}
                    compact
                    onCardClick={() => {
                      const league = NAR_VENUES.includes(venue) ? 'nar' : 'jra'
                      setTab(league)
                      setTimeout(() => {
                        document.getElementById(`venue-${venue}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }, 50)
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* タブ切替 */}
      {hasJRA && hasNAR && (
        <div className="tab-bar">
          <button className={`tab-btn ${tab === 'jra' ? 'active' : ''}`} onClick={() => setTab('jra')}>中央</button>
          <button className={`tab-btn ${tab === 'nar' ? 'active' : ''}`} onClick={() => setTab('nar')}>地方</button>
        </div>
      )}

      {/* 会場別詳細 */}
      {activeVenues.map(venue => (
        <VenueSection key={venue} venue={venue} races={venues[venue]} tab={tab} setTab={setTab} quantiles={quantiles} />
      ))}
    </div>
  )
}

// ── History Chart ─────────────────────────────────────────
function BiasBar({ counts, date }) {
  const total = counts.front + counts.flat + counts.diff
  if (total === 0) return <div className="bias-bar-empty" title={date}>-</div>
  const frontPct = Math.round(counts.front / total * 100)
  const diffPct  = Math.round(counts.diff  / total * 100)
  const flatPct  = 100 - frontPct - diffPct
  const label = `${date} 前残り${frontPct}% フラット${flatPct}% 差し${diffPct}%`
  const H = 120
  const diffPx  = Math.round(diffPct  / 100 * H)
  const flatPx  = Math.round(flatPct  / 100 * H)
  const frontPx = H - diffPx - flatPx
  return (
    <div className="bias-bar" title={label}>
      {diffPx  > 0 && <div style={{ background: '#2a5f93', height: diffPx  + 'px', width: '100%', flexShrink: 0 }} />}
      {flatPx  > 0 && <div style={{ background: '#7a6b12', height: flatPx  + 'px', width: '100%', flexShrink: 0 }} />}
      {frontPx > 0 && <div style={{ background: '#a5302a', height: frontPx + 'px', width: '100%', flexShrink: 0 }} />}
    </div>
  )
}

function HistoryView({ dates, quantiles }) {
  const [allData, setAllData] = useState({}) // { dateISO: venuesObj }
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [selectedVenue, setSelectedVenue] = useState(null)
  const [selectedCourse, setSelectedCourse] = useState('ダート')

  useEffect(() => {
    const fetchOne = async (url, retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          const r = await fetch(url)
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return await r.json()
        } catch {
          if (i === retries - 1) return null
          await new Promise(res => setTimeout(res, 800 * (i + 1)))
        }
      }
    }
    Promise.all(dates.map(d => fetchOne(`/data/${d}.json`))).then(results => {
      const map = {}
      results.forEach((data, i) => { if (data) map[dates[i]] = data.venues || {} })
      setAllData(map)
      setLoadingHistory(false)
    })
  }, [dates])

  if (loadingHistory) return <div className="history-loading">読み込み中…</div>

  // 全会場を収集
  const venueSet = new Set()
  Object.values(allData).forEach(venues => Object.keys(venues).forEach(v => venueSet.add(v)))
  const allVenues = [...JRA_VENUES, ...NAR_VENUES].filter(v => venueSet.has(v))

  const venue = selectedVenue || allVenues[0]

  // 各日付でこの会場・コースのcountsを計算
  const chartData = dates.map(d => {
    const venues = allData[d] || {}
    const allRaces = venues[venue] || []
    const races = allRaces.filter(r => r.course === selectedCourse && !isDominant(r))
    const counts = { front: 0, flat: 0, diff: 0 }
    races.forEach(r => {
      const t = predictTenkai(r.horses, r.totalGroups, useNARLogic(r), tenkaiOpts(r, quantiles))
      if (t && t !== 'pack') counts[t]++
    })
    const label = `${parseInt(d.slice(5,7))}/${parseInt(d.slice(8,10))}`
    // 代表値：その日その会場・コースの最初のレースから取得
    const rep = allRaces.find(r => r.course === selectedCourse) || allRaces[0]
    const trackCond = rep?.trackCondition || null
    const weather = rep?.weather || null
    const courseType = selectedCourse === '芝' ? (rep?.courseType || null) : null
    const kaisaiDay = rep?.kaisaiDay || null
    return { date: d, label, counts, trackCond, weather, courseType, kaisaiDay }
  }).filter(({ counts }) => counts.front + counts.flat + counts.diff > 0)

  // コースの選択肢（この会場で実際にあるもの）
  const availableCourses = ['芝', 'ダート'].filter(c =>
    dates.some(d => (allData[d]?.[venue] || []).some(r => r.course === c))
  )

  return (
    <div className="history-view">
      {/* 会場選択 */}
      <div className="history-controls">
        <div className="history-venue-scroll">
          {allVenues.map(v => (
            <button
              key={v}
              className={`history-venue-btn ${v === venue ? 'active' : ''}`}
              onClick={() => { setSelectedVenue(v); setSelectedCourse(availableCourses[0] || 'ダート') }}
            >{v}</button>
          ))}
        </div>
        <div className="history-course-tabs">
          {availableCourses.map(c => (
            <button
              key={c}
              className={`history-course-btn ${c === selectedCourse ? 'active' : ''}`}
              onClick={() => setSelectedCourse(c)}
            >{c}</button>
          ))}
        </div>
      </div>

      {/* グラフ */}
      <div className="history-chart">
        <div className="history-legend">
          <span className="legend-item front">前残り</span>
          <span className="legend-item flat">フラット</span>
          <span className="legend-item diff">差し有利</span>
        </div>
        {chartData.length === 0
          ? <div className="history-nodata">データなし</div>
          : (
            <div className="history-bars">
              {chartData.map(({ date, label, counts, trackCond, weather, courseType, kaisaiDay }) => (
                <div key={date} className="history-col">
                  <BiasBar counts={counts} date={label} />
                  <div className="history-date-label">{label}</div>
                </div>
              ))}
            </div>
          )
        }
      </div>

      {/* 数値テーブル */}
      {chartData.length > 0 && (
        <div className="history-table">
          <div className="history-table-head">
            <span>日付</span><span>馬場</span><span>前残り</span><span>フラット</span><span>差し</span>
          </div>
          {chartData.map(({ date, label, counts, trackCond, weather, courseType, kaisaiDay }) => {
            const total = counts.front + counts.flat + counts.diff
            const condParts = [trackCond, weather, courseType ? `${courseType}コース` : null, kaisaiDay ? `${kaisaiDay}日目` : null].filter(Boolean)
            return (
              <div key={date} className="history-table-row">
                <span>{label}</span>
                <span style={{ color: 'var(--muted)', fontSize: '11px' }}>{condParts.join(' ')}</span>
                <span className="front-text">{counts.front}R ({Math.round(counts.front/total*100)}%)</span>
                <span className="flat-text">{counts.flat}R ({Math.round(counts.flat/total*100)}%)</span>
                <span className="diff-text">{counts.diff}R ({Math.round(counts.diff/total*100)}%)</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── 明日の注目馬（展開不利歴のある出走馬）──────────────────
function HorseHistoryCard({ name, records }) {
  const [open, setOpen] = useState(false)
  const notable = records.filter(r => parseInt(r.finish, 10) <= 3).length
  return (
    <div className="watch-horse-card">
      <div className="watch-horse-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="watch-horse-name">{name}</span>
        <span className="watch-horse-count">{records.length}回 展開不利歴{notable > 0 ? `（好走${notable}回）` : ''}</span>
        <span className="unfav-race-arrow">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="unfav-horse-list">
          {records.slice(0, 5).map((r, i) => {
            const fin = parseInt(r.finish, 10)
            const comment = fin === 1 ? '不利でも勝利' : fin <= 3 ? '不利でも好走' : '不利で凡走'
            const label = `${r.date.slice(5).replace('-', '/')} ${r.venue} ${TENKAI_LABEL[r.tenkai]}`
            return (
              <div key={i} className="unfav-horse-row">
                <span className="unfav-finish">{r.finish}着</span>
                <span className="unfav-name">{label}</span>
                <span className="unfav-comment">{comment}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function WatchRaceGroup({ race, flagged }) {
  const [open, setOpen] = useState(false)
  const raceNumMatch = race.name.match(/(\d+R)/)
  const raceNum = raceNumMatch ? raceNumMatch[1] : ''
  return (
    <div className="unfav-race-group" style={{ marginTop: '8px' }}>
      <div className="unfav-race-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        {raceNum && <span className="unfav-race-num">{raceNum}</span>}
        <span className="unfav-race-name">{race.raceName || race.name}</span>
        <span className="unfav-toggle-count">{flagged.length}頭</span>
        <span className="unfav-race-arrow">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="unfav-horse-list">
          {flagged.map((h, i) => (
            <HorseHistoryCard key={i} name={h.name} records={h.records} />
          ))}
        </div>
      )}
    </div>
  )
}

const STYLE_JA = { senkou: '先行', chutan: '中団', koho: '差し' }

function BiasMatchCard({ h }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="watch-horse-card">
      <div className="watch-horse-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="watch-horse-name">{h.name}</span>
        <span className="watch-horse-count">
          {h.popularity != null ? `${h.popularity}番人気 ` : ''}直近{h.recentRaces.length}走{STYLE_JA[h.style]}多数
        </span>
        <span className="unfav-race-arrow">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="unfav-horse-list">
          <div className="unfav-horse-row">
            <span className="unfav-name">脚質履歴（古い→新しい）</span>
            <span className="unfav-comment">{h.recentRaces.map(r => STYLE_JA[r.style]).join(' → ')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function BiasMatchRaceGroup({ race, bias, horses }) {
  const [open, setOpen] = useState(false)
  const raceNumMatch = race.name.match(/(\d+R)/)
  const raceNum = raceNumMatch ? raceNumMatch[1] : ''
  return (
    <div className="unfav-race-group" style={{ marginTop: '8px' }}>
      <div className="unfav-race-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        {raceNum && <span className="unfav-race-num">{raceNum}</span>}
        <span className="unfav-race-name">{race.raceName || race.name}</span>
        <span className="unfav-toggle-count">{horses.length}頭</span>
        <span className="unfav-race-arrow">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="unfav-horse-list">
          {horses.map((h, i) => <BiasMatchCard key={i} h={h} />)}
        </div>
      )}
    </div>
  )
}

function WatchView({ quantiles }) {
  const [subTab, setSubTab] = useState('bias') // 'bias' | 'unfav'
  const [entries, setEntries] = useState(undefined) // undefined=読込中, null=データなし
  const [history, setHistory] = useState(null)
  const [biasMatch, setBiasMatch] = useState(undefined)

  useEffect(() => {
    const fetchOne = async (url) => {
      try {
        const r = await fetch(url)
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }
    ;(async () => {
      const d = new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000)
      const tomorrow = d.toISOString().slice(0, 10)
      let data = await fetchOne(`/data/entries-${tomorrow}.json`)
      let matchDate = tomorrow
      if (!data) {
        // 翌日分がまだ無ければ当日分にフォールバック
        const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
        data = await fetchOne(`/data/entries-${today}.json`)
        matchDate = today
      }
      setEntries(data || null)
      if (data) {
        const bm = await fetchOne(`/data/bias-match-${matchDate}.json`)
        setBiasMatch(bm || null)
      } else {
        setBiasMatch(null)
      }
    })()
    fetchOne('/data/horse-bias-history.json').then(setHistory)
  }, [])

  if (entries === undefined || history === null) {
    return <div className="history-loading">読み込み中…</div>
  }
  if (!entries) {
    return <div className="history-nodata">出走表データがまだありません（レース前日夜に更新されます）</div>
  }

  const JRA_ORDER = ['札幌','函館','福島','新潟','東京','中山','中京','京都','阪神','小倉']
  const NAR_ORDER = ['門別','盛岡','水沢','浦和','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']
  const allVenues = [...JRA_ORDER, ...NAR_ORDER].filter(v => entries.venues[v])

  let totalFlagged = 0
  const venueGroups = allVenues.map(venue => {
    const races = entries.venues[venue]
    const raceGroups = races.map(race => {
      const flagged = race.horses
        .filter(h => history[h.name])
        .map(h => ({ ...h, records: history[h.name] }))
      return { race, flagged }
    }).filter(g => g.flagged.length > 0)
    totalFlagged += raceGroups.reduce((s, g) => s + g.flagged.length, 0)
    return { venue, raceGroups }
  }).filter(g => g.raceGroups.length > 0)

  const biasVenues = biasMatch ? Object.entries(biasMatch.venues || {}) : []
  const totalBiasMatched = biasVenues.reduce((s, [, v]) => s + v.races.reduce((s2, r) => s2 + r.horses.length, 0), 0)

  return (
    <div className="watch-view">
      <div className="tab-bar" style={{ marginBottom: '16px' }}>
        <button className={`tab-btn ${subTab === 'bias' ? 'active' : ''}`} onClick={() => setSubTab('bias')}>バイアス適合馬</button>
        <button className={`tab-btn ${subTab === 'unfav' ? 'active' : ''}`} onClick={() => setSubTab('unfav')}>展開不利歴</button>
      </div>

      {subTab === 'bias' && (
        <>
          <div className="track-bias-label">{entries.dateDisplay} 今のバイアスに脚質が合う馬（{totalBiasMatched}頭）</div>
          <p style={{ fontSize: '12px', color: 'var(--ink-soft)', margin: '0 0 16px' }}>
            会場・コースごとの直近{5}日間の傾向（データ不足の地方競馬場は前有利をデフォルト想定）と、
            馬の直近5走の脚質多数決を照合しています。参考情報であり、着順を保証するものではありません。
          </p>
          {biasMatch === undefined && <div className="history-loading">読み込み中…</div>}
          {biasMatch === null && <div className="history-nodata">バイアス照合データがまだありません</div>}
          {biasVenues.length === 0 && biasMatch != null && <div className="history-nodata">該当する馬はいませんでした</div>}
          {biasVenues.map(([venue, v]) => (
            <div key={venue} style={{ marginBottom: '20px' }}>
              <div className="venue-section-head">
                {venue}
                <span className="track-cond-chips">
                  {Object.entries(v.biasByCourse).map(([course, b]) => (
                    <span key={course} className={`tenkai-badge ${b.bias || 'none'}`} style={{ marginLeft: '6px' }}>
                      {course}:{b.bias ? TENKAI_LABEL[b.bias] : '不明'}{b.source === 'default' ? '(想定)' : ''}
                    </span>
                  ))}
                </span>
              </div>
              {v.races.map(({ race, bias, horses }) => (
                <BiasMatchRaceGroup key={race.name} race={race} bias={bias} horses={horses} />
              ))}
            </div>
          ))}
        </>
      )}

      {subTab === 'unfav' && (
        <>
          <div className="track-bias-label">{entries.dateDisplay} 展開不利歴のある出走馬（{totalFlagged}頭）</div>
          <p style={{ fontSize: '12px', color: 'var(--ink-soft)', margin: '0 0 16px' }}>
            過去に展開不利な位置取りで走ったことがある馬をレース単位で表示しています。参考情報であり、明日の展開や着順を保証するものではありません。
          </p>
          {venueGroups.length === 0 && <div className="history-nodata">該当する馬はいませんでした</div>}
          {venueGroups.map(({ venue, raceGroups }) => (
            <div key={venue} style={{ marginBottom: '20px' }}>
              <div className="venue-section-head">{venue}</div>
              {raceGroups.map(({ race, flagged }) => (
                <WatchRaceGroup key={race.name} race={race} flagged={flagged} />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────
export default function App() {
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const [dayData, setDayData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [mainTab, setMainTab] = useState('today') // 'today' | 'history'
  const [quantiles, setQuantiles] = useState(null)

  // fetch with retry
  const fetchWithRetry = async (url, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return await r.json()
      } catch (e) {
        if (i === retries - 1) throw e
        await new Promise(res => setTimeout(res, 1000 * (i + 1)))
      }
    }
  }

  // Load date index
  useEffect(() => {
    fetchWithRetry('/data/index.json')
      .then(list => {
        const sorted = [...list].sort((a, b) => b.localeCompare(a))
        setDates(sorted)
        if (sorted.length > 0) setSelectedDate(sorted[0])
        else setLoading(false)
      })
      .catch(() => {
        setError('データが見つかりませんでした')
        setLoading(false)
      })
    fetchWithRetry('/data/quantiles.json').then(setQuantiles).catch(() => setQuantiles(null))
  }, [])

  // Load selected date's data
  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    setError(null)
    setDayData(null)
    fetchWithRetry(`/data/${selectedDate}.json`)
      .then(data => {
        setDayData(data)
        setLoading(false)
      })
      .catch(() => {
        setError('データの読み込みに失敗しました')
        setLoading(false)
      })
  }, [selectedDate])

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="eyebrow">TRACK BIAS</div>
        <h1>トラックバイアス記録</h1>
        <div className="sub">当日の展開傾向をレース結果から分析</div>
      </header>

      {/* メインタブ */}
      <div className="tab-bar" style={{ marginTop: '16px' }}>
        <button className={`tab-btn ${mainTab === 'today' ? 'active' : ''}`} onClick={() => setMainTab('today')}>当日バイアス</button>
        <button className={`tab-btn ${mainTab === 'history' ? 'active' : ''}`} onClick={() => setMainTab('history')}>履歴グラフ</button>
        <button className={`tab-btn ${mainTab === 'watch' ? 'active' : ''}`} onClick={() => setMainTab('watch')}>注目馬</button>
      </div>

      {mainTab === 'history' && dates.length > 0 && (
        <HistoryView dates={dates} quantiles={quantiles} />
      )}

      {mainTab === 'watch' && (
        <WatchView quantiles={quantiles} />
      )}

      {mainTab === 'today' && <>
        {/* 日付タブ */}
        {dates.length > 1 && (
          <div className="date-tab-bar">
            {(() => {
              const items = []
              let lastMonth = null
              dates.forEach(d => {
                const month = d.slice(0, 7)
                if (month !== lastMonth) {
                  items.push(<span key={`m-${month}`} className="date-tab-month">{parseInt(d.slice(5, 7))}月</span>)
                  lastMonth = month
                }
                const label = `${parseInt(d.slice(8, 10))}日`
                items.push(
                  <button
                    key={d}
                    className={`date-tab-btn ${d === selectedDate ? 'active' : ''}`}
                    onClick={() => setSelectedDate(d)}
                  >
                    {label}
                  </button>
                )
              })
              return items
            })()}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-soft)' }}>
            読み込み中…
          </div>
        )}
        {error && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-soft)' }}>
            <div>{error}</div>
            <button
              onClick={() => { setError(null); setSelectedDate(d => d) }}
              style={{ marginTop: '12px', padding: '8px 20px', borderRadius: '20px', border: '1px solid var(--line)', background: 'var(--paper-card)', cursor: 'pointer', fontSize: '13px' }}
            >再読み込み</button>
          </div>
        )}
        {dayData && !loading && (
          <>
            <div className="date-section-head">{dayData.dateDisplay || selectedDate}</div>
            <DayView data={dayData} quantiles={quantiles} />
          </>
        )}
      </>}
    </div>
  )
}
