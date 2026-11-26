import { z } from 'zod'
import { questionBatchSchema, studyDraftSchema, type GeneratedArticleDraft } from './schemas'

export function articleSources(article: GeneratedArticleDraft) {
  return article.passage.flatMap(({ id, sentences }) => sentences.map((text, i) => ({
    sourceId: `${id}.s${i + 1}`, paragraphId: id, text,
  })))
}

// Resolve references before the normal schemas run. Persist and audit the
// original English, so older saved drafts and the reader use the same format.
export function sourcedDraftSchemas(article: GeneratedArticleDraft) {
  const sources = new Map(articleSources(article).map(source => [source.sourceId, source]))
  const sourceFields = z.object({ sourceId: z.string().optional() }).passthrough()
    .transform((value, context) => {
      if (value.sourceId === undefined) return value
      const source = sources.get(value.sourceId)
      if (!source) {
        context.addIssue({ code: 'custom', message: `未知原句编号 ${value.sourceId}，可选编号：${Array.from(sources.keys()).join('、')}` })
        return z.NEVER
      }
      return { ...value, paragraphId: source.paragraphId, quote: source.text, sentence: source.text }
    })
  const question = z.object({ evidence: sourceFields }).passthrough()
  const questions: z.ZodType<z.input<typeof questionBatchSchema>> = z.preprocess(
    raw => Array.isArray(raw) ? { questions: raw } : raw, z.object({ questions: z.array(question) }))
  const study: z.ZodType<z.input<typeof studyDraftSchema>> = z.object({
    vocabulary: z.array(sourceFields), complexSentences: z.array(sourceFields),
  })
  return { questions: questions.pipe(questionBatchSchema), study: study.pipe(studyDraftSchema) }
}
