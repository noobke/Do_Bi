import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { TopBar } from '../components/Layout'
import { Loading } from '../components/Loading'
import { classNames, toast } from '../lib/ui'
import { getCharacter, listCharacters, setCharacterState } from '../api/client'
import { useProject } from '../state/project'

/**
 * 角色与关系 —— 左列角色列表，右侧角色档案 + 关系 + 相关伏笔。
 *
 * 数据源：`GET /characters`（列表 + 统计 + 分类）与 `GET /characters/{key}`（单个角色 + 相关伏笔）。
 * 关系里的 `target` 是角色 id，用同一份列表数据映射成姓名并做双向跳转。
 * 不可变特征只读展示——后端也不允许改，界面上写明原因。
 * 类名取自 `styles/contract.css`（批次一 / 十二）。
 */

interface Relation {
  target: string
  type: string
  note: string
}

interface CharState {
  location: string
  status: string
  knownSecrets: string[]
}

interface Character {
  id: string
  name: string
  role: string
  lead: boolean
  immutableTraits: string[]
  personality: string
  speechStyle: string
  relationships: Relation[]
  state: CharState
  firstAppearance: number
  updatedAtChapter: number
  aliases: string[]
  deceased: boolean
}

interface HookLite {
  id: string
  content: string
  status: string
  plantedChapter: number
  importance: string
}

interface CharList {
  characters: Character[]
  roles: string[]
  stats: { total: number; lead: number; deceased: number; traits: number }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试')

/** 非原生控件（div）的键盘可达包装 */
function press(handler: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        handler()
      }
    },
  }
}

