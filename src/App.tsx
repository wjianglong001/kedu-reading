import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import {
  CalendarBlank,
  CaretDown,
  Notebook,
  ArrowRight,
  BookBookmark,
  BookOpenText,
  Books,
  Check,
  CheckCircle,
  CircleNotch,
  ClockCounterClockwise,
  Eye,
  EyeSlash,
  House,
  Key,
  SlidersHorizontal,
  ShieldCheck,
  Sparkle,
  TextAa,
  Timer,
  Trash,
  UserCircle,
  WarningCircle,
  WifiSlash,
  X,
} from '@phosphor-icons/react'
import { AnswerQuestion, ReaderWorkspace } from './ReaderWorkspace'
import SampleReading from './SampleReading'
import { addVocabularyIfMissing, db, normalizeVocabularyWord } from './db'
import { credentialStore } from './credentialStore'
import { createAnswerReview, createValidatedTraining, GenerationCancelledError } from './agentOrchestrator'
import { verifyApiKey, MINIMAX_MODEL } from './minimax'
import { annotationAnchor, lookupReadingText, LookupRequestGate, normalizeAnnotationText, passageSentences, tokenizeEnglish, type AnnotationKind } from './readingLookup'
import {
  DEFAULT_CONFIG,
  type Attempt,
  type Density,
  type Difficulty,
  type Focus,
  type GenerationProgress,
  type PassageLength,
  type ReadingAnnotation,
  type Topic,
  type TrainingConfig,
  type TrainingSet,
  type VocabularyItem,
} from './types'

type Tab = 'home' | 'practice' | 'vocabulary' | 'history' | 'me'
type PracticeMode = 'configure' | 'generating' | 'exam' | 'result'

const tabs: Array<{ id: Tab; label: string; icon: typeof House }> = [
  { id: 'home', label: '首页', icon: House },
  { id: 'practice', label: '训练', icon: BookOpenText },
  { id: 'vocabulary', label: '单词本', icon: Books },
  { id: 'history', label: '历史', icon: ClockCounterClockwise },
  { id: 'me', label: '我的', icon: UserCircle },
]

const stageOrder: GenerationProgress['stage'][] = ['article', 'questions', 'study', 'validating', 'revising', 'saving']

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

function Screen({ children, screenKey }: { children: ReactNode; screenKey: string }) {
  return (
    <motion.div
      key={screenKey}
      className="screen"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action}
    </header>
  )
}

function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  )
}

function HomePage({ config, attempts, vocabulary, activeTitle, inProgress, onStart, onSample, onWords, onHistory }: {
  config: TrainingConfig
  attempts: Attempt[]
  vocabulary: VocabularyItem[]
  activeTitle?: string
  inProgress: boolean
  onStart: () => void
  onSample: () => void
  onWords: () => void
  onHistory: () => void
}) {
  const pendingWords = vocabulary.filter((word) => word.status !== 'mastered').length
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
  return <Screen screenKey="home">
    <header className="desk-header"><h1>学习书桌</h1><span><CalendarBlank />{date}</span></header>
    <section className="desk-feature" aria-labelledby="training-heading">
      <div className="desk-copy">
        <p className="feature-label"><span /> 考研英语阅读</p>
        <h2 id="training-heading">{activeTitle ? '继续上次阅读' : inProgress ? '训练生成中' : '阅读精练'}</h2>
        <p className="feature-detail">{activeTitle || (inProgress ? '查看当前进度与审校结果。' : '按你的难度出题，读完用原文核对答案。')}</p>
        <div className="feature-settings"><BookOpenText />{config.difficulty}<i />{config.passageLength}篇幅<i />{config.questionCount} 题</div>
        <div className="feature-actions">
          <button className="primary-button" onClick={onStart}>{activeTitle ? '继续作答' : inProgress ? '查看进度' : '开始训练'} <ArrowRight /></button>
          <button className="sample-link" onClick={onSample}>先试一题</button>
        </div>
      </div>
      <div className="desk-photo" role="presentation" />
    </section>
    <h2 className="desk-section-title">学习记录</h2>
    <div className="desk-records">
      <button onClick={onWords}><span className="record-icon"><Books /></span><span className="record-copy"><strong>单词本</strong><small>{pendingWords ? pendingWords + ' 个词待掌握' : '查看阅读中收录的词汇'}</small></span><ArrowRight /></button>
      <button onClick={onHistory}><span className="record-icon"><ClockCounterClockwise /></span><span className="record-copy"><strong>训练历史</strong><small>{attempts.length ? '已完成 ' + attempts.length + ' 套 · 最近 ' + attempts[0].score + ' / ' + attempts[0].total : '回看作答记录与讲评'}</small></span><ArrowRight /></button>
    </div>
  </Screen>
}

