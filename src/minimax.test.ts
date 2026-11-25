import { describe, expect, it } from 'vitest'
import { buildChatRequest, extractChatContent, extractJson, MINIMAX_MAX_COMPLETION_TOKENS, MINIMAX_READ_TIMEOUT_MS } from './minimax'
import { draftSchema, questionBatchSchema, studyDraftSchema, validationSchema } from './schemas'
import { createValidatedTraining, GenerationCancelledError } from './agentOrchestrator'
import { DEFAULT_CONFIG } from './types'
import { makeDraft } from './test/generationFixtures'

describe('MiniMax response parsing', () => {
  it('uses a currently supported thinking mode', () => {
    const body = buildChatRequest([{ role: 'user', content: 'test' }], 1024)
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('allows long-running structured generation requests', () => {
    expect(MINIMAX_READ_TIMEOUT_MS).toBe(600_000)
    expect(MINIMAX_MAX_COMPLETION_TOKENS).toBe(32_768)
  })

  it('reports token truncation instead of treating partial JSON as usable', () => {
    expect(() => extractChatContent({
      choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }],
    }, 32_768)).toThrow('达到 32768 Token 上限')
  })

  it('distinguishes reasoning-only responses from an empty transport response', () => {
    expect(() => extractChatContent({
      choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'long reasoning' } }],
    }, 32_768)).toThrow('思考过程耗尽')
  })

  it('extracts JSON from a fenced response', () => {
    expect(extractJson('```json\n{"decision":"PASS"}\n```')).toEqual({ decision: 'PASS' })
  })

  it('extracts the first complete object from explanatory text', () => {
    expect(extractJson('result follows: {"value":2} end')).toEqual({ value: 2 })
  })

  it('repairs a missing comma between array elements locally', () => {
    expect(extractJson('{"items":[{"id":1} {"id":2}]}')).toEqual({ items: [{ id: 1 }, { id: 2 }] })
  })

  it('repairs truncated closing brackets locally', () => {
    expect(extractJson('{"items":[{"id":1}')).toEqual({ items: [{ id: 1 }] })
  })
})

describe('agent schemas', () => {
  it('accepts a valid validation decision', () => {
    expect(validationSchema.parse({ decision: 'PASS', summary: '检查通过', issues: [] }).decision).toBe('PASS')
  })

  it('rejects a draft with fewer than four questions', () => {
    expect(() => draftSchema.parse({ title: 'A valid title', passage: [], questions: [], vocabulary: [], complexSentences: [] })).toThrow()
  })

  it('normalizes a bare question array into the required batch object', () => {
    const questions = makeDraft().questions.slice(0, 3)
    expect(questionBatchSchema.parse(questions).questions).toHaveLength(3)
  })

  it('fills the correct option analysis but still requires every wrong-option analysis', () => {
    const allowed = makeDraft()
    delete (allowed.questions[0].distractorAnalysis as Partial<typeof allowed.questions[0]['distractorAnalysis']>).A
    expect(draftSchema.parse(allowed).questions[0].distractorAnalysis.A).toContain('正确答案')

    const rejected = makeDraft()
    delete (rejected.questions[0].distractorAnalysis as Partial<typeof rejected.questions[0]['distractorAnalysis']>).B
    expect(() => draftSchema.parse(rejected)).toThrow('错误选项必须提供排除分析')
  })

  it('drops an incomplete extra vocabulary item without discarding enough usable study content', () => {
    const draft = makeDraft()
    const result = studyDraftSchema.parse({
      vocabulary: [...draft.vocabulary, { word: 'broken', meaning: '', sentence: '' }],
      complexSentences: draft.complexSentences,
    })

    expect(result.vocabulary).toHaveLength(5)
    expect(result.vocabulary.every(({ meaning, sentence }) => meaning.length >= 2 && sentence.length >= 8)).toBe(true)
  })

  it('still rejects study content when fewer than five usable vocabulary items remain', () => {
    const draft = makeDraft()
    expect(() => studyDraftSchema.parse({
      vocabulary: [...draft.vocabulary.slice(0, 4), { word: 'broken', meaning: '', sentence: '' }],
      complexSentences: draft.complexSentences,
    })).toThrow()
  })
})

describe('generation cancellation', () => {
  it('stops before issuing a model request when already cancelled', async () => {
    await expect(createValidatedTraining(DEFAULT_CONFIG, () => undefined, () => true)).rejects.toBeInstanceOf(GenerationCancelledError)
  })
})
