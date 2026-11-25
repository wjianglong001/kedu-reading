import Dexie, { type EntityTable } from 'dexie'
import type { Attempt, ReadingAnnotation, TrainingSet, VocabularyItem } from './types'

class KeduDatabase extends Dexie {
  trainingSets!: EntityTable<TrainingSet, 'id'>
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
  }
}

export const db = new KeduDatabase()

export async function saveTrainingSet(set: TrainingSet) {
  await db.transaction('rw', db.trainingSets, db.vocabulary, async () => {
    await db.trainingSets.put(set)
    await db.vocabulary.bulkPut(set.vocabulary)
  })
}

export async function clearLocalLearningData() {
  await db.transaction('rw', db.trainingSets, db.attempts, db.vocabulary, db.readingAnnotations, async () => {
    await Promise.all([db.trainingSets.clear(), db.attempts.clear(), db.vocabulary.clear(), db.readingAnnotations.clear()])
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
