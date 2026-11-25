import type { TrainingConfig } from './types'
import { DEFAULT_CONFIG } from './types'

export const DIFFICULTIES = ['基础', '考研常规', '冲刺'] as const
export const TOPICS = ['社会与文化', '科技与伦理', '教育与成长', '经济与商业', '自然与环境'] as const
export const PASSAGE_LENGTHS = ['短篇', '标准', '长篇'] as const
export const QUESTION_COUNTS = [4, 5, 6] as const
export const FOCUSES = ['综合', '主旨', '推理', '词义', '态度'] as const
export const DENSITIES = ['少', '适中', '多'] as const
export const TIMED_OPTIONS = [false, true] as const

export type LiveMatrixMode = 'baseline-repeat' | 'baseline-exhaustive' | 'full-exhaustive'

export interface LiveTestCase {
  id: string
  config: TrainingConfig
  repeat: number
}

function caseId(prefix: string, index: number) {
  return `${prefix}-${String(index + 1).padStart(5, '0')}`
}

/**
 * All user-facing configuration combinations: 3×5×3×3×5×3×3×2 = 12,150.
 */
export function createFullMatrix(): LiveTestCase[] {
  const cases: LiveTestCase[] = []
  for (const difficulty of DIFFICULTIES)
    for (const topic of TOPICS)
      for (const passageLength of PASSAGE_LENGTHS)
        for (const questionCount of QUESTION_COUNTS)
          for (const focus of FOCUSES)
            for (const rareWordDensity of DENSITIES)
              for (const complexSentenceDensity of DENSITIES)
                for (const timed of TIMED_OPTIONS) {
                  cases.push({
                    id: caseId('full', cases.length),
                    repeat: 1,
                    config: {
                      difficulty,
                      topic,
                      passageLength,
                      questionCount,
                      focus,
                      rareWordDensity,
                      complexSentenceDensity,
                      timed,
                    },
                  })
                }
  return cases
}

/**
 * Keeps the user's failing baseline fixed (考研常规/标准/5题), while exhaustively
 * covering every remaining setting: 5×5×3×3×2 = 450.
 */
export function createBaselineMatrix(): LiveTestCase[] {
  const cases: LiveTestCase[] = []
  for (const topic of TOPICS)
    for (const focus of FOCUSES)
      for (const rareWordDensity of DENSITIES)
        for (const complexSentenceDensity of DENSITIES)
          for (const timed of TIMED_OPTIONS) {
            cases.push({
              id: caseId('baseline', cases.length),
              repeat: 1,
              config: {
                difficulty: '考研常规',
                passageLength: '标准',
                questionCount: 5,
                topic,
                focus,
                rareWordDensity,
                complexSentenceDensity,
                timed,
              },
            })
          }
  return cases
}

/** Repeats the exact current default to measure stochastic failure rate. */
export function createBaselineRepeats(repeats = 10): LiveTestCase[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('repeats 必须是正整数')
  return Array.from({ length: repeats }, (_, index) => ({
    id: caseId('repeat', index),
    repeat: index + 1,
    config: { ...DEFAULT_CONFIG },
  }))
}

export function createLiveMatrix(mode: LiveMatrixMode, repeats = 10): LiveTestCase[] {
  if (mode === 'full-exhaustive') return createFullMatrix()
  if (mode === 'baseline-exhaustive') return createBaselineMatrix()
  return createBaselineRepeats(repeats)
}

export function configFingerprint(config: TrainingConfig): string {
  return [
    config.difficulty,
    config.topic,
    config.passageLength,
    config.questionCount,
    config.focus,
    config.rareWordDensity,
    config.complexSentenceDensity,
    config.timed,
  ].join('|')
}
