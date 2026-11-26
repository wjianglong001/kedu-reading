import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from './types'
import { makeDraft, validation } from './test/generationFixtures'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  saveTrainingSet: vi.fn(),
  savePendingRevision: vi.fn(),
}))

vi.mock('./minimax', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./minimax')>()
  return { ...actual, chat: mocks.chat }
})

vi.mock('./db', () => ({ saveTrainingSet: mocks.saveTrainingSet, savePendingRevision: mocks.savePendingRevision }))

import { createValidatedTraining, GenerationCancelledError } from './agentOrchestrator'

const progress = vi.fn()

function articlePart(draft = makeDraft()) {
  return JSON.stringify({ title: draft.title, passage: draft.passage })
}

function questionPart(draft = makeDraft(), start = 0, count = 3) {
  return JSON.stringify({ questions: draft.questions.slice(start, start + count) })
}

function studyPart(draft = makeDraft()) {
  return JSON.stringify({ vocabulary: draft.vocabulary, complexSentences: draft.complexSentences })
}

function mockInitialDraft(draft = makeDraft()) {
  mocks.chat
    .mockResolvedValueOnce(articlePart(draft))
    .mockResolvedValueOnce(questionPart(draft, 0, 3))
    .mockResolvedValueOnce(questionPart(draft, 3, 2))
    .mockResolvedValueOnce(studyPart(draft))
}

beforeEach(() => {
  mocks.chat.mockReset()
  mocks.saveTrainingSet.mockReset().mockImplementation(async set => set)
  mocks.savePendingRevision.mockReset().mockResolvedValue(undefined)
  progress.mockReset()
})

