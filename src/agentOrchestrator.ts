import { chat, extractJson, MINIMAX_MAX_COMPLETION_TOKENS } from './minimax'
import {
  articleDraftSchema,
  draftSchema,
  questionBatchSchema,
  questionsDraftSchema,
  reviewSchema,
  studyDraftSchema,
  validationSchema,
  type GeneratedArticleDraft,
  type GeneratedDraft,
  type GeneratedQuestionsDraft,
  type GeneratedStudyDraft,
} from './schemas'
import {
  articleGenerationPrompt,
  questionGenerationPrompt,
  questionRevisionPrompt,
  reviewPrompt,
  studyGenerationPrompt,
  studyRevisionPrompt,
  validationPrompt,
} from './prompts'
import { saveTrainingSet } from './db'
import type { Attempt, GenerationProgress, TrainingConfig, TrainingSet, ValidationReport } from './types'

const system = '你必须诚实、严谨，并严格遵循用户要求的 JSON 输出格式。'

interface SchemaParser<T> {
  parse(value: unknown): T
}

export class GenerationCancelledError extends Error {
  constructor() {
    super('生成任务已取消')
    this.name = 'GenerationCancelledError'
  }
}

function ensureActive(isCancelled?: () => boolean) {
  if (isCancelled?.()) throw new GenerationCancelledError()
}

async function parseStructured<T>(
  raw: string,
  schema: SchemaParser<T>,
  label: string,
  maxTokens: number,
  isCancelled?: () => boolean,
): Promise<T> {
  try {
    return schema.parse(extractJson(raw))
  } catch (firstError) {
    ensureActive(isCancelled)
    const repaired = await chat([
      {
        role: 'system',
        content: '你是 JSON 格式修复器。只修复 JSON 语法、转义、缺失分隔符和缺失闭合；不得改变已有文章、选项、答案、证据或结论。只输出一个完整 JSON，不要 Markdown。',
      },
      {
        role: 'user',
        content: `任务：修复“${label}”的结构化输出。若末尾被截断，只补齐完成当前 JSON 所必需的字段。\n\n待修复内容：\n<broken_json>\n${raw}\n</broken_json>`,
      },
    ], maxTokens, { thinking: 'disabled', temperature: 0.2 })
    ensureActive(isCancelled)
    try {
      return schema.parse(extractJson(repaired))
    } catch {
      const detail = firstError instanceof Error ? firstError.message : '未知格式错误'
      throw new Error(`${label}格式损坏，自动修复仍未通过：${detail}`)
    }
  }
}

function localIssues(draft: GeneratedDraft, config: TrainingConfig) {
  const issues: string[] = []
  if (draft.questions.length !== config.questionCount) issues.push(`题量应为 ${config.questionCount}`)
  const normalizeSpacing = (value: string) => value.trim().replace(/\s+/g, ' ')
  const containsSurfaceForm = (text: string, term: string) => {
    const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return escaped.length > 0 && new RegExp(`(^|[^A-Za-z])${escaped}($|[^A-Za-z])`, 'i').test(text)
  }
  for (const paragraph of draft.passage) {
    if (normalizeSpacing(paragraph.sentences.join(' ')) !== normalizeSpacing(paragraph.text)) {
      issues.push(`${paragraph.id} 的 sentences 无法无损还原 text`)
    }
  }
  if (new Set(draft.questions.map(({ id }) => id)).size !== draft.questions.length) {
    issues.push('题目 id 不得重复')
  }
  const paragraphs = new Map(draft.passage.map((p) => [p.id, p.text]))
  for (const question of draft.questions) {
    const paragraph = paragraphs.get(question.evidence.paragraphId)
    if (!paragraph) issues.push(`${question.id} 引用了不存在的段落`)
    else if (!paragraph.includes(question.evidence.quote)) issues.push(`${question.id} 的证据引文不在原文中`)
    if (new Set(Object.values(question.options)).size !== 4) issues.push(`${question.id} 有重复选项`)
  }
  const normalizedArticle = normalizeSpacing(draft.passage.map(({ text }) => text).join(' '))
  for (const [index, vocabulary] of draft.vocabulary.entries()) {
    const location = `词汇 vocabulary[${index}]（${vocabulary.word}）`
    if (!containsSurfaceForm(normalizedArticle, vocabulary.word)) issues.push(`${location} 的词形未逐字出现在原文中`)
    if (!containsSurfaceForm(vocabulary.sentence, vocabulary.word)) issues.push(`${location} 的例句不包含该词形`)
    if (!normalizedArticle.includes(normalizeSpacing(vocabulary.sentence))) issues.push(`${location} 的例句不是原文完整句子`)
  }
  return issues
}

