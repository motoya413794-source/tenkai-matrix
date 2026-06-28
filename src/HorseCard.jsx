import { useRef, useState } from 'react'

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

const CATS = [
  { key: 'start', label: '出遅れ' },
  { key: 'track', label: '馬場質' },
  { key: 'path', label: '進路' },
  { key: 'pace', label: '展開' },
  { key: 'rhythm', label: '折り合い' },
]

const LEAN = {
  win:      { label: '勝ち／恵まれた可能性',               bg: '#e8f5ee', fg: '#1d6b46' },
  excuse:   { label: '言い訳できる負け → 穴党に人気しそう', bg: '#e8f0fb', fg: '#3d2e8a' },
  half:     { label: '言い訳しにくい → 評価据え置き〜割引', bg: '#fff8e0', fg: '#7a5b00' },
  noexcuse: { label: '言い訳しにくい凡走 → 見限られそう',  bg: '#fde8e8', fg: '#8a1c1c' },
  none:     { label: '対象外',                            bg: '#f0f0f0', fg: '#666' },
}

const SRC_MAP = {
  camp:  { label: '陣営', cls: 'src-camp' },
  fan:   { label: 'ファン', cls: 'src-fan' },
  kaiko: { label: '回顧', cls: 'src-kaiko' },
  jra:   { label: 'JRA', cls: 'src-jra' },
}

function buildTweetText(horse, raceName) {
  const L = LEAN[horse.lean] || LEAN.none
  let furiText = ''
  for (const c of CATS) {
    const v = horse.events[c.key]
    if (v && v.text && /崩|詰ま|不利|ロス|ノメ|後退|出遅|出負/.test(v.text)) {
      furiText = `${c.label}で不利`
      break
    }
  }
  const tag = horse.lean === 'excuse' ? '言い訳の立つ負け'
    : horse.lean === 'half' ? '力負け気味'
    : horse.lean === 'noexcuse' ? '言い訳しにくい凡走'
    : horse.lean === 'win' ? '勝利' : ''
  const quoteSnippet = horse.quote ? `🗣️${horse.quote.who}「${horse.quote.full.slice(0, 38)}…」\n` : ''
  const raceTag = raceName.replace(/\s/g, '')
  return `【${raceName} 回顧】\n${horse.finish} ${horse.name}（${horse.jockey}）\n`
    + (furiText ? `▶ ${furiText}\n` : '')
    + (tag ? `▶ ${tag}\n` : '')
    + quoteSnippet
    + `#${raceTag} #不利記録ノート`
}

