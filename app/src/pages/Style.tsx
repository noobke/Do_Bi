import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, fmtInt, toast } from '../lib/ui'
import { useProject } from '../state/project'
import { addBanned, analyzeStyle, applyStyle, getStyle, removeBanned } from '../api/client'

/**
 * 文风档案 —— 对接 `GET /api/projects/{id}/style`。
 *
 * 双入口：从样本/本书「提取文风」，或从预设「选择文风」。当前档案展示句式区间、
 * 视角、描写比例、偏好手法与禁用表达，下方给出「未按文风写 / 按文风写」对比。
 */

interface Sentence {
  mean: number
  p50: number
  p90: number
  min: number
  max: number
  scale: number
}

interface Narrative {
  person: string
  tense: string
  povSwitch: string
  anchor: string
}

interface RatioItem {
  label: string
  pct: number
  color: string
}

interface StyleProfile {
  source: string
  analyzedAt: string
  tokens: number
  sentence: Sentence
  narrative: Narrative
  ratio: RatioItem[]
  preferredPatterns: string[]
  bannedExpressions: string[]
  lexicon: { key: string; value: string }[]
  samplePlain: string
  sampleStyled: string
}

interface Preset {
  id: string
  name: string
  tagline: string
  sample: string
  category: string
}

interface Source {
  id: string
  kind: string
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
}

interface StylePayload {
  profile: StyleProfile
  presets: Preset[]
  sources: Source[]
}

/** 视角切换频率 → 人话；原值收进 title */
const POV_LABEL: Record<string, string> = {
  rare: '很少切换',
  sometimes: '偶尔切换',
  often: '经常切换',
  none: '不切换',
}

const fallbackColor = (i: number) =>
  ['#2C4A63', '#4F6B4A', '#8A5C12', '#A6392E', '#6B6455'][i % 5]

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

