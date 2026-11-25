import { describe, expect, it } from 'vitest'
import {
  configFingerprint,
  createBaselineMatrix,
  createBaselineRepeats,
  createFullMatrix,
} from './liveTestMatrix'
import { DEFAULT_CONFIG } from './types'

describe('MiniMax live generation matrix', () => {
  it('enumerates all 12,150 user-facing configurations without duplicates', () => {
    const cases = createFullMatrix()
    expect(cases).toHaveLength(12_150)
    expect(new Set(cases.map(({ config }) => configFingerprint(config))).size).toBe(12_150)
  })

  it('enumerates all 450 combinations around the failing baseline', () => {
    const cases = createBaselineMatrix()
    expect(cases).toHaveLength(450)
    expect(new Set(cases.map(({ config }) => configFingerprint(config))).size).toBe(450)
    expect(cases.every(({ config }) => (
      config.difficulty === '考研常规'
      && config.passageLength === '标准'
      && config.questionCount === 5
    ))).toBe(true)
  })

  it('repeats the exact default config for stability sampling', () => {
    const cases = createBaselineRepeats(10)
    expect(cases).toHaveLength(10)
    expect(cases.every(({ config }) => configFingerprint(config) === configFingerprint(DEFAULT_CONFIG))).toBe(true)
    expect(new Set(cases.map(({ id }) => id)).size).toBe(10)
  })

  it('rejects invalid repeat counts', () => {
    expect(() => createBaselineRepeats(0)).toThrow('正整数')
  })
})
