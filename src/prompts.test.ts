import { describe, expect, it } from 'vitest'
import { articleGenerationPrompt, questionGenerationPrompt, studyGenerationPrompt } from './prompts'
import { articleDraftSchema, draftSchema, questionsDraftSchema, studyDraftSchema } from './schemas'
import { DEFAULT_CONFIG } from './types'
import { makeDraft } from './test/generationFixtures'
import { sourcedDraftSchemas } from './articleSources'

describe('generation prompt contract', () => {
  it('rejects an invented evidence reference even when the response also contains a quote', () => {
    const draft = makeDraft()
    const q = draft.questions[0]
    expect(sourcedDraftSchemas(draft).questions.safeParse({ questions: [{ ...q, evidence: { ...q.evidence, sourceId: 'p99.s1' } }] }).success).toBe(false)
  })
  it('rejects repeated paragraph IDs before creating the sentence reference table', () => {
    const draft = makeDraft()
    draft.passage[1].id = draft.passage[0].id
    expect(articleDraftSchema.safeParse(draft).success).toBe(false)
  })
  it('shows sentences in the complete passage JSON template', () => {
    const prompt = articleGenerationPrompt(DEFAULT_CONFIG)
    expect(prompt).toContain('"passage":[{"id":"p1","sentences":["Sentence one.","Sentence two."]')
  })

  it('keeps questions and study material in separate stage contracts', () => {
    const draft = makeDraft()
    const article = articleDraftSchema.parse(draft)
    expect(questionGenerationPrompt(article, DEFAULT_CONFIG, 1, 3)).toContain('"questions"')
    expect(questionGenerationPrompt(article, DEFAULT_CONFIG, 1, 3)).not.toContain('"vocabulary"')
    expect(studyGenerationPrompt(article, DEFAULT_CONFIG)).toContain('"vocabulary"')
    expect(studyGenerationPrompt(article, DEFAULT_CONFIG)).not.toContain('"questions"')
    expect(questionsDraftSchema.parse({ questions: draft.questions }).questions).toHaveLength(5)
    expect(studyDraftSchema.parse(draft).vocabulary.length).toBeGreaterThan(0)
  })

  it('recovers a misplaced evidence rationale but still requires a supplied reason', () => {
    const draft = makeDraft()
    const { evidence, ...question } = draft.questions[0]
    const { rationale, ...citation } = evidence
    const withQuestion = (first: unknown) => ({ questions: [first, ...draft.questions.slice(1)] })
    const flat = { ...question, evidence: citation, rationale }
    expect(questionsDraftSchema.parse(withQuestion(flat)).questions[0].evidence).toEqual(evidence)
    expect(questionsDraftSchema.safeParse(withQuestion({ ...flat, rationale: undefined })).success).toBe(false)
  })

  it('accepts a generated fixture that follows the sentence boundary contract', () => {
    expect(draftSchema.parse(makeDraft()).passage.every(({ sentences }) => sentences.length > 0)).toBe(true)
  })

  it('builds reader text from the supplied sentences, preserving abbreviations and sentence boundaries', () => {
    const sentences = ['Dr. Park studies how students learn.', 'Her class meets at 8 a.m.']
    const draft = makeDraft()
    const passage = draft.passage.map(({ id, translation }) => ({ id, translation, sentences }))
    const article = articleDraftSchema.parse({ title: draft.title, passage })
    expect(article.passage[0]).toEqual({ ...passage[0], text: sentences.join(' ') })
  })
})