describe('generation orchestration stability', () => {
  it('saves only after first-pass validation', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('PASS'))

    const result = await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(result.validation.decision).toBe('PASS')
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
    expect(progress.mock.calls.map(([item]) => item.stage)).toEqual(['article', 'questions', 'validating', 'saving'])
  })

  it('requests a direct independent audit without spending the output budget on hidden reasoning', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    const validationCall = mocks.chat.mock.calls[4]
    expect(validationCall[1]).toBe(32_768)
    expect(validationCall[2]).toMatchObject({ thinking: 'disabled', temperature: 0.2 })
  })

  it.each([4, 5, 6] as const)('starts both batches and study together and waits before auditing %i questions', async (count) => {
    const draft = makeDraft(count)
    const firstCount = Math.ceil(count / 2)
    let resolveFirst!: (value: string) => void
    const first = new Promise<string>((resolve) => { resolveFirst = resolve })
    mocks.chat.mockResolvedValueOnce(articlePart(draft))
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(questionPart(draft, firstCount, count - firstCount))
      .mockResolvedValueOnce(studyPart(draft))
      .mockResolvedValueOnce(validation('PASS'))

    const run = createValidatedTraining({ ...DEFAULT_CONFIG, questionCount: count }, progress)
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(4))
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
    resolveFirst(questionPart(draft, 0, firstCount))
    const set = await run
    expect(set.questions.map(({ id }) => id)).toEqual(draft.questions.map(({ id }) => id))
    expect(mocks.chat).toHaveBeenCalledTimes(5)
  })

  it('drains in-flight work after a failed batch without repairing its late sibling or saving', async () => {
    let resolveSecond!: (value: string) => void
    let rejectFirst!: (error: Error) => void
    const first = new Promise<string>((_, reject) => { rejectFirst = reject })
    const second = new Promise<string>((resolve) => { resolveSecond = resolve })
    mocks.chat.mockResolvedValueOnce(articlePart()).mockReturnValueOnce(first)
      .mockReturnValueOnce(second).mockResolvedValueOnce(studyPart())
    const run = createValidatedTraining(DEFAULT_CONFIG, progress)
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(4))
    rejectFirst(new Error('出题超时'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveSecond('broken')
    await expect(run).rejects.toThrow('出题超时')
    expect(mocks.chat).toHaveBeenCalledTimes(4)
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('repairs a missing array comma locally without another model charge', async () => {
    const broken = questionPart().replace('},{"id":"q2"', '} {"id":"q2"')
    mocks.chat
      .mockResolvedValueOnce(articlePart())
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(questionPart(makeDraft(), 3, 2))
      .mockResolvedValueOnce(studyPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('uses exactly one model format repair when local repair cannot recover', async () => {
    mocks.chat
      .mockResolvedValueOnce('{"title": @@@')
      .mockResolvedValueOnce(articlePart())
      .mockResolvedValueOnce(questionPart(makeDraft(), 0, 3))
      .mockResolvedValueOnce(questionPart(makeDraft(), 3, 2))
      .mockResolvedValueOnce(studyPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(6)
    expect(String(mocks.chat.mock.calls[1][0][0].content)).toContain('JSON 格式修复器')
    expect(mocks.chat.mock.calls[1][2]).toMatchObject({ thinking: 'disabled' })
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('revises and validates again after REVISE', async () => {
    mockInitialDraft()
    mocks.chat
      .mockResolvedValueOnce(validation('REVISE', [{ severity: 'error', target: 'q2.evidence', message: '引文所在段落不支持答案', suggestion: '修订题目' }]))
      .mockResolvedValueOnce(questionPart(makeDraft(), 1, 1))
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(7)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('audits the original English on the first attempt when the generators return sentence IDs', async () => {
    const draft = makeDraft()
    const questions = draft.questions.map(q => ({
      ...q, evidence: { sourceId: q.evidence.paragraphId + '.s1', rationale: q.evidence.rationale },
    }))
    const withSource = <T extends { sentence: string }>(item: T) => {
      const { sentence, ...details } = item
      return { ...details, sourceId: draft.passage.find(p => p.text === sentence)!.id + '.s1' }
    }
    mocks.chat.mockResolvedValueOnce(articlePart(draft))
      .mockResolvedValueOnce(JSON.stringify({ questions: questions.slice(0, 3) }))
      .mockResolvedValueOnce(JSON.stringify({ questions: questions.slice(3) }))
      .mockResolvedValueOnce(JSON.stringify({ vocabulary: draft.vocabulary.map(withSource), complexSentences: draft.complexSentences.map(withSource) }))
      .mockResolvedValueOnce(validation('PASS'))
    const set = await createValidatedTraining(DEFAULT_CONFIG, progress)
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(set.validation.attempt).toBe(1)
    expect(set.questions[1].evidence.quote).toBe(draft.passage[1].text)
    expect(set.complexSentences).toEqual(draft.complexSentences)
    expect(set.vocabulary.map(v => v.sentence)).toEqual(draft.vocabulary.map(v => v.sentence))
  })

  it('applies explicit review wording only to its target and re-audits before delivery', async () => {
    const draft = makeDraft()
    mockInitialDraft(draft)
    const replacement = '该选项把原文的有限条件扩大到所有情形。'
    mocks.chat.mockResolvedValueOnce(validation('REVISE', [{
      severity: 'error', target: 'q5.distractorAnalysis.C', message: '排除理由对应错误', suggestion: '逐项对照', replacement,
    }])).mockImplementationOnce(async () => {
      expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
      return validation('PASS')
    })
    const set = await createValidatedTraining(DEFAULT_CONFIG, progress)
    expect(mocks.chat).toHaveBeenCalledTimes(6)
    expect(mocks.chat.mock.calls[5][0][1].content).toContain(replacement)
    expect(set.questions[4]).toEqual({ ...draft.questions[4], distractorAnalysis: { ...draft.questions[4].distractorAnalysis, C: replacement } })
    expect(set.validation.attempt).toBe(2)
  })

  it('repairs blocking question and study issues without rewriting an article with only warnings', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('REVISE', [
      { severity: 'warning', target: 'passage.p1.translation', message: '译文措辞建议', suggestion: '改善措辞' },
      { severity: 'warning', target: 'q1.evidence', message: '建议补充依据', suggestion: '补充分析' },
      { severity: 'error', target: 'q4.evidence', message: '引用错段落', suggestion: '修改引文' },
      { severity: 'error', target: 'complexSentences[0].structure', message: '语法错误', suggestion: '修改分析' },
    ])).mockResolvedValueOnce(questionPart(makeDraft(), 3, 1))
      .mockResolvedValueOnce(studyPart()).mockResolvedValueOnce(validation('PASS'))
    const set = await createValidatedTraining(DEFAULT_CONFIG, progress)
    expect(set.validation.attempt).toBe(2)
    expect(mocks.chat.mock.calls[5][0][1].content).toContain('题目修订 Agent')
    expect(mocks.chat.mock.calls[6][0][1].content).toContain('学习资料修订 Agent')
    expect(mocks.chat).toHaveBeenCalledTimes(8)
  })

  it('starts translation, question and study corrections together and audits the merged result', async () => {
    const draft = makeDraft()
    mockInitialDraft(draft)
    const issues = ['questions[4].evidence', 'complexSentences[0].structure', 'passage[1].translation'].map(target => ({
      severity: 'error' as const, target, message: '需要根据原文修订', suggestion: '更正表述',
    }))
    let finishQuestion!: (raw: string) => void
    const pending = new Promise<string>(resolve => { finishQuestion = resolve })
    const translation = '这是经过校正的第二段中文译文。'
    mocks.chat.mockResolvedValueOnce(validation('REVISE', issues))
      .mockReturnValueOnce(pending).mockResolvedValueOnce(studyPart())
      .mockResolvedValueOnce(JSON.stringify({ translations: [{ id: 'p2', translation }] }))
      .mockResolvedValueOnce(validation('PASS'))

    const run = createValidatedTraining(DEFAULT_CONFIG, progress)
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(8))
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
    expect(mocks.chat.mock.calls[5][0][1].content).not.toContain(draft.questions[3].stem)
    finishQuestion(questionPart(draft, 4, 1))
    const set = await run
    expect(set.passage).toEqual(draft.passage.map(p => p.id === 'p2' ? { ...p, translation } : p))
    expect(mocks.chat.mock.calls[8][0][1].content).toContain('上轮问题')
    expect(mocks.chat.mock.calls[8][0][1].content).toContain(translation)
    expect(mocks.saveTrainingSet).toHaveBeenCalledOnce()
  })

  it('rejects a translation repair that returns a different paragraph', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('REVISE', [{
      severity: 'error', target: 'passage.p1.translation', message: '含义有误', suggestion: '重新翻译',
    }])).mockResolvedValueOnce(JSON.stringify({ translations: [{ id: 'p2', translation: '这是返还给错误段落的译文。' }] }))
    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow('段落编号或数量')
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('regenerates and validates again after REJECT', async () => {
    mockInitialDraft()
    mocks.chat
      .mockResolvedValueOnce(validation('REJECT'))
      .mockResolvedValueOnce(articlePart())
      .mockResolvedValueOnce(questionPart(makeDraft(), 0, 3))
      .mockResolvedValueOnce(questionPart(makeDraft(), 3, 2))
      .mockResolvedValueOnce(studyPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(10)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('automatically retries a localized third-round issue and preserves the draft at the hard limit', async () => {
    const revise = validation('REVISE', [{ severity: 'error', target: 'q2', message: '证据不足', suggestion: '修订题目' }])
    mockInitialDraft()
    mocks.chat
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(questionPart(makeDraft(), 1, 1))
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(questionPart(makeDraft(), 1, 1))
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(questionPart(makeDraft(), 1, 1))
      .mockResolvedValueOnce(revise)

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toMatchObject({ pending: { report: { decision: 'REVISE', attempt: 4 } } })
    expect(mocks.chat).toHaveBeenCalledTimes(11)
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
    const pending = mocks.savePendingRevision.mock.lastCall![0]
    mocks.chat.mockClear().mockResolvedValueOnce(questionPart(makeDraft(), 1, 1)).mockResolvedValueOnce(validation('PASS'))
    const set = await createValidatedTraining(DEFAULT_CONFIG, progress, undefined, pending)
    expect(set.id).toBe(pending.id)
    expect(set.validation.attempt).toBe(5)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
  })

  it('does not retry a timed-out model request', async () => {
    mocks.chat.mockRejectedValueOnce(new Error('MiniMax 在 10 分钟内仍未返回'))

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow('10 分钟')
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('ignores a late response after cancellation', async () => {
    let cancelled = false
    mocks.chat.mockImplementationOnce(async () => {
      cancelled = true
      return articlePart()
    })

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress, () => cancelled)).rejects.toBeInstanceOf(GenerationCancelledError)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('surfaces a local persistence failure without another model call', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('PASS'))
    mocks.saveTrainingSet.mockRejectedValueOnce(new Error('IndexedDB quota exceeded'))

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow('quota exceeded')
    expect(mocks.chat).toHaveBeenCalledTimes(5)
  })
})

describe('generation quality gates', () => {
  it('does not save when a PASS report still contains an error issue', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('PASS', [{
      severity: 'error', target: 'q2', message: '存在两个合理答案', suggestion: '重写选项',
    }]))

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow()

    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('does not save duplicate question IDs', async () => {
    const draft = makeDraft()
    draft.questions[1].id = draft.questions[0].id
    mockInitialDraft(draft)
    mocks.chat.mockResolvedValueOnce(validation('PASS'))

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow()

    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('does not save a question with an empty option', async () => {
    const draft = makeDraft()
    draft.questions[0].options.B = ''
    mockInitialDraft(draft)
    mocks.chat.mockResolvedValueOnce(validation('PASS'))

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow()

    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
  })

  it('requires a repair for a missing quote even if the independent audit passes', async () => {
    const broken = makeDraft()
    broken.questions[0].evidence.quote = 'This exact quote does not occur in the passage.'
    mockInitialDraft(broken)
    mocks.chat
      .mockResolvedValueOnce(validation('PASS'))
      .mockResolvedValueOnce(questionPart(makeDraft(), 0, 1))
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(7)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('keeps the valid study entries up to their caps without a format-repair request', async () => {
    const draft = makeDraft()
    draft.complexSentences = Array.from({ length: 6 }, (_, i) => ({
      ...draft.complexSentences[0], structure: `单句结构分析编号 ${i}`,
    }))
    mockInitialDraft(draft)
    mocks.chat.mockResolvedValueOnce(validation('PASS'))
    const result = await createValidatedTraining(DEFAULT_CONFIG, progress)
    expect(result.complexSentences).toEqual(draft.complexSentences.slice(0, 5))
    expect(mocks.chat).toHaveBeenCalledTimes(5)
  })

  it('includes a duplicate found across batches in the first audit round', async () => {
    const draft = makeDraft()
    draft.questions[3] = { ...draft.questions[0], id: 'q4' }
    mockInitialDraft(draft)
    mocks.chat.mockResolvedValueOnce(validation('PASS')).mockResolvedValueOnce(questionPart(makeDraft(), 3, 1))
      .mockResolvedValueOnce(validation('PASS'))
    const set = await createValidatedTraining(DEFAULT_CONFIG, progress)
    expect(mocks.chat).toHaveBeenCalledTimes(7)
    expect(set.questions[3].stem).not.toBe(set.questions[0].stem)
    expect(set.validation.attempt).toBe(2)
  })

  it('revises vocabulary whose word form is absent from its quoted source sentence', async () => {
    const broken = makeDraft()
    broken.vocabulary[0].word = 'canonical'
    mockInitialDraft(broken)
    mocks.chat
      .mockResolvedValueOnce(validation('REVISE', [{ target: 'q2.evidence', severity: 'error', message: '证据对应有误', suggestion: '改正引文' }]))
      .mockResolvedValueOnce(questionPart(makeDraft(), 1, 1))
      .mockResolvedValueOnce(studyPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(String(mocks.chat.mock.calls[5][0][1].content)).toContain('题目修订 Agent')
    expect(String(mocks.chat.mock.calls[6][0][1].content)).toContain('学习资料修订 Agent')
    expect(mocks.chat).toHaveBeenCalledTimes(8)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('recovers the unique complete source sentence before the first independent audit', async () => {
    const draft = makeDraft()
    draft.vocabulary[0].sentence = draft.passage[1].text
    mockInitialDraft(draft)
    mocks.chat.mockResolvedValueOnce(validation('PASS'))
    const set = await createValidatedTraining(DEFAULT_CONFIG, progress)
    expect(set.vocabulary[0].sentence).toBe(draft.passage[0].text)
    expect(mocks.chat).toHaveBeenCalledTimes(5)
  })
})
