import { describe, expect, it } from 'vitest'
import { articleGenerationPrompt, questionGenerationPrompt, studyGenerationPrompt } from './prompts'
import { articleDraftSchema, draftSchema, questionsDraftSchema, studyDraftSchema } from './schemas'
import { DEFAULT_CONFIG } from './types'
import { makeDraft } from './test/generationFixtures'

describe('generation prompt contract', () => {
  it('shows sentences in the complete passage JSON template', () => {
    const prompt = articleGenerationPrompt(DEFAULT_CONFIG)
    expect(prompt).toContain('"passage":[{"id":"p1","text":"...","sentences":["Sentence one.","Sentence two."]')
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

  it('accepts a generated fixture that follows the sentence boundary contract', () => {
    expect(draftSchema.parse(makeDraft()).passage.every(({ sentences }) => sentences.length > 0)).toBe(true)
  })
})
