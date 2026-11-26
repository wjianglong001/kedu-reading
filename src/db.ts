import Dexie, { type EntityTable } from 'dexie'
import type { Attempt, PendingRevision, ReadingAnnotation, TrainingSet, VocabularyItem } from './types'

class KeduDatabase extends Dexie {
  trainingSets!: EntityTable<TrainingSet, 'id'>
  pendingRevisions!: EntityTable<PendingRevision, 'id'>
  attempts!: EntityTable<Attempt, 'id'>
  vocabulary!: EntityTable<VocabularyItem, 'id'>
  readingAnnotations!: EntityTable<ReadingAnnotation, 'id'>

  constructor() {
    super('kedu-local')
    this.version(1).stores({
      trainingSets: 'id, createdAt, validation.decision',
      attempts: 'id, setId, completedAt',
      vocabulary: 'id, word, status, createdAt, sourceSetId',
    })
    this.version(2).stores({
      trainingSets: 'id, createdAt, validation.decision',
      attempts: 'id, setId, completedAt',
      vocabulary: 'id, word, status, createdAt, sourceSetId',
      readingAnnotations: 'id, setId, [setId+kind+normalizedText], createdAt',
    })
    this.version(3).stores({
      trainingSets: 'id, createdAt, validation.decision',
      attempts: 'id, setId, completedAt',
      vocabulary: 'id, word, status, createdAt, sourceSetId',
      readingAnnotations: 'id, setId, [setId+anchor], createdAt',
    }).upgrade(async (transaction) => {
      await transaction.table<ReadingAnnotation, string>('readingAnnotations')
        .filter((annotation) => typeof annotation.anchor !== 'string' || !annotation.anchor)
        .delete()
    })
    this.version(4).stores({ pendingRevisions: 'id, report.checkedAt' })
  }
}

export const db = new KeduDatabase()

export async function saveTrainingSet(set: TrainingSet) {
  return db.transaction('rw', db.trainingSets, db.vocabulary, db.pendingRevisions, async () => {
    const existing = await db.trainingSets.get(set.id)
    if (existing) return existing
    await db.trainingSets.put(set)
    await db.vocabulary.bulkPut(set.vocabulary)
    await db.pendingRevisions.delete(set.id)
    return set
  })
}

export async function savePendingRevision(pending: PendingRevision) {
  await db.transaction('rw', db.trainingSets, db.pendingRevisions, async () => {
    if (await db.trainingSets.get(pending.id)) return
    const previous = await db.pendingRevisions.get(pending.id)
    if (!previous || previous.report.attempt <= pending.report.attempt) await db.pendingRevisions.put(pending)
  })
}

export async function clearLocalLearningData() {
  await db.transaction('rw', [db.trainingSets, db.attempts, db.vocabulary, db.readingAnnotations, db.pendingRevisions], async () => {
    await Promise.all([db.trainingSets.clear(), db.attempts.clear(), db.vocabulary.clear(), db.readingAnnotations.clear(), db.pendingRevisions.clear()])
  })
}

export function normalizeVocabularyWord(word: string) {
  return word.trim().toLocaleLowerCase('en-US')
}

export async function addVocabularyIfMissing(item: VocabularyItem): Promise<'added' | 'exists'> {
  const normalized = normalizeVocabularyWord(item.word)
  const existing = await db.vocabulary.filter((word) => normalizeVocabularyWord(word.word) === normalized).first()
  if (existing) return 'exists'
  await db.vocabulary.put(item)
  return 'added'
}
