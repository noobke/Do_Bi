import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, toast } from '../lib/ui'
import { useProject } from '../state/project'
import { getChat, runPlan, sendChat } from '../api/client'

/**
 * 共创对话 —— Chat-first 立项：边聊边沉淀设定。
 * 数据来自 `GET/POST /api/projects/{id}/chat`，设定沉淀取自返回的 `seed`。
 */

interface Seed {
  genre: string
  premise: string
  protagonist: string
  coreConflict: string
  tone: string
  readyForPlan: boolean
  updatedAt: string
}

interface Msg {
  role: 'me' | 'ai'
  text: string
  title?: string
  options?: string[]
}

interface ChatResponse {
  reply: string
  options: string[]
  ready: boolean
  seed: Seed
}

/** AI 消息的标题（接口未提供标题字段，用固定署名，不写死任何指标） */
const AI_TITLE = '共创助手'

const SEED_FIELDS: { key: keyof Seed; label: string }[] = [
  { key: 'genre', label: '题材' },
  { key: 'premise', label: '前提' },
  { key: 'protagonist', label: '主角' },
  { key: 'coreConflict', label: '核心冲突' },
  { key: 'tone', label: '基调' },
]

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

export default function Chat() {
  const { projectId } = useProject()
  const navigate = useNavigate()

  const [seed, setSeed] = useState<Seed | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [ready, setReady] = useState(false)
  const [planning, setPlanning] = useState(false)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!projectId) {
      setStatus('ready')
      return
    }
    setStatus('loading')
    try {
      const res = (await getChat(projectId)) as {
        seed: Seed
        messages: { role: 'me' | 'ai'; text: string }[]
      }
      setSeed(res.seed ?? null)
      setReady(Boolean(res.seed?.readyForPlan))
      setMessages(
        (res.messages ?? []).map((m) => ({
          role: m.role,
          text: m.text,
          title: m.role === 'ai' ? AI_TITLE : undefined,
        })),
      )
      setStatus('ready')
    } catch (e) {
      setError(errMsg(e))
      setStatus('error')
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages, sending])

  const doSend = useCallback(
    async (text: string) => {
      if (!projectId) return
      const val = text.trim()
      if (!val) {
        toast('先写点什么再发送', 'warn')
        return
      }
      if (sending) return
      setMessages((m) => [...m, { role: 'me', text: val }])
      setInput('')
      setSending(true)
      try {
        const res = (await sendChat(projectId, val)) as ChatResponse
        setSeed(res.seed ?? null)
        setReady(Boolean(res.ready))
        setMessages((m) => [
          ...m,
          { role: 'ai', text: res.reply, title: AI_TITLE, options: res.options },
        ])
      } catch (e) {
        /* 失败不发丢：撤回刚入列的用户消息，并把内容还给输入框 */
        setMessages((m) => m.slice(0, -1))
        setInput(val)
        toast(errMsg(e), 'error')
      } finally {
        setSending(false)
      }
    },
    [projectId, sending],
  )

  const choose = useCallback(
    (opt: string) => {
      if (opt.includes('自己')) {
        inputRef.current?.focus()
        return
      }
      void doSend(opt)
    },
    [doSend],
  )

  const genPlan = useCallback(async () => {
    if (!projectId) return
    setPlanning(true)
    try {
      await runPlan(projectId)
      toast('设定已生成', 'ok')
      navigate('/outline')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setPlanning(false)
    }
  }, [projectId, navigate])

  const settled = seed
    ? SEED_FIELDS.filter((f) => seed[f.key] && seed[f.key] !== '（尚未确立）').length
    : 0
  const sub = seed
    ? `已沉淀 ${settled} 条设定${ready ? ' · 可以生成世界观与大纲了' : ''}`
    : undefined

  return (
    <>
      <TopBar title="共创对话" sub={sub} />

      {!projectId ? (
        <div className="empty">
          <Icon name="messages-square" size={24} />
          <div className="fs-16 serif">还没有选择作品</div>
          <div className="fs-13">先到「我的作品」打开一部作品，再回来共创</div>
          <Link className="btn btn-ghost btn-sm" to="/">
            去我的作品
          </Link>
        </div>
      ) : status === 'loading' ? (
        <Loading text="正在载入对话…" />
      ) : status === 'error' ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <div className="chat">
          <section className="card">
            <div className="card-head">
              <h2>与 AI 共创</h2>
              <span className="tag tag-info">边聊边立项</span>
            </div>
            <div className="card-body">
              <div className="chat-stream">
                {messages.length === 0 ? (
                  <div className="empty">
                    <Icon name="messages-square" size={24} />
                    <div className="fs-16 serif">从一句话灵感开始</div>
                    <div className="fs-13">说出你的想法，AI 会一次只追问一个问题</div>
                  </div>
                ) : (
                  messages.map((m, i) => {
                    const isLast = i === messages.length - 1
                    return (
                      <div
                        key={i}
                        className={classNames('msg', m.role === 'me' && 'msg-user')}
                      >
                        <div
                          className={classNames('avatar', m.role === 'me' ? 'avatar-me' : 'avatar-ai')}
                        >
                          {m.role === 'me' ? '我' : 'AI'}
                        </div>
                        <div className="bubble">
                          {m.role === 'ai' && m.title ? (
                            <div className="bubble-title">{m.title}</div>
                          ) : null}
                          <div>{m.text}</div>
                          {m.role === 'ai' && m.options && m.options.length ? (
                            <div className="opt-row">
                              {m.options.map((o) => (
                                <button
                                  key={o}
                                  type="button"
                                  className="opt"
                                  onClick={() => choose(o)}
                                  disabled={sending}
                                >
                                  {o}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {m.role === 'ai' && isLast && ready ? (
                            <div className="opt-row">
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => void genPlan()}
                                disabled={planning}
                              >
                                {planning ? '生成中…' : '生成世界观与大纲'}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })
                )}
                {sending ? (
                  <div className="msg">
                    <div className="avatar avatar-ai">AI</div>
                    <div className="bubble">
                      <span className="fs-13 muted">正在梳理你的想法…</span>
                    </div>
                  </div>
                ) : null}
                <div ref={endRef} />
              </div>

              <div className="compose">
                <textarea
                  ref={inputRef}
                  className="textarea"
                  placeholder="说出你的想法，AI 会一次只追问一个问题…"
                  value={input}
                  disabled={sending}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void doSend(input)
                    }
                  }}
                />
                <div className="compose-row">
                  <span className="fs-12 muted">按 Enter 发送 · Shift+Enter 换行</span>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void doSend(input)}
                      disabled={sending}
                    >
                      发送
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <aside className="stack-24">
            <div className="card">
              <div className="card-head">
                <h2>项目记录</h2>
                <span className="tag tag-quiet">实时</span>
              </div>
              <div className="card-body">
                {seed ? (
                  <div className="stack-8">
                    {SEED_FIELDS.map((f) => (
                      <div key={f.key} className="sink-item">
                        <div className="sink-key">{f.label}</div>
                        <div className="sink-val">{seed[f.key] || '—'}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <span className="fs-12">还没有沉淀任何设定</span>
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>写作提示</h2>
                <span className="tag tag-quiet">提示</span>
              </div>
              <div className="card-body stack-8">
                <p className="fs-13 muted">
                  不用先填设定表：聊到哪算哪，助手会自己把散落的念头整理成结构化设定。
                </p>
                <p className="fs-13 muted">一次只追问一个问题：回答当前这一问即可，其余的留到下一轮。</p>
                <p className="fs-13 muted">随时可改：这里聊出的设定，之后都能在角色页与设置页随时修订。</p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  )
}
