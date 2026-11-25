import { z } from 'zod'

const optionKey = z.enum(['A', 'B', 'C', 'D'])
const nonEmptyText = z.string().trim().min(1)
const options = z.object({ A: nonEmptyText, B: nonEmptyText, C: nonEmptyText, D: nonEmptyText })
const optionalOptions = z.object({
  A: nonEmptyText.optional(), B: nonEmptyText.optional(), C: nonEmptyText.optional(), D: nonEmptyText.optional(),
})

export const articleDraftSchema = z.object({
  title: z.string().min(3),
  passage: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(30),
    sentences: z.array(z.string().trim().min(1)).min(1),
    translation: z.string().min(10),
  })).min(3),
})

export const generatedQuestionSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(['main_idea', 'detail', 'inference', 'vocabulary', 'attitude']),
    stem: z.string().min(8),
    options,
    correctAnswer: optionKey,
    evidence: z.object({
      paragraphId: z.string(),
      quote: z.string().min(4),
      rationale: z.string().min(8),
    }),
    explanation: z.string().min(8),
    distractorAnalysis: optionalOptions,
}).superRefine((question, context) => {
  for (const key of optionKey.options) {
    if (key !== question.correctAnswer && !question.distractorAnalysis[key]) {
      context.addIssue({
        code: 'custom',
        path: ['distractorAnalysis', key],
        message: '错误选项必须提供排除分析',
      })
    }
  }
}).transform((question) => ({
  ...question,
  distractorAnalysis: Object.fromEntries(optionKey.options.map((key) => [
    key,
    question.distractorAnalysis[key] || `该选项是正确答案：${question.explanation}`,
  ])) as Record<'A' | 'B' | 'C' | 'D', string>,
}))

export const questionBatchSchema = z.preprocess(
  (value) => Array.isArray(value) ? { questions: value } : value,
  z.object({ questions: z.array(generatedQuestionSchema).min(1).max(3) }),
)

export const questionsDraftSchema = z.object({
  questions: z.array(generatedQuestionSchema).min(4).max(6),
})

const vocabularyDraftItemSchema = z.object({
  word: z.string().min(2),
  phonetic: z.string().optional(),
  meaning: z.string().min(2),
  sentence: z.string().min(8),
})

const complexSentenceDraftItemSchema = z.object({
  sentence: z.string().min(15),
  structure: z.string().min(5),
  translation: z.string().min(5),
})

export const studyDraftSchema = z.object({
  vocabulary: z.preprocess(
    (value) => Array.isArray(value) ? value.filter((item) => vocabularyDraftItemSchema.safeParse(item).success) : value,
    z.array(vocabularyDraftItemSchema).min(5).max(16),
  ),
  complexSentences: z.preprocess(
    (value) => Array.isArray(value) ? value.filter((item) => complexSentenceDraftItemSchema.safeParse(item).success) : value,
    z.array(complexSentenceDraftItemSchema).min(1).max(5),
  ),
})

export const draftSchema = articleDraftSchema.extend({
  questions: questionsDraftSchema.shape.questions,
  vocabulary: studyDraftSchema.shape.vocabulary,
  complexSentences: studyDraftSchema.shape.complexSentences,
})

export const validationSchema = z.object({
  decision: z.enum(['PASS', 'REVISE', 'REJECT']),
  summary: z.string().min(4),
  issues: z.array(z.object({
    severity: z.enum(['error', 'warning']),
    target: z.string(),
    message: z.string(),
    suggestion: z.string(),
  })),
})

export const reviewSchema = z.object({
  summary: z.string().min(5),
  reviews: z.array(z.object({
    questionId: z.string(),
    comment: z.string(),
    method: z.string(),
  })),
})

export const readingLookupSchema = z.object({
  meaning: z.string().trim().min(1),
  explanation: z.string().trim().min(2),
  phonetic: z.string().trim().optional(),
  label: z.string().trim().optional(),
})

export type GeneratedDraft = z.infer<typeof draftSchema>
export type GeneratedArticleDraft = z.infer<typeof articleDraftSchema>
export type GeneratedQuestionsDraft = z.infer<typeof questionsDraftSchema>
export type GeneratedQuestionBatch = z.infer<typeof questionBatchSchema>
export type GeneratedStudyDraft = z.infer<typeof studyDraftSchema>
