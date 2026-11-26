import { z } from 'zod'
import { sourcedDraftSchemas } from './articleSources'
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
import { db, savePendingRevision, saveTrainingSet } from './db'
import type { Attempt, GenerationProgress, PendingRevision, TrainingConfig, TrainingSet, ValidationReport } from './types'

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

export class RevisionPendingError extends Error {
  readonly pending: PendingRevision
  constructor(pending: PendingRevision, message = pending.report.summary) {
    super(message)
    this.pending = pending
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
        content: `任务：修复“${label}”的结构化输出。校验提示：${firstError instanceof Error ? firstError.message.slice(0, 1400) : '结构不符'}。若末尾被截断，只补齐完成当前 JSON 所必需的字段。\n\n待修复内容：\n<broken_json>\n${raw}\n</broken_json>`,
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

function containsSurfaceForm(text: string, term: string) {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped.length > 0 && new RegExp(`(^|[^A-Za-z])${escaped}($|[^A-Za-z])`, 'i').test(text)
}

function restoreVocabularyExamples(draft: GeneratedDraft): GeneratedDraft {
  const sentences = draft.passage.flatMap(p => p.sentences)
  const vocabulary = draft.vocabulary.map(item => {
    if (sentences.includes(item.sentence) && containsSurfaceForm(item.sentence, item.word)) return item
    const matches = sentences.filter(sentence => containsSurfaceForm(sentence, item.word))
    return matches.length === 1 ? { ...item, sentence: matches[0] } : item
  })
  return { ...draft, vocabulary }
}

function localIssues(draft: GeneratedDraft, config: TrainingConfig) {
  const issues: ValidationReport['issues'] = []
  function add(target: string, message: string) {
    issues.push({ severity: 'error', target, message, suggestion: '根据原文修正此处，再重新审校' })
  }
  if (draft.questions.length !== config.questionCount) add('questions', `题量应为 ${config.questionCount}`)
  const normalizeSpacing = (value: string) => value.trim().replace(/\s+/g, ' ')
  for (const paragraph of draft.passage) {
    if (normalizeSpacing(paragraph.sentences.join(' ')) !== normalizeSpacing(paragraph.text)) {
      add(`passage.${paragraph.id}`, `${paragraph.id} 的 sentences 无法无损还原 text`)
    }
  }
  if (new Set(draft.questions.map(({ id }) => id)).size !== draft.questions.length) {
    add('questions', '题目 id 不得重复')
  }
  const paragraphs = new Map(draft.passage.map((p) => [p.id, p.text]))
  const seenStems = new Set<string>()
  for (const question of draft.questions) {
    const stem = normalizeSpacing(question.stem).toLowerCase()
    // Identical stems can be legitimate for different paragraphs (e.g. vocabulary).
    const questionKey = JSON.stringify([stem, normalizeSpacing(question.evidence.quote).toLowerCase()])
    if (seenStems.has(questionKey)) add(question.id, `${question.id} 与另一题使用相同题干和引文`)
    seenStems.add(questionKey)
    const paragraph = paragraphs.get(question.evidence.paragraphId)
    if (!paragraph) add(question.id, `${question.id} 引用了不存在的段落`)
    else if (!paragraph.includes(question.evidence.quote)) add(question.id, `${question.id} 的证据引文不在原文中`)
    if (new Set(Object.values(question.options)).size !== 4) add(question.id, `${question.id} 有重复选项`)
  }
  const sentences = draft.passage.flatMap(p => p.sentences.map(normalizeSpacing))
  const normalizedArticle = sentences.join(' ')
  for (const [index, vocabulary] of draft.vocabulary.entries()) {
    const location = `词汇 vocabulary[${index}]（${vocabulary.word}）`
    if (!containsSurfaceForm(normalizedArticle, vocabulary.word)) add(`vocabulary[${index}]`, `${location} 的词形未逐字出现在原文中`)
    if (!containsSurfaceForm(vocabulary.sentence, vocabulary.word)) add(`vocabulary[${index}]`, `${location} 的例句不包含该词形`)
    if (!sentences.includes(normalizeSpacing(vocabulary.sentence))) add(`vocabulary[${index}]`, `${location} 的例句不是原文完整句子`)
  }
  for (const [index, item] of draft.complexSentences.entries()) {
    if (!sentences.includes(normalizeSpacing(item.sentence))) add(`complexSentences[${index}]`, '长难句必须引用一整句原文')
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

async function generateQuestionBatch(
  article: GeneratedArticleDraft,
  config: TrainingConfig,
  start: number,
  count: number,
  isCancelled?: () => boolean,
) {
  ensureActive(isCancelled)
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: questionGenerationPrompt(article, config, start, count) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'disabled', temperature: 0.4 },
  )
  ensureActive(isCancelled)
  const label = `题目 Agent（${start}-${start + count - 1}）`
  const { questions } = await parseStructured(raw, sourcedDraftSchemas(article).questions, label, MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
  if (questions.length !== count || questions.some(({ id }, index) => id !== `q${start + index}`)) {
    throw new Error(`${label} 未按分配的题号和题量返回`)
  }
  return questions
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
  return parseStructured(raw, sourcedDraftSchemas(article).study, '学习内容 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
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
  ensureActive(isCancelled)
  onProgress({ stage: revisionAttempt ? 'revising' : 'questions', label: '正在出题并整理学习资料', detail: `两批题目并行生成，共 ${config.questionCount} 题，同时整理词汇和长难句`, validationAttempt: revisionAttempt })
  const firstCount = Math.ceil(config.questionCount / 2)
  let failed = false
  const stopped = () => failed || Boolean(isCancelled?.())
  const jobs = [
    generateQuestionBatch(article, config, 1, firstCount, stopped),
    generateQuestionBatch(article, config, firstCount + 1, config.questionCount - firstCount, stopped),
    generateStudy(article, config, stopped),
  ] as const
  try {
    const [first, second, study] = await Promise.all(jobs)
    ensureActive(isCancelled)
    return draftSchema.parse({ ...article, questions: [...first, ...second], ...study })
  } catch (error) {
    // Native HTTP requests already in flight must settle before another run can start.
    failed = true
    await Promise.allSettled(jobs)
    throw error
  }
}

async function validate(draft: GeneratedDraft, config: TrainingConfig, attempt: number, isCancelled?: () => boolean, previous?: ValidationReport): Promise<ValidationReport> {
  ensureActive(isCancelled)
  const mechanical = localIssues(draft, config)
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: validationPrompt(draft, config, attempt, previous) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'disabled', temperature: 0.2 },
  )
  ensureActive(isCancelled)
  const result = await parseStructured(raw, validationSchema, '审校 Agent', MINIMAX_MAX_COMPLETION_TOKENS, isCancelled)
  const issues = [...mechanical, ...result.issues.map(issue => {
    // Auditors use both array indices and stable IDs to identify the same item.
    const target = issue.target.replace(/^questions\[(\d+)\]/i, (path, index) => draft.questions[Number(index)]?.id ?? path)
      .replace(/^passage\[(\d+)\]/i, (path, index) => draft.passage[Number(index)] ? `passage.${draft.passage[Number(index)].id}` : path)
    return { ...issue, target }
  })]
  const reportHasErrors = issues.some(({ severity }) => severity === 'error')
  return {
    ...result,
    issues,
    summary: mechanical.length && result.decision === 'PASS' ? mechanical.map(issue => issue.message).join('；') : result.summary,
    decision: reportHasErrors && result.decision === 'PASS' ? 'REVISE' : result.decision,
    checkedAt: new Date().toISOString(),
    attempt,
  }
}

function revisionScopes(report: ValidationReport) {
  // A question may cite the wrong paragraph. Its explicit target determines
  // which component needs repair, even when its message mentions the article.
  const issueText = report.issues.map(({ target, message }) => {
    const component = target.match(/^(q\d+|questions?|vocabulary|complexSentences|passage|title)\b/i)
    if (component) {
      if (/^complexSentences$/i.test(component[1])) return '长难句'
      return component[1]
    }
    return `${target} ${message}`
  }).join('\n')
  const article = /passage|title|paragraph|sentences|文章|正文|段落|句界/i.test(issueText)
  const questions = /q\d|question|option|answer|evidence|题|选项|答案|证据|题量/i.test(issueText)
  const study = /vocabulary|complex|word|词汇|单词|长难句|翻译/i.test(issueText)
  return { article, questions, study, unknown: !article && !questions && !study }
}

function applyReviewEdits(draft: GeneratedDraft, issues: ValidationReport['issues']): GeneratedDraft | undefined {
  if (!issues.length) return
  if (new Set(issues.map(issue => issue.target)).size !== issues.length) return
  const edited = structuredClone(draft)
  for (const { target, replacement } of issues) {
    const text = replacement?.trim()
    if (!text) return
    const word = /^vocabulary\[(\d+)\]\.meaning$/.exec(target)
    const sentence = /^complexSentences\[(\d+)\]\.(structure|translation)$/.exec(target)
    const distractor = /^(q\d+)\.distractorAnalysis\.([ABCD])$/.exec(target)
    if (word && edited.vocabulary[Number(word[1])]) {
      if (text.length < 2) return
      edited.vocabulary[Number(word[1])].meaning = text
    } else if (sentence && edited.complexSentences[Number(sentence[1])]) {
      if (text.length < 5) return
      const field = sentence[2] as 'structure' | 'translation'
      edited.complexSentences[Number(sentence[1])][field] = text
    } else if (distractor) {
      const question = edited.questions.find(q => q.id === distractor[1])
      const key = distractor[2] as 'A' | 'B' | 'C' | 'D'
      if (!question || question.correctAnswer === key) return
      question.distractorAnalysis[key] = text
    } else {
      return
    }
  }
  return edited
}

async function reviseStaged(
  draft: GeneratedDraft,
  report: ValidationReport,
  config: TrainingConfig,
  onProgress: (progress: GenerationProgress) => void,
  isCancelled?: () => boolean,
): Promise<GeneratedDraft> {
  // Warnings may accompany PASS. When blocking errors exist, spend the
  // revision round on those errors, then independently audit the whole set.
  const blocking = report.issues.filter(({ severity }) => severity === 'error')
  const repairReport = blocking.length ? { ...report, issues: blocking } : report
  if (report.decision === 'REVISE') {
    const edited = applyReviewEdits(draft, repairReport.issues)
    if (edited) return edited
  }
  const translationIds = new Set<string>()
  const otherIssues = repairReport.issues.filter(({ target }) => {
    const match = /^passage[.](p\d+)[.]translation$/i.exec(target)
    if (!match || !draft.passage.some(({ id }) => id === match[1])) return true
    translationIds.add(match[1])
    return false
  })
  const scopes = revisionScopes({ ...repairReport, issues: otherIssues })
  if (report.decision === 'REJECT' || scopes.article || (scopes.unknown && (otherIssues.length > 0 || !translationIds.size))) {
    return generateStaged(config, onProgress, isCancelled, report.attempt)
  }

  const article = articleDraftSchema.parse(draft)
  let failed = false
  const stopped = () => failed || Boolean(isCancelled?.())
  async function repair<T>(prompt: string, schema: SchemaParser<T>, label: string) {
    ensureActive(stopped)
    const raw = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      MINIMAX_MAX_COMPLETION_TOKENS, { thinking: 'disabled', temperature: 0.25 },
    )
    ensureActive(stopped)
    return parseStructured(raw, schema, label, MINIMAX_MAX_COMPLETION_TOKENS, stopped)
  }

  async function repairTranslations() {
    if (!translationIds.size) return article.passage
    const paragraphs = article.passage.filter(({ id }) => translationIds.has(id))
    const issues = repairReport.issues.filter(({ target }) => !otherIssues.some((issue) => issue.target === target))
    const prompt = `只修订以下段落的中文译文，返回 {"translations":[{"id":"p1","translation":"完整译文"}]}，保持输入段落数量和顺序。\n段落：${JSON.stringify(paragraphs)}\n审校问题：${JSON.stringify(issues)}`
    const schema = z.object({ translations: z.array(z.object({ id: z.string(), translation: z.string().trim().min(10) })) })
    const { translations } = await repair(prompt, schema, '译文修订 Agent')
    if (translations.length !== paragraphs.length || translations.some(({ id }, i) => id !== paragraphs[i].id)) {
      throw new Error('译文修订改变了段落编号或数量')
    }
    const replacements = new Map(translations.map(({ id, translation }) => [id, translation]))
    return article.passage.map(p => ({ ...p, translation: replacements.get(p.id) ?? p.translation }))
  }

  const questionIssues = otherIssues.filter(issue => revisionScopes({ ...repairReport, issues: [issue] }).questions)
  // A global issue (e.g. duplicate coverage) requires checking both batches.
  const targets = questionIssues.map(({ target }) => /^(q\d+)(?:[.\[]|$)/i.exec(target)?.[1].toLowerCase())
  const allQuestions = targets.some(id => !draft.questions.some(question => question.id === id))
  async function repairBatch(batch: GeneratedQuestionsDraft['questions']) {
    const affected = batch.filter(({ id }) => allQuestions || targets.includes(id))
    if (!affected.length) return batch
    const { questions } = await repair(questionRevisionPrompt(article, affected, repairReport, config), questionBatchSchema, '题目修订 Agent')
    if (questions.length !== affected.length || questions.some(({ id }, i) => id !== affected[i].id)) {
      throw new Error(`题目修订 Agent 改变了批次题号或题量：${affected.map(({ id }) => id).join('、')}`)
    }
    return batch.map(original => questions.find(({ id }) => id === original.id) ?? original)
  }

  const split = Math.ceil(config.questionCount / 2)
  const jobs = [
    repairBatch(draft.questions.slice(0, split)), repairBatch(draft.questions.slice(split)),
    scopes.study ? repair(studyRevisionPrompt(article, { vocabulary: draft.vocabulary, complexSentences: draft.complexSentences }, repairReport), studyDraftSchema, '学习资料修订 Agent')
      : { vocabulary: draft.vocabulary, complexSentences: draft.complexSentences },
    repairTranslations(),
  ] as const
  try {
    const [first, second, study, passage] = await Promise.all(jobs)
    ensureActive(isCancelled)
    return draftSchema.parse({ title: draft.title, passage, questions: [...first, ...second], ...study })
  } catch (error) {
    failed = true
    await Promise.allSettled(jobs)
    throw error
  }
}

export async function createValidatedTraining(
  config: TrainingConfig,
  onProgress: (progress: GenerationProgress) => void,
  isCancelled?: () => boolean,
  pending?: PendingRevision,
): Promise<TrainingSet> {
  ensureActive(isCancelled)
  let lastReport = pending?.report
  const firstAttempt = (lastReport?.attempt ?? 0) + 1
  const lastAttempt = pending ? firstAttempt : 3
  let draft: GeneratedDraft
  if (pending) {
    config = pending.config
    onProgress({ stage: 'revising', label: '正在修订上次的草稿', detail: pending.report.summary, validationAttempt: pending.report.attempt })
    draft = await reviseStaged(pending.draft, pending.report, config, onProgress, isCancelled)
  } else {
    draft = await generateStaged(config, onProgress, isCancelled)
  }
  const setId = pending?.id ?? crypto.randomUUID()

  for (let attempt = firstAttempt; attempt <= lastAttempt; attempt += 1) {
    ensureActive(isCancelled)
    draft = restoreVocabularyExamples(draft)
    onProgress({ stage: 'validating', label: `审校 Agent 第 ${attempt} 次检查`, detail: '核对答案唯一性与原文证据', validationAttempt: attempt })
    lastReport = await validate(draft, config, attempt, isCancelled, lastReport)
    if (lastReport.decision === 'PASS') {
      onProgress({ stage: 'saving', label: '审校通过', detail: '正在保存到本机', validationAttempt: attempt })
      ensureActive(isCancelled)
      const now = new Date().toISOString()
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
      return await saveTrainingSet(set)
    }

    if (attempt === lastAttempt && lastReport.decision === 'REVISE') {
      const checkpoint = { id: setId, config, draft, report: lastReport }
      await savePendingRevision(checkpoint)
      const errors = lastReport.issues.filter(issue => issue.severity === 'error')
      const localized = errors.length > 0 && errors.every(({ target }) =>
        /^(?:q\d+(?:\.|$)|passage\.p\d+\.translation$|(?:vocabulary|complexSentences)\[\d+\])/.test(target))
      // Use the same single-round continuation as a manual resume. Saving
      // before starting it preserves the article if connectivity is lost.
      if (!pending && localized) {
        try {
          return await createValidatedTraining(config, onProgress, isCancelled, checkpoint)
        } catch (error) {
          if (error instanceof RevisionPendingError || error instanceof GenerationCancelledError) throw error
          if (await db.pendingRevisions.get(setId)) {
            throw new RevisionPendingError(checkpoint, error instanceof Error ? error.message : '自动修订中断，可从草稿继续。')
          }
          throw error
        }
      }
      throw new RevisionPendingError(checkpoint)
    }
    if (attempt < lastAttempt) {
      onProgress({ stage: 'revising', label: '命题 Agent 正在修订', detail: lastReport.summary, validationAttempt: attempt })
      draft = await reviseStaged(draft, lastReport, config, onProgress, isCancelled)
    }
  }

  if (pending) await db.pendingRevisions.delete(pending.id)
  throw new Error(`审校建议重新出题。${lastReport?.summary || ''}`)
}

export async function createAnswerReview(set: TrainingSet, attempt: Attempt) {
  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: reviewPrompt(set, attempt) }],
    MINIMAX_MAX_COMPLETION_TOKENS,
    { thinking: 'adaptive', temperature: 0.3 },
  )
  return parseStructured(raw, reviewSchema, '讲评 Agent', MINIMAX_MAX_COMPLETION_TOKENS)
}