function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
}) {
  return (
    <fieldset className="config-field">
      <legend>{label}</legend>
      <div className="segmented">
        {options.map((option) => (
          <button key={option} type="button" className={value === option ? 'selected' : ''} onClick={() => onChange(option)} aria-pressed={value === option}>
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function ConfigurePage({ config, setConfig, hasKey, generationBusy, onGenerate, onGoKey }: {
  config: TrainingConfig
  setConfig: (config: TrainingConfig) => void
  hasKey: boolean
  generationBusy: boolean
  onGenerate: () => void
  onGoKey: () => void
}) {
  const patch = <K extends keyof TrainingConfig>(key: K, value: TrainingConfig[K]) => setConfig({ ...config, [key]: value })
  return (
    <Screen screenKey="configure">
      <PageHeader title="设置阅读训练" description="选择难度和主题，生成一套带原文解析的阅读题。" />
      {generationBusy && (
        <div className="notice"><CircleNotch className="spinner" /><div><strong>上一任务正在安全结束</strong><p>当前模型请求返回后会立即停止，不会开始下一轮审校。</p></div></div>
      )}
      <div className="config-sheet">
        <Segmented<Difficulty> label="难度" value={config.difficulty} options={['基础', '考研常规', '冲刺']} onChange={(v) => patch('difficulty', v)} />
        <Segmented<Topic> label="主题" value={config.topic} options={['社会与文化', '科技与伦理', '教育与成长', '经济与商业', '自然与环境']} onChange={(v) => patch('topic', v)} />
        <details className="more-settings"><summary><SlidersHorizontal /><span>更多设置<small>{config.passageLength}篇幅 · {config.questionCount} 题 · {config.focus}训练{config.timed ? ' · 计时' : ''}</small></span><CaretDown /></summary>
        <div className="config-columns">
          <Segmented<PassageLength> label="文章长度" value={config.passageLength} options={['短篇', '标准', '长篇']} onChange={(v) => patch('passageLength', v)} />
          <Segmented<4 | 5 | 6> label="题目数量" value={config.questionCount} options={[4, 5, 6]} onChange={(v) => patch('questionCount', v)} />
        </div>
        <Segmented<Focus> label="训练重点" value={config.focus} options={['综合', '主旨', '推理', '词义', '态度']} onChange={(v) => patch('focus', v)} />
        <div className="config-columns">
          <Segmented<Density> label="生僻词" value={config.rareWordDensity} options={['少', '适中', '多']} onChange={(v) => patch('rareWordDensity', v)} />
          <Segmented<Density> label="长难句" value={config.complexSentenceDensity} options={['少', '适中', '多']} onChange={(v) => patch('complexSentenceDensity', v)} />
        </div>
        <label className="switch-row">
          <span><Timer /><span><strong>限时模式</strong><small>交卷时记录用时，不会强制结束</small></span></span>
          <input type="checkbox" checked={config.timed} onChange={(event) => patch('timed', event.target.checked)} />
        </label>
        </details>
      </div>
      <button className="primary-button sticky-action" disabled={generationBusy} onClick={hasKey ? onGenerate : onGoKey}>{hasKey ? <Sparkle /> : <Key />} {generationBusy ? '正在结束上一任务' : hasKey ? '生成阅读训练' : '设置 API Key'}</button>
      <p className="cost-note">{hasKey ? '生成将调用 MiniMax，费用按模型用量计算。' : '首次生成需连接 MiniMax。验证后会回到这套配置。'}</p>
    </Screen>
  )
}

function GenerationPage({ progress, error, onRetry, onCancel }: {
  progress?: GenerationProgress
  error?: string
  onRetry: () => void
  onCancel: () => void
}) {
  const currentIndex = progress
    ? stageOrder.indexOf(progress.stage === 'revising' ? 'validating' : progress.stage)
    : 0
  const visibleStages = [
    { stage: 'article', title: '文章 Agent', detail: '正文、译文与句界' },
    { stage: 'questions', title: '题目 Agent', detail: '深度推理题目与证据' },
    { stage: 'study', title: '学习内容 Agent', detail: '生词与长难句' },
    { stage: 'validating', title: '审校 Agent', detail: '答案唯一性、证据与难度' },
    { stage: 'saving', title: '写入本机', detail: '通过后保存完整训练' },
  ] as const
  return (
    <Screen screenKey="generating">
      <PageHeader eyebrow="双 Agent 工作台" title={error ? '这次没有通过' : '正在校成一套好题'} description={error ? '没有把未通过审校的题目交给你。' : '通常需要数分钟；复杂配置或繁忙时可能更久，请保持应用在前台和网络连接。'} />
      {error ? (
        <div className="generation-error">
          <WarningCircle weight="duotone" />
          <h2>生成已停止</h2><p>{error}</p>
          <div className="button-row"><button className="secondary-button" onClick={onCancel}>返回设置</button><button className="primary-button" onClick={onRetry}>重新生成</button></div>
        </div>
      ) : (
        <div className="agent-sheet">
          <div className="agent-mark"><CircleNotch className="spinner" weight="bold" /><span>校</span></div>
          <p className="live-label" aria-live="polite">{progress?.label || '准备模型请求'}</p>
          <p>{progress?.detail || '正在建立安全连接'}</p>
          <ol className="phase-list">
            {visibleStages.map((item, index) => {
              const mappedIndex = stageOrder.indexOf(item.stage)
              const complete = currentIndex > mappedIndex || (item.stage === 'saving' && progress?.stage === 'saving')
              const active = item.stage === progress?.stage || (item.stage === 'validating' && progress?.stage === 'revising')
              return <li key={item.stage} className={complete ? 'complete' : active ? 'active' : ''}>
                <span>{complete ? <Check weight="bold" /> : index + 1}</span>
                <div><strong>{item.title}</strong><small>{item.detail}</small></div>
              </li>
            })}
          </ol>
          {progress && progress.validationAttempt > 0 && <p className="attempt-note">审校轮次 {progress.validationAttempt} / 3</p>}
          <button className="text-button cancel-button" onClick={onCancel}>回到设置</button>
        </div>
      )}
    </Screen>
  )
}

interface LookupTarget {
  kind: AnnotationKind
  text: string
  paragraphId: string
  anchor: string
  contextSentence: string
}

function InteractiveParagraph({ paragraphId, sentences, mode, annotations, onLookup }: {
  paragraphId: string
  sentences: string[]
  mode: AnnotationKind
  annotations: ReadingAnnotation[]
  onLookup: (target: LookupTarget, trigger: HTMLElement) => void
}) {
  const isMarked = (anchor: string) => annotations.some((annotation) => annotation.anchor === anchor)
  const activate = (event: ReactMouseEvent<HTMLParagraphElement>) => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>('[data-lookup-anchor]')
    if (!trigger) return
    const { lookupAnchor, lookupKind, lookupText, lookupContext } = trigger.dataset
    if (!lookupAnchor || !lookupKind || !lookupText || !lookupContext) return
    onLookup({
      anchor: lookupAnchor,
      kind: lookupKind as AnnotationKind,
      text: lookupText,
      paragraphId,
      contextSentence: lookupContext,
    }, trigger)
  }

  if (mode === 'sentence') {
    return <p className="interactive-copy sentence-mode" data-paragraph-id={paragraphId} onClick={activate}>{sentences.map((sentence, index) => {
      const anchor = annotationAnchor(paragraphId, 'sentence', index)
      return <span
        className={isMarked(anchor) ? 'reading-target marked' : 'reading-target'}
        key={`${paragraphId}-sentence-${index}`}
        data-lookup-anchor={anchor}
        data-lookup-kind="sentence"
        data-lookup-text={sentence.trim()}
        data-lookup-context={sentence.trim()}
      >{sentence}{index < sentences.length - 1 ? ' ' : ''}</span>
    })}</p>
  }

  return <p className="interactive-copy word-mode" data-paragraph-id={paragraphId} onClick={activate}>{sentences.flatMap((sentence, sentenceIndex) => (
    tokenizeEnglish(`${sentence}${sentenceIndex < sentences.length - 1 ? ' ' : ''}`).map((token, tokenIndex) => {
      const anchor = annotationAnchor(paragraphId, 'word', sentenceIndex, tokenIndex)
      return token.isWord ? (
        <span
          className={isMarked(anchor) ? 'reading-target marked' : 'reading-target'}
          key={anchor}
          data-lookup-anchor={anchor}
          data-lookup-kind="word"
          data-lookup-text={token.text}
          data-lookup-context={sentence.trim()}
        >{token.text}</span>
      ) : <span key={anchor}>{token.text}</span>
    })
  ))}</p>
}

function AnnotationSheet({ target, annotation, status, message, vocabularyState, onClose, onRetry, onAdd, onRemove }: {
  target: LookupTarget
  annotation?: ReadingAnnotation
  status: 'loading' | 'ready' | 'error'
  message: string
  vocabularyState: 'idle' | 'adding' | 'added' | 'exists'
  onClose: () => void
  onRetry: () => void
  onAdd: () => void
  onRemove: () => void
}) {
  const sheetRef = useRef<HTMLElement>(null)
  const containFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !sheetRef.current) return
    const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div className="lookup-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={sheetRef} className="lookup-sheet" role="dialog" aria-modal="true" aria-labelledby="lookup-title" onKeyDown={containFocus}>
      <div className="lookup-handle" />
      <header>
        <div>
          <span>{target.kind === 'word' ? '单词释义' : '句子解析'}</span>
          <h2 id="lookup-title">{target.text}</h2>
          {annotation && <p className="lookup-meta">{[annotation.phonetic, annotation.label].filter(Boolean).join(' · ')}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭释义" autoFocus><X /></button>
      </header>
      {status === 'loading' && <div className="lookup-state" aria-live="polite"><CircleNotch className="spinner" /><strong>正在结合原文解释</strong><p>只分析当前单词或句子。</p></div>}
      {status === 'error' && <div className="lookup-state error" aria-live="polite"><WarningCircle /><strong>暂时无法解释</strong><p>{message}</p><button className="secondary-button" onClick={onRetry}>重新查询</button></div>}
      {status === 'ready' && annotation && <>
        <div className="lookup-meaning"><span>中文</span><p>{annotation.meaning}</p></div>
        <div className="lookup-explanation"><span>{target.kind === 'word' ? '结合语境' : '句子结构'}</span><p>{annotation.explanation}</p></div>
        <p className="annotation-status"><CheckCircle weight="fill" /> 已标记在这篇文章中</p>
        <div className="lookup-actions">
          {target.kind === 'word' && <button className="primary-button" onClick={onAdd} disabled={vocabularyState !== 'idle'}>
            <BookBookmark weight="fill" />
            {vocabularyState === 'adding' ? '正在加入' : vocabularyState === 'added' ? '已加入单词本' : vocabularyState === 'exists' ? '单词本中已有' : '加入单词本'}
          </button>}
          <button className="text-button" onClick={onRemove}>取消文章标记</button>
        </div>
        <p className="lookup-feedback" aria-live="polite">{message}</p>
      </>}
    </section>
  </div>
}

function ExamPage({ set, answers, setAnswers, elapsed, words, closeLookupSignal, onLookupState, onAddVocabulary, onSubmit, onBack }: {
  set: TrainingSet
  answers: Record<string, string>
  setAnswers: (answers: Record<string, string>) => void
  elapsed: number
  words: VocabularyItem[]
  closeLookupSignal: number
  onLookupState: (open: boolean) => void
  onAddVocabulary: (item: VocabularyItem) => Promise<'added' | 'exists'>
  onSubmit: () => void
  onBack: () => void
}) {
  const [translation, setTranslation] = useState(false)
  const [lookupMode, setLookupMode] = useState<AnnotationKind>('word')
  const [annotations, setAnnotations] = useState<ReadingAnnotation[]>([])
  const [target, setTarget] = useState<LookupTarget>()
  const [annotation, setAnnotation] = useState<ReadingAnnotation>()
  const [lookupStatus, setLookupStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [lookupMessage, setLookupMessage] = useState('')
  const [vocabularyState, setVocabularyState] = useState<'idle' | 'adding' | 'added' | 'exists'>('idle')
  const lookupRequestGate = useRef(new LookupRequestGate())
  const lookupTrigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    db.readingAnnotations.where('setId').equals(set.id).toArray().then(setAnnotations)
  }, [set.id])
  useEffect(() => {
    lookupRequestGate.current.invalidate()
    setTarget(undefined)
    onLookupState(false)
  }, [closeLookupSignal, onLookupState])
  useEffect(() => () => { lookupRequestGate.current.invalidate() }, [])
  useEffect(() => {
    if (!target) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        lookupRequestGate.current.invalidate()
        setTarget(undefined)
        onLookupState(false)
        window.requestAnimationFrame(() => lookupTrigger.current?.focus())
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape) }
  }, [target])

  const closeLookup = () => {
    lookupRequestGate.current.invalidate()
    setTarget(undefined)
    onLookupState(false)
    window.requestAnimationFrame(() => lookupTrigger.current?.focus())
  }
  const queryTarget = async (nextTarget: LookupTarget, trigger?: HTMLElement) => {
    const requestId = lookupRequestGate.current.begin()
    if (trigger) lookupTrigger.current = trigger
    setTarget(nextTarget); setAnnotation(undefined); setLookupStatus('loading'); onLookupState(true); setVocabularyState('idle'); setLookupMessage('')
    const normalized = normalizeAnnotationText(nextTarget.text)
    const saved = annotations.find((item) => item.anchor === nextTarget.anchor)
    const existsInVocabulary = nextTarget.kind === 'word' && words.some((word) => normalizeVocabularyWord(word.word) === normalized)
    if (saved) {
      if (!lookupRequestGate.current.isCurrent(requestId)) return
      setAnnotation(saved); setLookupStatus('ready'); setVocabularyState(existsInVocabulary ? 'exists' : 'idle'); return
    }

    if (nextTarget.kind === 'word') {
      const localWord = [...set.vocabulary, ...words].find((word) => normalizeVocabularyWord(word.word) === normalized)
      if (localWord) {
        const localAnnotation: ReadingAnnotation = {
          id: crypto.randomUUID(), setId: set.id, paragraphId: nextTarget.paragraphId, kind: 'word',
          anchor: nextTarget.anchor,
          text: nextTarget.text, normalizedText: normalized, meaning: localWord.meaning,
          explanation: '这个词已在本地单词本中，释义直接从本机读取。', contextSentence: nextTarget.contextSentence,
          phonetic: localWord.phonetic, createdAt: new Date().toISOString(),
        }
        if (!lookupRequestGate.current.isCurrent(requestId)) return
        await db.readingAnnotations.put(localAnnotation)
        if (!lookupRequestGate.current.isCurrent(requestId)) return
        setAnnotations((current) => [...current, localAnnotation]); setAnnotation(localAnnotation); setLookupStatus('ready'); setVocabularyState('exists'); return
      }
    }

    if (!navigator.onLine) {
      if (!lookupRequestGate.current.isCurrent(requestId)) return
      setLookupStatus('error'); setLookupMessage('当前离线；联网后可以查询新的释义。'); return
    }
    setLookupStatus('loading')
    try {
      const result = await lookupReadingText({ set, ...nextTarget })
      if (!lookupRequestGate.current.isCurrent(requestId)) return
      await db.readingAnnotations.put(result)
      if (!lookupRequestGate.current.isCurrent(requestId)) return
      setAnnotations((current) => [...current, result]); setAnnotation(result); setLookupStatus('ready')
    } catch (error) {
      if (!lookupRequestGate.current.isCurrent(requestId)) return
      setLookupStatus('error'); setLookupMessage(error instanceof Error ? error.message : '查询失败，请稍后重试')
    }
  }

  const addCurrentWord = async () => {
    if (!annotation || annotation.kind !== 'word') return
    setVocabularyState('adding'); setLookupMessage('')
    try {
      const result = await onAddVocabulary({
        id: crypto.randomUUID(), word: annotation.text, phonetic: annotation.phonetic, meaning: annotation.meaning,
        sentence: annotation.contextSentence, sourceSetId: set.id, status: 'new', createdAt: new Date().toISOString(),
      })
      setVocabularyState(result === 'added' ? 'added' : 'exists')
      setLookupMessage(result === 'added' ? '已保存到本机单词本。' : '这个单词已经在单词本中。')
    } catch {
      setVocabularyState('idle')
      setLookupMessage('保存失败，请稍后再试。')
    }
  }

  const removeCurrentAnnotation = async () => {
    if (!annotation) return
    await db.readingAnnotations.delete(annotation.id)
    setAnnotations((current) => current.filter(({ id }) => id !== annotation.id))
    closeLookup()
  }

  return (
    <Screen screenKey="exam">
      <div className="exam-content" inert={target ? true : undefined} aria-hidden={target ? true : undefined}>
      <ReaderWorkspace title="阅读训练" progress={`已答 ${Object.keys(answers).length} / ${set.questions.length}`} onBack={onBack}
        timer={set.config.timed && <span className="elapsed"><Timer /> {Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}</span>}
        passage={<>
          <div className="pass-stamp"><ShieldCheck weight="fill" /> 审校通过</div>
          <p className="proof-number">PASSAGE / {set.questions.length} QUESTIONS</p>
          <h1>{set.title}</h1>
          <div className="reading-tools" aria-label="阅读辅助工具">
            <button className="translation-toggle" onClick={() => setTranslation(!translation)}>{translation ? '隐藏译文' : '查看译文'}</button>
            <div className="lookup-mode" role="group" aria-label="标注方式">
              <button className={lookupMode === 'word' ? 'active' : ''} onClick={() => setLookupMode('word')} aria-pressed={lookupMode === 'word'}><BookBookmark /> 点词释义</button>
              <button className={lookupMode === 'sentence' ? 'active' : ''} onClick={() => setLookupMode('sentence')} aria-pressed={lookupMode === 'sentence'}><TextAa /> 点句解析</button>
            </div>
          </div>
          <p className="lookup-hint">直接点击正文中的{lookupMode === 'word' ? '单词查看释义' : '句子查看翻译与语法'}。红色虚线表示已标记。</p>
          <div className="passage-copy">
            {set.passage.map((paragraph) => <div key={paragraph.id} className="paragraph"><span>{paragraph.id.replace('p', '')}</span><InteractiveParagraph paragraphId={paragraph.id} sentences={passageSentences(paragraph)} mode={lookupMode} annotations={annotations} onLookup={queryTarget} />{translation && <p className="translation">{paragraph.translation}</p>}</div>)}
          </div>
        </>}
        questions={<>
          {set.questions.map((question, index) => <AnswerQuestion key={question.id} question={question} number={index + 1} answer={answers[question.id]} onChange={(value) => setAnswers({ ...answers, [question.id]: value })} />)}
          <button className="primary-button submit-button" onClick={onSubmit} disabled={!Object.keys(answers).length}>提交并查看讲评</button>
          {Object.keys(answers).length < set.questions.length && <p className="cost-note">未作答题目会按错误计分。</p>}
        </>} />
      </div>
      {target && <AnnotationSheet target={target} annotation={annotation} status={lookupStatus} message={lookupMessage} vocabularyState={vocabularyState} onClose={closeLookup} onRetry={() => queryTarget(target, lookupTrigger.current || undefined)} onAdd={addCurrentWord} onRemove={removeCurrentAnnotation} />}
    </Screen>
  )
}

function SavedAnnotations({ setId }: { setId: string }) {
  const [annotations, setAnnotations] = useState<ReadingAnnotation[]>([])
  useEffect(() => { db.readingAnnotations.where('setId').equals(setId).sortBy('createdAt').then(setAnnotations) }, [setId])
  if (!annotations.length) return null
  return <section className="saved-annotations" aria-labelledby="saved-annotations-title">
    <div className="saved-annotations-heading">
      <BookBookmark weight="fill" />
      <div><h2 id="saved-annotations-title">我的文章标注</h2><p>{annotations.length} 条 · 保存在本机</p></div>
    </div>
    <div className="saved-annotation-list">{annotations.map((item) => <article key={item.id}>
      <span>{item.kind === 'word' ? '单词' : '句子'} · {item.paragraphId.toUpperCase()}</span>
      <h3>{item.text}</h3>
      <p className="saved-meaning">{item.meaning}</p>
      <p>{item.explanation}</p>
    </article>)}</div>
  </section>
}

function ResultPage({ set, attempt, reviewLoading, onDone }: { set: TrainingSet; attempt: Attempt; reviewLoading: boolean; onDone: () => void }) {
  return (
    <Screen screenKey="result">
      <PageHeader eyebrow="训练讲评" title={`${attempt.score} / ${attempt.total}`} description={attempt.aiSummary || (reviewLoading ? '客观题已经评分，AI 正在整理阅读方法。' : '评分已保存在本机。')} />
      {reviewLoading && <div className="notice"><CircleNotch className="spinner" /><div><strong>讲评 Agent 正在分析</strong><p>即使讲评失败，标准答案与分数也不会改变。</p></div></div>}
      <div className="review-list">
        {set.questions.map((question, index) => {
          const answer = attempt.answers[question.id]
          const correct = answer === question.correctAnswer
          const ai = attempt.aiReviews?.find((item) => item.questionId === question.id)
          return <article className={`review-card ${correct ? 'correct' : 'incorrect'}`} key={question.id}>
            <div className="review-heading"><span>{correct ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}</span><div><p>第 {index + 1} 题 · {correct ? '正确' : '需要复盘'}</p><h2>{question.stem}</h2></div></div>
            <p className="answer-line">你的答案 <strong>{answer || '未作答'}</strong>　标准答案 <strong>{question.correctAnswer}</strong></p>
            <blockquote><span>原文证据 · {question.evidence.paragraphId.toUpperCase()}</span>{question.evidence.quote}</blockquote>
            <p>{ai?.comment || question.explanation}</p>
            <div className="method-note"><strong>解题方法</strong>{ai?.method || question.evidence.rationale}</div>
          </article>
        })}
      </div>
      <SavedAnnotations setId={set.id} />
      <button className="primary-button sticky-action" onClick={onDone}>完成复盘</button>
    </Screen>
  )
}

function VocabularyPage({ words, onStatus }: { words: VocabularyItem[]; onStatus: (word: VocabularyItem, status: VocabularyItem['status']) => void }) {
  return (
    <Screen screenKey="vocabulary">
      <PageHeader eyebrow="本地词库" title="单词本" description="生成训练时自动收录。状态只保存在这台设备。" />
      {words.length ? <div className="word-list">{words.map((word) => (
        <article className="word-card" key={word.id}>
          <div className="word-head"><div><h2>{word.word}</h2>{word.phonetic && <span>{word.phonetic}</span>}</div><select aria-label={`${word.word} 掌握状态`} value={word.status} onChange={(event) => onStatus(word, event.target.value as VocabularyItem['status'])}><option value="new">新词</option><option value="learning">学习中</option><option value="mastered">已掌握</option></select></div>
          <p className="meaning">{word.meaning}</p><p className="example">{word.sentence}</p>
        </article>
      ))}</div> : <EmptyState icon={<Books />} title="还没有收录单词" body="完成一套 AI 阅读训练后，重点词汇会自动出现在这里。" />}
    </Screen>
  )
}

function HistoryPage({ attempts, sets, onOpen }: { attempts: Attempt[]; sets: TrainingSet[]; onOpen: (set: TrainingSet, attempt: Attempt) => void }) {
  return (
    <Screen screenKey="history">
      <PageHeader eyebrow="只在本机" title="训练历史" description="文章、答案和讲评离线可看。删除应用数据后无法恢复。" />
      {attempts.length ? <div className="history-list">{attempts.map((attempt) => {
        const set = sets.find((item) => item.id === attempt.setId)
        if (!set) return null
        return <button className="history-card" key={attempt.id} onClick={() => onOpen(set, attempt)}>
          <span className="history-score">{attempt.score}<small>/{attempt.total}</small></span>
          <span><strong>{set.title}</strong><small>{formatDate(attempt.completedAt)} · {set.config.difficulty} · {set.config.topic}</small></span>
          <ArrowRight />
        </button>
      })}</div> : <EmptyState icon={<ClockCounterClockwise />} title="历史还是空的" body="你完成的每套阅读训练都会保存在这里。" />}
    </Screen>
  )
}

function MePage({ storedKey, onKeyChange }: { storedKey: string; onKeyChange: (value: string) => void }) {
  const [value, setValue] = useState(storedKey)
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => setValue(storedKey), [storedKey])

  const save = async () => {
    setStatus('saving'); setMessage('正在验证 Key…')
    const previous = await credentialStore.get()
    try {
      await credentialStore.set(value)
      await verifyApiKey()
      onKeyChange(value.trim()); setStatus('ok'); setMessage('验证通过，已安全保存在本机')
    } catch (error) {
      if (previous) await credentialStore.set(previous)
      else await credentialStore.remove()
      setStatus('error'); setMessage(error instanceof Error ? error.message : '验证失败')
    }
  }
  const remove = async () => {
    await credentialStore.remove(); setValue(''); onKeyChange(''); setStatus('idle'); setMessage('API Key 已从本机移除')
  }
  return (
    <Screen screenKey="me">
      <PageHeader eyebrow="设备设置" title="我的" description="这里只管理 MiniMax API Key。无需注册账号，也不会上传学习记录。" />
      <section className="key-sheet">
        <div className="key-icon"><Key weight="duotone" /></div>
        <h2>MiniMax API Key</h2>
        <p>Key 用于从本机直接请求 {MINIMAX_MODEL}。Android 版使用系统 Keystore 加密保存。</p>
        <label className="key-input"><span>API Key</span><div><input value={value} onChange={(event) => { setValue(event.target.value); setStatus('idle') }} type={show ? 'text' : 'password'} placeholder="填写你的 MiniMax API Key" autoCapitalize="none" autoCorrect="off" /><button onClick={() => setShow(!show)} aria-label={show ? '隐藏 API Key' : '显示 API Key'}>{show ? <EyeSlash /> : <Eye />}</button></div></label>
        {message && <p className={`key-message ${status}`} aria-live="polite">{status === 'ok' && <CheckCircle weight="fill" />}{status === 'error' && <WarningCircle weight="fill" />}{status === 'saving' && <CircleNotch className="spinner" />}{message}</p>}
        <button className="primary-button" onClick={save} disabled={!value.trim() || status === 'saving'}>{status === 'saving' ? '验证中' : '验证并保存'}</button>
        {storedKey && <button className="danger-button" onClick={remove}><Trash /> 移除 API Key</button>}
      </section>
      <div className="privacy-note"><ShieldCheck /><p><strong>隐私边界</strong>题目配置和必要的文章内容会发给 MiniMax；答案历史与单词状态保留在设备上。</p></div>
    </Screen>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('configure')
  const [sampleOpen, setSampleOpen] = useState(false)
  const [returnToConfig, setReturnToConfig] = useState(false)
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [sets, setSets] = useState<TrainingSet[]>([])
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [words, setWords] = useState<VocabularyItem[]>([])
  const [storedKey, setStoredKey] = useState('')
  const [activeSet, setActiveSet] = useState<TrainingSet>()
  const [activeAttempt, setActiveAttempt] = useState<Attempt>()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<GenerationProgress>()
  const [generationError, setGenerationError] = useState('')
  const [generationBusy, setGenerationBusy] = useState(false)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [lookupOpen, setLookupOpen] = useState(false)
  const [closeLookupSignal, setCloseLookupSignal] = useState(0)
  const startedAt = useRef(Date.now())
  const generationRunId = useRef(0)
  const reviewRunId = useRef(0)
  const [elapsed, setElapsed] = useState(0)

  const reload = async () => {
    const [savedSets, savedAttempts, savedWords] = await Promise.all([
      db.trainingSets.orderBy('createdAt').reverse().toArray(),
      db.attempts.orderBy('completedAt').reverse().toArray(),
      db.vocabulary.orderBy('createdAt').reverse().toArray(),
    ])
    setSets(savedSets); setAttempts(savedAttempts); setWords(savedWords)
  }

  useEffect(() => { credentialStore.get().then(setStoredKey); reload() }, [])
  useEffect(() => {
    if (practiceMode !== 'exam' || !activeSet?.config.timed) return
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [practiceMode, activeSet])

  const startConfig = () => {
    setTab('practice')
    setSampleOpen(false)
    if (practiceMode !== 'exam' && practiceMode !== 'generating') {
      reviewRunId.current += 1
      setReviewLoading(false)
      setPracticeMode('configure')
    }
    window.scrollTo(0, 0)
  }
  const generate = async () => {
    if (generationBusy) return
    const runId = ++generationRunId.current
    const isCancelled = () => generationRunId.current !== runId
    setGenerationBusy(true)
    setPracticeMode('generating'); setGenerationError(''); setProgress(undefined)
    try {
      const set = await createValidatedTraining(config, (next) => { if (!isCancelled()) setProgress(next) }, isCancelled)
      if (isCancelled()) return
      setActiveSet(set); setAnswers({}); setElapsed(0); startedAt.current = Date.now(); setPracticeMode('exam'); await reload(); window.scrollTo(0, 0)
    } catch (error) {
      if (!(error instanceof GenerationCancelledError) && !isCancelled()) setGenerationError(error instanceof Error ? error.message : '生成失败，请稍后重试')
    } finally {
      setGenerationBusy(false)
    }
  }
  const cancelGeneration = () => {
    generationRunId.current += 1
    setPracticeMode('configure'); setGenerationError(''); setProgress(undefined); window.scrollTo(0, 0)
  }
  const submit = async () => {
    if (!activeSet) return
    const submittedSet = activeSet
    const reviewId = ++reviewRunId.current
    const isCurrentReview = () => reviewRunId.current === reviewId
    const score = submittedSet.questions.filter((question) => answers[question.id] === question.correctAnswer).length
    const attempt: Attempt = { id: crypto.randomUUID(), setId: submittedSet.id, answers, score, total: submittedSet.questions.length, durationSeconds: Math.floor((Date.now() - startedAt.current) / 1000), completedAt: new Date().toISOString() }
    await db.attempts.put(attempt); setActiveAttempt(attempt); setPracticeMode('result'); setReviewLoading(true); await reload(); window.scrollTo(0, 0)
    try {
      const review = await createAnswerReview(submittedSet, attempt)
      const reviewed = { ...attempt, aiSummary: review.summary, aiReviews: review.reviews }
      await db.attempts.put(reviewed)
      if (isCurrentReview()) setActiveAttempt(reviewed)
      await reload()
    } catch {
      if (isCurrentReview()) setActiveAttempt({ ...attempt, aiSummary: 'AI 讲评暂时不可用，已保留标准答案、原文证据和本地解析。' })
    } finally {
      if (isCurrentReview()) setReviewLoading(false)
    }
  }
  const openHistory = (set: TrainingSet, attempt: Attempt) => {
    reviewRunId.current += 1
    setReviewLoading(false)
    setActiveSet(set); setActiveAttempt(attempt); setTab('practice'); setPracticeMode('result'); window.scrollTo(0, 0)
  }
  const updateWord = async (word: VocabularyItem, status: VocabularyItem['status']) => { await db.vocabulary.put({ ...word, status }); await reload() }
  const addVocabulary = async (word: VocabularyItem) => { const result = await addVocabularyIfMissing(word); await reload(); return result }
  const currentLabel = useMemo(() => tabs.find((item) => item.id === tab)?.label, [tab])
  const navigateTab = (id: Tab) => {
    setReturnToConfig(false)
    setSampleOpen(false)
    setTab(id)
    if (id === 'practice' && practiceMode === 'result') setPracticeMode('configure')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let mounted = true
    let removeListener: (() => Promise<void>) | undefined
    CapacitorApp.addListener('backButton', () => {
      if (sampleOpen) { setSampleOpen(false); return }
      if (returnToConfig && tab === 'me') { navigateTab('practice'); return }
      if (lookupOpen) { setCloseLookupSignal((value) => value + 1); setLookupOpen(false); return }
      if (tab === 'practice' && practiceMode === 'generating') { cancelGeneration(); return }
      if (tab === 'practice' && practiceMode === 'exam') { setTab('home'); window.scrollTo(0, 0); return }
      if (tab === 'practice' && practiceMode === 'result') { setPracticeMode('configure'); setTab('home'); window.scrollTo(0, 0); return }
      if (tab !== 'home') { setTab('home'); window.scrollTo(0, 0); return }
      CapacitorApp.exitApp()
    }).then((handle) => {
      if (!mounted) void handle.remove()
      else removeListener = () => handle.remove()
    })
    return () => { mounted = false; void removeListener?.() }
  }, [tab, practiceMode, lookupOpen, sampleOpen, returnToConfig])

  const content = sampleOpen ? <SampleReading onBack={() => setSampleOpen(false)} onTrain={startConfig} />
    : tab === 'home' ? <HomePage config={config} attempts={attempts} vocabulary={words} activeTitle={practiceMode === 'exam' ? activeSet?.title : undefined} inProgress={practiceMode === 'generating'} onStart={startConfig} onSample={() => { setSampleOpen(true); window.scrollTo(0, 0) }} onWords={() => navigateTab('vocabulary')} onHistory={() => navigateTab('history')} />
    : tab === 'practice' ? practiceMode === 'configure' ? <ConfigurePage config={config} setConfig={setConfig} hasKey={Boolean(storedKey)} generationBusy={generationBusy} onGenerate={generate} onGoKey={() => { navigateTab('me'); setReturnToConfig(true) }} />
      : practiceMode === 'generating' ? <GenerationPage progress={progress} error={generationError} onRetry={generate} onCancel={cancelGeneration} />
      : practiceMode === 'exam' && activeSet ? <ExamPage set={activeSet} answers={answers} setAnswers={setAnswers} elapsed={elapsed} words={words} closeLookupSignal={closeLookupSignal} onLookupState={setLookupOpen} onAddVocabulary={addVocabulary} onSubmit={submit} onBack={() => { setLookupOpen(false); setTab('home'); window.scrollTo(0, 0) }} />
      : activeSet && activeAttempt ? <ResultPage set={activeSet} attempt={activeAttempt} reviewLoading={reviewLoading} onDone={() => { setPracticeMode('configure'); navigateTab('home') }} /> : null
    : tab === 'vocabulary' ? <VocabularyPage words={words} onStatus={updateWord} />
    : tab === 'history' ? <HistoryPage attempts={attempts} sets={sets} onOpen={openHistory} />
    : <MePage storedKey={storedKey} onKeyChange={(key) => { setStoredKey(key); if (key && returnToConfig) navigateTab('practice') }} />

  const immersive = sampleOpen || (tab === 'practice' && practiceMode === 'exam')
  return (
    <div className={`app-shell ${immersive ? 'immersive' : ''}`}>
      <aside className="nav-rail" aria-label="主导航"><div className="brand-mark" aria-label="刻读"><Notebook weight="duotone" /><strong>刻读</strong></div>{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => navigateTab(id)} aria-current={tab === id ? 'page' : undefined}><Icon weight={tab === id ? 'fill' : 'regular'} /><span>{label}</span></button>)}</aside>
      {!immersive && <div className="mobile-brand"><Notebook weight="duotone" /><strong>刻读</strong></div>}
      <main id="main-content" aria-label={currentLabel}>{<AnimatePresence mode="wait" initial={false}>{content}</AnimatePresence>}</main>
      {!immersive && <nav className="bottom-nav" aria-label="主导航">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => navigateTab(id)} aria-current={tab === id ? 'page' : undefined}><Icon weight={tab === id ? 'fill' : 'regular'} /><span>{label}</span></button>)}</nav>}
      {!navigator.onLine && <div className="offline-banner"><WifiSlash /> 当前离线，已保存内容仍可查看</div>}
    </div>
  )
}