/** 已知秘密：逗号（中英文）或换行分隔 */
function splitSecrets(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export default function Characters() {
  const { projectId } = useProject()

  const [list, setList] = useState<CharList | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [listErr, setListErr] = useState('')
  const [roleFilter, setRoleFilter] = useState('全部')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [character, setCharacter] = useState<Character | null>(null)
  const [hooks, setHooks] = useState<HookLite[]>([])
  const [detailStatus, setDetailStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [detailErr, setDetailErr] = useState('')

  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState({ location: '', status: '', secrets: '' })
  const [busy, setBusy] = useState(false)

  const loadList = useCallback(async () => {
    if (!projectId) return
    setListStatus('loading')
    try {
      const data = (await listCharacters(projectId)) as CharList
      setList(data)
      setListStatus('ready')
      setSelectedId((prev) => {
        const chars = data.characters ?? []
        if (prev && chars.some((c) => c.id === prev)) return prev
        return chars.length ? chars[0].id : null
      })
    } catch (e) {
      setListErr(errMsg(e))
      setListStatus('error')
    }
  }, [projectId])

  const loadDetail = useCallback(
    async (id: string) => {
      if (!projectId) return
      setDetailStatus('loading')
      try {
        const raw = (await getCharacter(projectId, id)) as
          | (Character & { hooks?: HookLite[] })
          | { character?: Character; hooks?: HookLite[] }
        const char = (raw as { character?: Character }).character ?? (raw as Character)
        const hs = (raw as { hooks?: HookLite[] }).hooks ?? []
        setCharacter(char)
        setHooks(hs)
        setDetailStatus('ready')
      } catch (e) {
        setDetailErr(errMsg(e))
        setDetailStatus('error')
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) {
      setList(null)
      setListStatus('ready')
      return
    }
    setList(null)
    setSelectedId(null)
    void loadList()
  }, [projectId, loadList])

  useEffect(() => {
    if (projectId && selectedId) void loadDetail(selectedId)
  }, [projectId, selectedId, loadDetail])

  const nameOf = useCallback(
    (id: string) => list?.characters.find((c) => c.id === id)?.name ?? id,
    [list],
  )

  const visibleChars = useMemo(() => {
    const chars = list?.characters ?? []
    return roleFilter === '全部' ? chars : chars.filter((c) => c.role === roleFilter)
  }, [list, roleFilter])

  const openEdit = useCallback(() => {
    if (!character) return
    setForm({
      location: character.state?.location ?? '',
      status: character.state?.status ?? '',
      secrets: (character.state?.knownSecrets ?? []).join('，'),
    })
    setEditOpen(true)
  }, [character])

  const submitEdit = useCallback(async () => {
    if (!projectId || !character) return
    setBusy(true)
    try {
      const res = (await setCharacterState(projectId, character.id, {
        location: form.location,
        status: form.status,
        knownSecrets: splitSecrets(form.secrets),
      })) as { ok: boolean; character: Character }
      const updated = res.character ?? character
      setCharacter(updated)
      setList((prev) =>
        prev
          ? { ...prev, characters: prev.characters.map((c) => (c.id === updated.id ? updated : c)) }
          : prev,
      )
      toast('角色状态已更新', 'ok')
      setEditOpen(false)
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }, [projectId, character, form])

  /* ---------- 三态 ---------- */

  if (!projectId) {
    return (
      <>
        <TopBar title="角色与关系" sub="角色卡与关系管理" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="library" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13 muted">先到「项目」里选择或新建一部作品，再回来管理角色。</div>
              <Link className="btn btn-ghost btn-sm" to="/">
                前往项目列表
              </Link>
            </div>
          </div>
        </section>
      </>
    )
  }

  if (listStatus === 'loading') {
    return (
      <>
        <TopBar title="角色与关系" sub="角色卡与关系管理" />
        <Loading text="正在载入角色…" />
      </>
    )
  }

  if (listStatus === 'error') {
    return (
      <>
        <TopBar title="角色与关系" sub="角色卡与关系管理" />
        <ErrorState message={listErr} onRetry={() => void loadList()} />
      </>
    )
  }

  const stats = list?.stats
  const roles = list?.roles ?? ['全部']

  if (!list || list.characters.length === 0) {
    return (
      <>
        <TopBar title="角色与关系" sub="角色卡与关系管理" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="users" size={24} />
              <div className="fs-16 serif">还没有角色</div>
              <div className="fs-13 muted">先到「共创」聊几句，或到「结构」点「生成世界观与大纲」，角色会随立项一起长出来。</div>
              <div className="row">
                <Link className="btn btn-ghost btn-sm" to="/chat">去共创</Link>
                <Link className="btn btn-primary btn-sm" to="/outline">去结构</Link>
              </div>
            </div>
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      <TopBar
        title="角色与关系"
        sub={
          stats
            ? `${stats.total} 位角色 · ${stats.lead} 位主角 · ${stats.deceased} 位已故 · ${stats.traits} 条不可变特征`
            : '角色卡与关系管理'
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: '340px minmax(0,1fr)', gap: 'var(--sp-24)', alignItems: 'start' }}>
        {/* 左列 · 角色列表 */}
        <section className="card">
          <div className="card-head">
            <h2>角色</h2>
            <span className="tag tag-quiet">{stats?.total ?? 0}</span>
          </div>
          <div className="card-body">
            <div className="grid-2">
              <div className="stat">
                <div className="stat-label">总数</div>
                <div className="stat-value">{stats?.total ?? 0}</div>
              </div>
              <div className="stat">
                <div className="stat-label">主角</div>
                <div className="stat-value">{stats?.lead ?? 0}</div>
              </div>
              <div className="stat">
                <div className="stat-label">已故</div>
                <div className="stat-value">{stats?.deceased ?? 0}</div>
              </div>
              <div className="stat">
                <div className="stat-label">特征数</div>
                <div className="stat-value">{stats?.traits ?? 0}</div>
              </div>
            </div>
            <div className="seg" role="group" aria-label="按身份筛选" style={{ marginTop: 16 }}>
              {roles.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={r === roleFilter ? 'active' : undefined}
                  aria-pressed={r === roleFilter}
                  onClick={() => setRoleFilter(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="list">
              {visibleChars.length ? (
                visibleChars.map((c) => (
                  <div
                    key={c.id}
                    className={classNames('list-row', c.id === selectedId && 'is-active')}
                    {...press(() => setSelectedId(c.id))}
                  >
                    <div className="char-item" style={{ flex: 1, minWidth: 0 }}>
                      <div className={classNames('char-avatar', c.lead && 'is-lead')}>{c.name.charAt(0)}</div>
                      <div className="row-main">
                        <div className="row-title">
                          {c.name}
                          {c.deceased ? <span className="tag tag-danger" style={{ marginLeft: 8 }}>已故</span> : null}
                        </div>
                        <div className="row-sub">{`${c.role} · ${c.state?.location || '—'}`}</div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">
                  <span className="fs-12">该身份下暂无角色</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 右列 · 角色详情 */}
        <div className="stack-24">
          {detailStatus === 'loading' ? (
            <Loading text="正在载入角色档案…" />
          ) : detailStatus === 'error' ? (
            <ErrorState message={detailErr} onRetry={() => selectedId && void loadDetail(selectedId)} />
          ) : character ? (
            <>
              <section className="card">
                <div className="card-head">
                  <h2>角色档案</h2>
                  <span className="tag tag-quiet mono">{character.id}</span>
                </div>
                <div className="card-body stack">
                  <div>
                    <div className="grid-2">
                      <div className="stat">
                        <div className="stat-label">身份</div>
                        <div className="stat-value fs-16">{character.role}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">首次登场</div>
                        <div className="stat-value fs-16">{`第 ${character.firstAppearance} 章`}</div>
                      </div>
                    </div>
                    <div className="wrap-row" style={{ marginTop: 12 }}>
                      {character.lead ? <span className="tag tag-info">主角</span> : null}
                      <span className="chip">{character.state?.location || '—'}</span>
                      <span className="chip">{character.state?.status || '—'}</span>
                      {character.deceased ? <span className="tag tag-danger">已故</span> : null}
                      {character.aliases.map((a) => (
                        <span key={a} className="chip">{a}</span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="row-between">
                      <span className="fs-13" style={{ fontWeight: 500 }}>不可变特征</span>
                      <span className="tag tag-quiet">不可改</span>
                    </div>
                    {character.immutableTraits.length ? (
                      <div className="trait-list" style={{ marginTop: 12 }}>
                        {character.immutableTraits.map((t, i) => (
                          <div key={i} className="trait">
                            <i />
                            <span>{t}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="fs-12 muted" style={{ marginTop: 8 }}>尚未设定不可变特征</div>
                    )}
                    <div className="fs-12 muted" style={{ marginTop: 8 }}>
                      不可变特征一旦改动会让前文全线失效，需要重写已定稿章节，因此这里不开放编辑。
                    </div>
                  </div>

                  <div className="grid-2">
                    <div className="card card-pad">
                      <div className="fs-12 muted">性格</div>
                      <div className="fs-14">{character.personality || '—'}</div>
                    </div>
                    <div className="card card-pad">
                      <div className="fs-12 muted">说话方式</div>
                      <div className="fs-14">{character.speechStyle || '—'}</div>
                    </div>
                  </div>

                  <div>
                    <div className="fs-13">{`当前状态：${character.state?.status || '—'}`}</div>
                    <div className="fs-12 muted">{`更新于第 ${character.updatedAtChapter || character.firstAppearance} 章`}</div>
                  </div>

                  {(character.state?.knownSecrets ?? []).length ? (
                    <div>
                      <div className="fs-12 muted" style={{ marginBottom: 8 }}>已知秘密</div>
                      <div className="wrap-row">
                        {character.state.knownSecrets.map((s) => (
                          <span key={s} className="chip">{s}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={openEdit}>
                      修改状态
                    </button>
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>关系</h2>
                  <span className="tag tag-quiet">{`${character.relationships.length} 条`}</span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {character.relationships.length ? (
                    <div className="list">
                      {character.relationships.map((r, i) => {
                        const known = list.characters.some((c) => c.id === r.target)
                        return (
                          <div
                            key={`${r.target}-${i}`}
                            className="list-row"
                            {...(known ? press(() => setSelectedId(r.target)) : {})}
                          >
                            <div className="rel-row">
                              <span className="rel-arrow">→</span>
                              <span className="chip">{r.type}</span>
                            </div>
                            <div className="row-main">
                              <div className="row-title">{r.note || '（暂无说明）'}</div>
                              <div className="row-sub">{nameOf(r.target)}</div>
                            </div>
                            {known ? <Icon name="chevron-right" size={16} /> : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="empty">
                      <span className="fs-12">暂无关系记录</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>相关伏笔</h2>
                  <span className="tag tag-quiet">{`${hooks.length} 条`}</span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {hooks.length ? (
                    <div className="list">
                      {hooks.map((h) => (
                        <div key={h.id} className="list-row">
                          <span className="mono fs-12 muted">{h.id}</span>
                          <div className="row-main">
                            <div className="row-title">{h.content}</div>
                            <div className="row-sub">
                              {`埋于第 ${h.plantedChapter} 章 · ${
                                h.status === 'resolved' ? '已回收' : h.status === 'abandoned' ? '已弃用' : '待回收'
                              }`}
                            </div>
                          </div>
                          <Link className="btn btn-quiet btn-sm" to="/hooks">去伏笔看板</Link>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty">
                      <span className="fs-12">该角色暂无关联伏笔</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>写作约束提示</h2>
                </div>
                <div className="card-body stack-8">
                  <p className="fs-13 muted">
                    不可变特征会被规则校验逐章检查，一旦被违背即阻塞定稿。
                  </p>
                  <p className="fs-13 muted" title="模型审查 · 对照性格与说话方式逐章核对">
                    AI 会逐章检查角色是否符合既定性格与说话方式，偏离人设时会标出来。
                  </p>
                  <p className="fs-13 muted">
                    修改角色状态会先给出提案，经你确认后才会写进设定；改动不可变特征本就不开放。
                  </p>
                </div>
              </section>
            </>
          ) : (
            <div className="empty">
              <span className="fs-13">请从左侧选择一位角色</span>
            </div>
          )}
        </div>
      </div>

      {editOpen && character ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setEditOpen(false)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>{`修改「${character.name}」的当前状态`}</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditOpen(false)}>
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <div className="grid-2">
                <div className="field">
                  <label className="field-label" htmlFor="char-location">位置</label>
                  <input
                    id="char-location"
                    className="input"
                    value={form.location}
                    onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="char-status">状态</label>
                  <input
                    id="char-status"
                    className="input"
                    value={form.status}
                    onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                  />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="char-secrets">已知秘密</label>
                <textarea
                  id="char-secrets"
                  className="textarea"
                  placeholder="用逗号或换行分隔"
                  value={form.secrets}
                  onChange={(e) => setForm((f) => ({ ...f, secrets: e.target.value }))}
                />
                <div className="field-hint">只改「位置 / 状态 / 已知秘密」这类可变信息；不可变特征不在此处。</div>
              </div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">状态改动会先给出提案，确认后写入设定</span>
              <div className="row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submitEdit()}>
                  {busy ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