async function generateArticle(
  config: TrainingConfig,
  isCancelled?: () => boolean,
): Promise<GeneratedArticleDraft> {
  ensureActive(isCancelled)
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: articleGenerationPrompt(config) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'disabled', temperature: 0.45 },
  )
  ensureActive(isCancelled)
  return parseStructured(raw, articleDraftSchema, '文章 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
}

async function generateQuestions(
  article: GeneratedArticleDraft,
  config: TrainingConfig,
  isCancelled?: () => boolean,
): Promise<GeneratedQuestionsDraft> {
  const firstCount = Math.ceil(config.questionCount / 2)
  const batches = [{ start: 1, count: firstCount }, { start: firstCount + 1, count: config.questionCount - firstCount }]
  const questions: GeneratedQuestionsDraft['questions'] = []
  for (const batch of batches) {
    if (!batch.count) continue
    ensureActive(isCancelled)
    const raw = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: questionGenerationPrompt(article, config, batch.start, batch.count, questions) }],
      MINIMAX_MAX_COMPLETION_TOKENS,
      { thinking: 'adaptive', temperature: 0.4 },
    )
    ensureActive(isCancelled)
    const parsed = await parseStructured(raw, questionBatchSchema, `题目 Agent（${batch.start}-${batch.start + batch.count - 1}）`, MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
    const expectedIds = Array.from({ length: batch.count }, (_, index) => `q${batch.start + index}`)
    if (parsed.questions.length !== batch.count || parsed.questions.some(({ id }, index) => id !== expectedIds[index])) {
      throw new Error(`题目 Agent 未按要求生成 ${expectedIds.join('、')}，本批次已停止`)
    }
    questions.push(...parsed.questions)
  }
  return questionsDraftSchema.parse({ questions })
}

async function generateStudy(
  article: GeneratedArticleDraft,
  config: TrainingConfig,
  isCancelled?: () => boolean,
): Promise<GeneratedStudyDraft> {
  ensureActive(isCancelled)
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: studyGenerationPrompt(article, config) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'disabled', temperature: 0.35 },
  )
  ensureActive(isCancelled)
  return parseStructured(raw, studyDraftSchema, '学习内容 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
}

async function generateStaged(
  config: TrainingConfig,
  onProgress: (progress: GenerationProgress) => void,
  isCancelled?: () => boolean,
  revisionAttempt = 0,
): Promise<GeneratedDraft> {
  const stage = revisionAttempt ? 'revising' as const : 'article' as const
  onProgress({ stage, label: revisionAttempt ? '正在重新生成文章' : '文章 Agent 正在写作', detail: '生成正文、译文和稳定句界', validationAttempt: revisionAttempt })
  const article = await generateArticle(config, isCancelled)
  onProgress({ stage: revisionAttempt ? 'revising' : 'questions', label: '题目 Agent 正在深度命题', detail: `根据定稿文章生成 ${config.questionCount} 道题及证据`, validationAttempt: revisionAttempt })
  const questions = await generateQuestions(article, config, isCancelled)
  onProgress({ stage: revisionAttempt ? 'revising' : 'study', label: '学习内容 Agent 正在整理', detail: '生成重点词汇与长难句解析', validationAttempt: revisionAttempt })
  const study = await generateStudy(article, config, isCancelled)
  return draftSchema.parse({ ...article, ...questions, ...study })
}

async function validate(draft: GeneratedDraft, config: TrainingConfig, attempt: number, isCancelled?: () => boolean): Promise<ValidationReport> {
  ensureActive(isCancelled)
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: validationPrompt(draft, config, attempt) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'adaptive', temperature: 0.2 },
  )
  ensureActive(isCancelled)
  const result = await parseStructured(raw, validationSchema, '审校 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
  const mechanical = localIssues(draft, config)
  const reportHasErrors = result.issues.some(({ severity }) => severity === 'error')
  return {
    ...result,
    decision: mechanical.length || reportHasErrors ? 'REVISE' : result.decision,
    issues: [
      ...result.issues,
      ...mechanical.map((message) => ({ severity: 'error' as const, target: 'local-check', message, suggestion: '修正结构或证据引文' })),
    ],
    checkedAt: new Date().toISOString(),
    attempt,
  }
}

function revisionScopes(report: ValidationReport) {
  const issueText = report.issues.map(({ target, message }) => `${target} ${message}`).join('\n')
  const article = /passage|title|paragraph|sentences|文章|正文|段落|句界/i.test(issueText)
  const questions = /q\d|question|option|answer|evidence|题|选项|答案|证据|题量/i.test(issueText)
  const study = /vocabulary|complex|word|词汇|单词|长难句|翻译/i.test(issueText)
  return { article, questions, study, unknown: !article && !questions && !study }
}

