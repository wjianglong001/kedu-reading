import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from './types'
import { makeDraft, validation } from './test/generationFixtures'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  saveTrainingSet: vi.fn(),
}))

vi.mock('./minimax', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./minimax')>()
  return { ...actual, chat: mocks.chat }
})

vi.mock('./db', () => ({ saveTrainingSet: mocks.saveTrainingSet }))

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
  mocks.saveTrainingSet.mockReset().mockResolvedValue(undefined)
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
    expect(progress.mock.calls.map(([item]) => item.stage)).toEqual(['article', 'questions', 'study', 'validating', 'saving'])
  })

  it('gives the validation Agent the full output budget while keeping adaptive reasoning', async () => {
    mockInitialDraft()
    mocks.chat.mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    const validationCall = mocks.chat.mock.calls[4]
    expect(validationCall[1]).toBe(32_768)
    expect(validationCall[2]).toMatchObject({ thinking: 'adaptive', temperature: 0.2 })
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
      .mockResolvedValueOnce(validation('REVISE', [{ severity: 'error', target: 'q2', message: '证据不足', suggestion: '修订题目' }]))
      .mockResolvedValueOnce(questionPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(7)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
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

  it('stops after three failed validation rounds', async () => {
    const revise = validation('REVISE', [{ severity: 'error', target: 'q2', message: '证据不足', suggestion: '修订题目' }])
    mockInitialDraft()
    mocks.chat
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(questionPart())
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(questionPart())
      .mockResolvedValueOnce(revise)

    await expect(createValidatedTraining(DEFAULT_CONFIG, progress)).rejects.toThrow('三次审校后仍未通过')
    expect(mocks.chat).toHaveBeenCalledTimes(9)
    expect(mocks.saveTrainingSet).not.toHaveBeenCalled()
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

  it('overrides AI PASS when the evidence quote is absent from the passage', async () => {
    const broken = makeDraft()
    broken.questions[0].evidence.quote = 'This exact quote does not occur in the passage.'
    mockInitialDraft(broken)
    mocks.chat
      .mockResolvedValueOnce(validation('PASS'))
      .mockResolvedValueOnce(questionPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(mocks.chat).toHaveBeenCalledTimes(7)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })

  it('revises vocabulary whose word form is absent from its quoted source sentence', async () => {
    const broken = makeDraft()
    broken.vocabulary[0].word = 'canonical'
    mockInitialDraft(broken)
    mocks.chat
      .mockResolvedValueOnce(validation('PASS'))
      .mockResolvedValueOnce(studyPart())
      .mockResolvedValueOnce(validation('PASS'))

    await createValidatedTraining(DEFAULT_CONFIG, progress)

    expect(String(mocks.chat.mock.calls[5][0][1].content)).toContain('学习资料修订 Agent')
    expect(mocks.chat).toHaveBeenCalledTimes(7)
    expect(mocks.saveTrainingSet).toHaveBeenCalledTimes(1)
  })
})