export default function HorseCard({ horse, index, raceName, raceId, showToast }) {
  const cardRef = useRef(null)
  const [imgDataUrl, setImgDataUrl] = useState(null)
  const L = LEAN[horse.lean] || LEAN.none

  const handleImage = async () => {
    const html2canvas = (await import('html2canvas')).default
    showToast('画像を生成中…')

    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;background:#fbf9f2;font-family:"Hiragino Sans","Yu Gothic",system-ui,sans-serif;'

    const evRows = CATS.map(c => {
      const v = horse.events[c.key]
      const src = v ? SRC_MAP[v.src] : null
      const srcTag = src ? `<span style="font-size:10px;font-weight:700;margin-left:5px;">${src.label}</span>` : ''
      return `<div style="display:flex;gap:8px;padding:5px 0;border-top:1px solid #d8d1be;align-items:baseline;">
        <span style="flex-shrink:0;width:48px;font-size:11px;color:#4a574e;font-weight:700;">${c.label}</span>
        <span style="font-size:12px;color:${v ? '#16201a' : '#8a958c'};font-style:${v ? 'normal' : 'italic'};line-height:1.5;">${v ? v.text + srcTag : 'あまり声が上がっていない'}</span>
      </div>`
    }).join('')

    const quoteHtml = horse.quote
      ? `<div style="background:#f3efe4;border-left:3px solid #1d6b46;padding:9px 12px;">
          <div style="font-size:10px;color:#8a958c;margin-bottom:4px;">— ${horse.quote.who}</div>
          <div style="font-size:12px;line-height:1.65;">「${horse.quote.full}」</div>
        </div>`
      : `<p style="font-size:12px;color:#8a958c;font-style:italic;">コメントなし</p>`

    wrap.innerHTML = `<div style="padding:16px;">${evRows}${quoteHtml}</div>`
    document.body.appendChild(wrap)
    try {
      const canvas = await html2canvas(wrap, { backgroundColor: '#fbf9f2', scale: 2, useCORS: true })
      document.body.removeChild(wrap)
      if (isMobile) {
        setImgDataUrl(canvas.toDataURL('image/png'))
      } else {
        canvas.toBlob(blob => {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = `furikiroku-${horse.name}.png`; a.click()
          URL.revokeObjectURL(url)
          showToast('画像を保存しました')
        })
      }
    } catch {
      if (document.body.contains(wrap)) document.body.removeChild(wrap)
      showToast('画像生成に失敗しました')
    }
  }

  const handleTweet = async () => {
    const txt = buildTweetText(horse, raceName)
    try { await navigator.clipboard.writeText(txt) } catch {
      const ta = document.createElement('textarea')
      ta.value = txt; document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); ta.remove()
    }
    showToast('ツイート文をコピーしました')
  }

  return (
    <div className="furi-card" ref={cardRef}>
      <div className="furi-card-head" style={{ borderLeft: `4px solid ${horse.frameColor || '#5a5346'}` }}>
        <div className="furi-finish">{horse.finish}</div>
        <div className="furi-horse-info">
          <span className="furi-horse-name">{horse.name}</span>
          <span className="furi-horse-meta">騎手：{horse.jockey}　{horse.popularity}</span>
        </div>
        <span className="furi-lean-pill" style={{ background: L.bg, color: L.fg }}>{L.label}</span>
      </div>

      <div className="furi-section">
        <div className="furi-sec-label">どんな不利があったか</div>
        {CATS.map(c => {
          const v = horse.events[c.key]
          const src = SRC_MAP[v?.src]
          return (
            <div className="furi-ev-row" key={c.key}>
              <span className="furi-ev-cat">{c.label}</span>
              {v ? (
                <span className="furi-ev-val">
                  {v.text}
                  {src && <span className={`furi-src-tag ${src.cls}`}>{src.label}</span>}
                </span>
              ) : (
                <span className="furi-ev-val furi-none">あまり声が上がっていない</span>
              )}
            </div>
          )
        })}
      </div>

      {horse.quote && (
        <div className="furi-section">
          <div className="furi-sec-label">レース後コメント（原文）</div>
          <div className="furi-quote">
            <div className="furi-q-who">— {horse.quote.who}</div>
            <div className="furi-q-text">「{horse.quote.full}」</div>
          </div>
        </div>
      )}

      <div className="furi-section">
        <div className="furi-sec-label">ファンはどう見たか</div>
        <div className="furi-judge" style={{ borderColor: L.fg }}>
          <div className="furi-judge-label" style={{ color: L.fg }}>
            {horse.lean === 'win' ? '🏆 勝ち方の判定' : '⚔ 負け方の判定'}
          </div>
          <div className="furi-judge-text">{horse.judge}</div>
        </div>
      </div>

      <div className="furi-actions">
        <button className="btn-sm" onClick={handleImage}>🖼 画像保存</button>
        <button className="btn-sm" onClick={handleTweet}>𝕏 ツイート文コピー</button>
      </div>

      {imgDataUrl && (
        <div className="furi-img-modal" onClick={() => setImgDataUrl(null)}>
          <div className="furi-img-modal-inner" onClick={e => e.stopPropagation()}>
            <p style={{ fontSize: '12px', color: 'var(--ink-soft)', marginBottom: '8px' }}>長押しして「写真に保存」</p>
            <img src={imgDataUrl} alt={horse.name} style={{ width: '100%', borderRadius: 4 }} />
            <button className="btn-sm" onClick={() => setImgDataUrl(null)} style={{ marginTop: '12px' }}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  )
}