async function reviseStaged(
  draft: GeneratedDraft,
  report: ValidationReport,
  config: TrainingConfig,
  onProgress: (progress: GenerationProgress) => void,
  isCancelled?: () => boolean,
): Promise<GeneratedDraft> {
  const scopes = revisionScopes(report)
  if (report.decision === 'REJECT' || scopes.article || scopes.unknown) {
    return generateStaged(config, onProgress, isCancelled, report.attempt)
  }

  const article = articleDraftSchema.parse({ title: draft.title, passage: draft.passage })
  let questions = questionsDraftSchema.parse({ questions: draft.questions })
  let study = studyDraftSchema.parse({ vocabulary: draft.vocabulary, complexSentences: draft.complexSentences })

  if (scopes.questions) {
    const targetedIds = new Set(report.issues.flatMap(({ target, message }) => `${target} ${message}`.match(/q\d+/gi) || []).map((id) => id.toLowerCase()))
    const firstCount = Math.ceil(config.questionCount / 2)
    const batches = [questions.questions.slice(0, firstCount), questions.questions.slice(firstCount)]
    const revisedQuestions: GeneratedQuestionsDraft['questions'] = []
    for (const batch of batches) {
      const shouldRevise = targetedIds.size === 0 || batch.some(({ id }) => targetedIds.has(id.toLowerCase()))
      if (!shouldRevise) { revisedQuestions.push(...batch); continue }
      onProgress({ stage: 'revising', label: '题目 Agent 正在定向修订', detail: `${report.summary} · ${batch.map(({ id }) => id).join('、')}`, validationAttempt: report.attempt })
      const raw = await chat(
        [{ role: 'system', content: system }, { role: 'user', content: questionRevisionPrompt(article, batch, report, config) }],
        MINIMAX_MAX_COMPLETION_TOKENS,
        { thinking: 'adaptive', temperature: 0.3 },
      )
      ensureActive(isCancelled)
      const parsed = await parseStructured(raw, questionBatchSchema, '题目修订 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
      if (parsed.questions.length !== batch.length || parsed.questions.some(({ id }, index) => id !== batch[index].id)) {
        throw new Error(`题目修订 Agent 改变了批次题号或题量：${batch.map(({ id }) => id).join('、')}`)
      }
      revisedQuestions.push(...parsed.questions)
    }
    questions = questionsDraftSchema.parse({ questions: revisedQuestions })
  }

  if (scopes.study) {
    onProgress({ stage: 'revising', label: '学习内容 Agent 正在定向修订', detail: report.summary, validationAttempt: report.attempt })
    const raw = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: studyRevisionPrompt(article, study, report) }],
      MINIMAX_MAX_COMPLETION_TOKENS,
      { thinking: 'disabled', temperature: 0.25 },
    )
    ensureActive(isCancelled)
    study = await parseStructured(raw, studyDraftSchema, '学习内容修订 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
  }

  return draftSchema.parse({ ...article, ...questions, ...study })
}

export async function createValidatedTraining(
  config: TrainingConfig,
  onProgress: (progress: GenerationProgress) => void,
  isCancelled?: () => boolean,
): Promise<TrainingSet> {
  ensureActive(isCancelled)
  let draft = await generateStaged(config, onProgress, isCancelled)
  let lastReport: ValidationReport | undefined

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    ensureActive(isCancelled)
    onProgress({ stage: 'validating', label: `审校 Agent 第 ${attempt} 次检查`, detail: '核对答案唯一性与原文证据', validationAttempt: attempt })
    lastReport = await validate(draft, config, attempt, isCancelled)
    if (lastReport.decision === 'PASS') {
      onProgress({ stage: 'saving', label: '审校通过', detail: '正在保存到本机', validationAttempt: attempt })
      ensureActive(isCancelled)
      const now = new Date().toISOString()
      const setId = crypto.randomUUID()
      const set: TrainingSet = {
        ...draft,
        id: setId,
        config,
        validation: lastReport,
        createdAt: now,
        vocabulary: draft.vocabulary.map((item) => ({
          ...item,
          id: crypto.randomUUID(),
          sourceSetId: setId,
          status: 'new' as const,
          createdAt: now,
        })),
      }
      await saveTrainingSet(set)
      return set
    }

    if (attempt < 3) {
      onProgress({ stage: 'revising', label: '命题 Agent 正在修订', detail: lastReport.summary, validationAttempt: attempt })
      draft = await reviseStaged(draft, lastReport, config, onProgress, isCancelled)
    }
  }

  throw new Error(`三次审校后仍未通过：${lastReport?.summary || '请稍后重新生成'}`)
}

export async function createAnswerReview(set: TrainingSet, attempt: Attempt) {
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: reviewPrompt(set, attempt) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'adaptive', temperature: 0.3 },
  )
  return parseStructured(raw, reviewSchema, '讲评 Agent', MINIMAX_MAX_COMPLETION_TOKENS)
}