export default function Style() {
  const { projectId } = useProject()
  const selectorRef = useRef<HTMLElement | null>(null)

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [profile, setProfile] = useState<StyleProfile | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [category, setCategory] = useState('全部')
  const [busy, setBusy] = useState<string | null>(null)
  const [bannedInput, setBannedInput] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [sample, setSample] = useState('')
  const [extracting, setExtracting] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setStatus('loading')
    try {
      const res = (await getStyle(projectId)) as StylePayload
      setProfile(res.profile)
      setPresets(res.presets ?? [])
      setSources(res.sources ?? [])
      setStatus('ready')
    } catch (e) {
      setError(errMsg(e))
      setStatus('error')
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) {
      setStatus('ready')
      return
    }
    void load()
  }, [projectId, load])

  const categories = useMemo(() => {
    const seen: string[] = []
    for (const p of presets) if (p.category && !seen.includes(p.category)) seen.push(p.category)
    return ['全部', ...seen]
  }, [presets])

  const shownPresets = presets.filter((p) => category === '全部' || p.category === category)
  const banned = profile?.bannedExpressions ?? []
  const s = profile?.sentence
  const scale = s?.scale && s.scale > 0 ? s.scale : 80
  const p50Pct = s ? (s.p50 / scale) * 100 : 0
  const p90Pct = s ? (s.p90 / scale) * 100 : 0
  const meanPct = s ? (s.mean / scale) * 100 : 0
  const appliedId = useMemo(() => {
    const src = profile?.source ?? ''
    const hit = presets.find((p) => src.includes(p.name))
    return hit?.id ?? null
  }, [profile, presets])
  const povRaw = profile?.narrative.povSwitch ?? ''
  const povText = povRaw ? (POV_LABEL[povRaw] ?? povRaw) : '未判定'
  /** 是否有可导出的文风档案：profile 与来源名都存在才算有内容 */
  const hasExportable = !!(profile && profile.source)

  /**
   * 导出当前文风：把档案里真实存在的数据字段整理成一份作者可读的存档文件，
   * 用浏览器下载（Blob + 隐藏链接），不走后端接口。
   */
  const exportProfile = useCallback(() => {
    if (!profile || !profile.source) {
      toast('还没有可导出的文风档案', 'warn')
      return
    }
    // 只取真实存在的数据字段，不伪造任何字段；name 取当前文风名作为日后导入的标识
    const doc = {
      type: '文风档案',
      name: profile.source,
      source: profile.source,
      analyzedAt: profile.analyzedAt,
      tokens: profile.tokens,
      sentence: profile.sentence,
      narrative: profile.narrative,
      ratio: profile.ratio,
      preferredPatterns: profile.preferredPatterns,
      bannedExpressions: profile.bannedExpressions,
      lexicon: profile.lexicon,
      samplePlain: profile.samplePlain,
      sampleStyled: profile.sampleStyled,
    }
    const filename =
      `${profile.source.replace(/[\\/:*?"<>|]/g, '_')}文风档案.json`
    const blob = new Blob([JSON.stringify(doc, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast(`已导出文风档案「${profile.source}」，可保存备用`, 'ok')
  }, [profile])

  const gotoSelector = useCallback(() => {
    selectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const openExtract = useCallback(() => {
    const init: Record<string, boolean> = {}
    for (const src of sources) init[src.id] = src.checked
    setPicked(init)
    setModalOpen(true)
  }, [sources])

  const submitExtract = useCallback(async () => {
    const id = projectId
    if (!id) return
    const ids = sources.filter((src) => !src.disabled && picked[src.id]).map((src) => src.id)
    const text = sample.trim()
    if (ids.length === 0 && !text) {
      toast('请先选择来源或粘贴样本', 'warn')
      return
    }
    setExtracting(true)
    try {
      const res = (await analyzeStyle(id, {
        sourceIds: ids,
        sample: text,
        merge: ids.includes('src_merge'),
      })) as { profile: StyleProfile; sources: Source[]; tokens: number }
      setProfile(res.profile)
      setSources(res.sources ?? sources)
      setModalOpen(false)
      setSample('')
      toast(`文风已更新，这次分析消耗 ${fmtInt(res.tokens ?? 0)} 额度`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setExtracting(false)
    }
  }, [projectId, sources, picked, sample])

  const apply = useCallback(
    async (preset: Preset) => {
      const id = projectId
      if (!id) return
      setBusy(preset.id)
      try {
        const res = (await applyStyle(id, preset.id)) as { profile: StyleProfile; presets: Preset[] }
        setProfile(res.profile)
        setPresets(res.presets ?? presets)
        toast(`已应用文风：${preset.name}`, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy(null)
      }
    },
    [projectId, presets],
  )

  const remove = useCallback(
    async (expr: string) => {
      const id = projectId
      if (!id) return
      try {
        const res = (await removeBanned(id, expr)) as { banned: string[] }
        setProfile((prev) => (prev ? { ...prev, bannedExpressions: res.banned ?? [] } : prev))
        toast(`已移除：${expr}`, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      }
    },
    [projectId],
  )

  const add = useCallback(async () => {
    const id = projectId
    const v = bannedInput.trim()
    if (!id || !v) return
    try {
      const res = (await addBanned(id, v)) as { banned: string[] }
      setProfile((prev) => (prev ? { ...prev, bannedExpressions: res.banned ?? [] } : prev))
      setBannedInput('')
      toast(`已新增禁用表达：${v}`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }, [projectId, bannedInput])

  const topActions = (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={openExtract}>
        提取文风
      </button>
      <button type="button" className="btn btn-primary btn-sm" onClick={gotoSelector}>
        选择文风
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void exportProfile()}
        disabled={!hasExportable}
        title={
          hasExportable
            ? '将当前文风整理成一份可留存的档案，含分析来源、句式、视角、比例、偏好手法与禁用表达'
            : '还没有可导出的文风档案'
        }
      >
        导出文风档案
      </button>
    </>
  )

  const sub =
    profile && profile.source
      ? `当前文风：${profile.source} · 每次生成都会带上这份文风`
      : '还没有文风档案 · 提取或选择一份后，每次生成都会自动带上它'

  return (
    <>
      <TopBar title="文风档案" sub={sub} actions={topActions} />

      {!projectId ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="type" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13">先选一个作品，再回来看它的文风档案</div>
              <Link className="btn btn-primary btn-sm" to="/">
                去我的作品
              </Link>
            </div>
          </div>
        </section>
      ) : status === 'loading' ? (
        <Loading text="正在加载文风档案…" />
      ) : status === 'error' ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <div className="stack-24">
          {/* 当前文风 */}
          <section className="card">
            <div className="card-head">
              <h2>当前文风</h2>
              {profile && profile.source ? (
                <span className="tag tag-ok">已应用</span>
              ) : (
                <span className="tag tag-quiet">未应用</span>
              )}
            </div>
            {!profile || !profile.source ? (
              <div className="card-body">
                <div className="empty">
                  <Icon name="type" size={24} />
                  <div className="fs-16 serif">还没有文风档案</div>
                  <div className="fs-13">从样本或本书提取，或直接选一份预设</div>
                  <div className="row">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={openExtract}>
                      提取文风
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={gotoSelector}>
                      选择文风
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="card-body stack-24">
                <div className="row-between fs-13">
                  <span className="muted">分析来源</span>
                  <span className="mono fs-12">{profile.source}</span>
                </div>
                <div className="row-between fs-13">
                  <span className="muted">分析时间</span>
                  <span className="mono fs-12">{profile.analyzedAt || '—'}</span>
                </div>
                <div className="row-between fs-13">
                  <span className="muted">分析消耗</span>
                  <span className="mono fs-12">{fmtInt(profile.tokens ?? 0)} 额度</span>
                </div>

                <div className="grid-3">
                  {/* 句式 */}
                  <div className="stack-8">
                    <div className="fs-14 serif">句式特征</div>
                    <div className="fs-12 muted" title="p50 / p90 句长刻度">
                      句长区间（{fmtInt(Math.round(scale))} 字为满格）
                    </div>
                    <div className="rangebar" title={`p50 ${s?.p50 ?? 0} 字 · p90 ${s?.p90 ?? 0} 字`}>
                      <i style={{ left: `${p50Pct}%`, width: `${Math.max(0, p90Pct - p50Pct)}%` }} />
                      <b style={{ left: `${meanPct}%` }} />
                    </div>
                    <div className="row-between fs-12 muted">
                      <span>偏短</span>
                      <span>中等</span>
                      <span>偏长</span>
                    </div>
                    <div className="fs-12 muted">
                      一半句子短于 {s?.p50 ?? 0} 字 · 九成句子短于 {s?.p90 ?? 0} 字 · 平均{' '}
                      {s?.mean ?? 0} 字
                    </div>
                    <div className="fs-12 muted">
                      最短 {s?.min ?? 0} 字 · 最长 {s?.max ?? 0} 字
                    </div>
                  </div>

                  {/* 视角与词法 */}
                  <div className="stack-8">
                    <div className="fs-14 serif">叙述视角与词法</div>
                    <div className="wrap-row">
                      <span className="chip">{profile.narrative.person || '未判定'}</span>
                      <span className="chip">{profile.narrative.tense || '未判定'}</span>
                      <span className="chip" title={`pov：${profile.narrative.povSwitch}`}>
                        视角切换：{povText}
                      </span>
                    </div>
                    {profile.narrative.anchor ? (
                      <div className="fs-12 muted">锚点人物：{profile.narrative.anchor}</div>
                    ) : null}
                    {profile.lexicon.length > 0 ? (
                      <div className="kv">
                        {profile.lexicon.map((row, i) => (
                          <div className="kv-row" key={`${row.key}-${i}`}>
                            <span className="kv-key">{row.key}</span>
                            <span className="kv-val">{row.value}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="fs-12 muted">暂无词法记录</div>
                    )}
                  </div>

                  {/* 比例 */}
                  <div className="stack-8">
                    <div className="fs-14 serif">描写 · 对话 · 动作 比例</div>
                    {profile.ratio.length > 0 ? (
                      <>
                        <div className="stackbar">
                          {profile.ratio.map((r, i) => (
                            <i
                              key={`${r.label}-${i}`}
                              style={{ width: `${r.pct}%`, background: r.color || fallbackColor(i) }}
                            />
                          ))}
                        </div>
                        <div className="stackbar-legend">
                          {profile.ratio.map((r, i) => (
                            <span className="legend-item" key={`${r.label}-${i}`}>
                              <span
                                className="legend-swatch is-node"
                                style={{ background: r.color || fallbackColor(i), border: 'none' }}
                              />
                              <span>
                                {r.label} {r.pct}%
                              </span>
                            </span>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="fs-12 muted">样本过短，未判定比例</div>
                    )}
                  </div>
                </div>

                <div className="grid-2">
                  {/* 偏好手法 */}
                  <div className="stack-8">
                    <div className="fs-14 serif">偏好手法</div>
                    {profile.preferredPatterns.length > 0 ? (
                      <div className="trait-list">
                        {profile.preferredPatterns.map((t, i) => (
                          <div className="trait" key={`${t}-${i}`}>
                            <i />
                            <span>{t}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="fs-12 muted">暂无偏好手法记录</div>
                    )}
                  </div>

                  {/* 禁用表达 */}
                  <div className="stack-8">
                    <div className="row-between">
                      <div className="fs-14 serif">禁用表达</div>
                      <span className="tag tag-quiet">{banned.length} 条</span>
                    </div>
                    <div className="fs-12 muted" title="L1 第 4 条「禁用句式命中」· spot-fix 定点改写">
                      命中后只定点改写有问题的句子，不整段重写
                    </div>
                    {banned.length > 0 ? (
                      <div className="wrap-row">
                        {banned.map((expr) => (
                          <span className="chip-removable" key={expr}>
                            <span>{expr}</span>
                            <button
                              type="button"
                              className="chip-x"
                              aria-label={`移除 ${expr}`}
                              onClick={() => void remove(expr)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="fs-12 muted">还没有禁用表达</div>
                    )}
                    <div className="row">
                      <input
                        className="input"
                        style={{ maxWidth: 320 }}
                        placeholder="新增一条禁用表达"
                        aria-label="新增禁用表达"
                        value={bannedInput}
                        onChange={(e) => setBannedInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void add()
                        }}
                      />
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void add()}>
                        添加
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 注入对比 */}
          {profile && profile.source && (profile.samplePlain || profile.sampleStyled) ? (
            <section className="card">
              <div className="card-head">
                <h2>注入对比</h2>
                <span className="tag tag-info">必选 · 不占配额</span>
              </div>
              <div className="card-body stack">
                <div className="fs-13 muted">
                  每次生成都会带上这份文风；因体量小，不占用检索配额，也不参与相关性竞争
                </div>
                <div className="grid-2">
                  <div className="stack-8">
                    <div className="fs-12 muted">未按文风写</div>
                    <div className="ms-text">{profile.samplePlain || '—'}</div>
                  </div>
                  <div className="stack-8">
                    <div className="fs-12 muted">按文风写</div>
                    <div className="ms-text">{profile.sampleStyled || '—'}</div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {/* 选择文风 */}
          <section className="card" ref={selectorRef}>
            <div className="card-head">
              <h2>选择文风</h2>
              <div className="seg">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={category === c ? 'active' : undefined}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="card-body">
              <div className="fs-12 muted" style={{ marginBottom: 16 }}>
                样段是选择文风最可靠的依据——设置文案会骗人，输出不会。
              </div>
              <div className="style-grid">
                {shownPresets.map((p) => {
                  const isApplied = p.id === appliedId
                  return (
                    <div
                      className={classNames('style-card', isApplied && 'is-applied')}
                      key={p.id}
                    >
                      <div className="style-card-head">
                        <div>
                          <div className="style-name">{p.name}</div>
                          <div className="style-tagline">{p.tagline}</div>
                        </div>
                        <span className="tag tag-quiet">{p.category}</span>
                      </div>
                      <div className="style-sample">{p.sample}</div>
                      <div className="style-foot">
                        <span className="fs-12 muted">样段节选</span>
                        {isApplied ? (
                          <button type="button" className="btn btn-ghost btn-sm" disabled>
                            当前使用中
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => void apply(p)}
                            disabled={busy !== null}
                          >
                            {busy === p.id ? '应用中…' : '应用'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 提取文风 */}
      {modalOpen ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => (extracting ? undefined : setModalOpen(false))} />
          <div className="modal-card">
            <div className="card-head">
              <h2>提取文风</h2>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => setModalOpen(false)}
                disabled={extracting}
              >
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <p className="fs-13 muted">
                提取会读样本的行文特征（句长分布、叙述视角、描写与对话比例、高频句式、套语），
                生成一份文风档案，作为每次生成的必选上下文。
              </p>
              <div className="fs-13">选择提取来源</div>
              <div className="src-list">
                {sources.map((src) => (
                  <label
                    className="src-row"
                    key={src.id}
                    style={src.disabled ? { opacity: 0.55 } : undefined}
                  >
                    <input
                      type="checkbox"
                      disabled={src.disabled}
                      checked={!!picked[src.id]}
                      onChange={(e) =>
                        setPicked((prev) => ({ ...prev, [src.id]: e.target.checked }))
                      }
                    />
                    <div className="src-main">
                      <div className="row-title">{src.label}</div>
                      <div className="row-sub">{src.hint}</div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="field">
                <label className="field-label" htmlFor="src-paste">
                  或直接粘贴样本
                </label>
                <textarea
                  id="src-paste"
                  className="textarea"
                  placeholder="粘贴 8000 字以上同风格文本，效果更稳。留空则只用上面勾选的来源。"
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                />
                <span className="field-hint">样本越纯净（单一作者、同一文体），提取结果越可用。</span>
              </div>
            </div>
            <div className="card-foot row" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setModalOpen(false)}
                disabled={extracting}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void submitExtract()}
                disabled={extracting}
              >
                {extracting ? '提取中…' : '开始提取'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
