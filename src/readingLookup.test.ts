import { describe, expect, it } from 'vitest'
import { buildChatRequest } from './minimax'
import { annotationAnchor, LookupRequestGate, normalizeAnnotationText, passageSentences, splitEnglishSentences, tokenizeEnglish } from './readingLookup'
import { readingLookupSchema } from './schemas'

describe('reading annotation helpers', () => {
  it('tokenizes words while preserving punctuation and spaces', () => {
    expect(tokenizeEnglish("Policy-makers don't agree.")).toEqual([
      { text: 'Policy', isWord: true },
      { text: '-', isWord: false },
      { text: 'makers', isWord: true },
      { text: ' ', isWord: false },
      { text: "don't", isWord: true },
      { text: ' ', isWord: false },
      { text: 'agree', isWord: true },
      { text: '.', isWord: false },
    ])
  })

  it('splits tappable sentences without dropping punctuation', () => {
    expect(splitEnglishSentences('One claim matters. Does it hold? Yes!')).toEqual([
      'One claim matters. ',
      'Does it hold? ',
      'Yes!',
    ])
  })

  it('keeps abbreviations, decimals and closing quotes in their sentences', () => {
    expect(splitEnglishSentences('The U.S. economy grew 2.5 percent. Dr. Lee disagreed. E.g. this matters. “Really?” she asked.')).toEqual([
      'The U.S. economy grew 2.5 percent. ',
      'Dr. Lee disagreed. ',
      'E.g. this matters. ',
      '“Really?” ',
      'she asked.',
    ])
  })

  it('treats abbreviation periods as boundaries when a new sentence follows', () => {
    expect(splitEnglishSentences('It changed policy in the U.S. Markets reacted.')).toEqual([
      'It changed policy in the U.S. ',
      'Markets reacted.',
    ])
    expect(splitEnglishSentences('Several tools failed, etc. Recovery followed.')).toEqual([
      'Several tools failed, etc. ',
      'Recovery followed.',
    ])
    expect(splitEnglishSentences('The note ended with “i.e.” A new point followed.')).toEqual([
      'The note ended with “i.e.” ',
      'A new point followed.',
    ])
    expect(splitEnglishSentences('The note ended with “e.g.” Another point followed.')).toEqual([
      'The note ended with “e.g.” ',
      'Another point followed.',
    ])
  })

  it('does not split abbreviations from same-sentence proper names or examples', () => {
    expect(splitEnglishSentences('The U.S. Federal Reserve raised rates.')).toEqual([
      'The U.S. Federal Reserve raised rates.',
    ])
    expect(splitEnglishSentences('The U.S. Congress passed the bill.')).toEqual([
      'The U.S. Congress passed the bill.',
    ])
    expect(splitEnglishSentences('Several firms, e.g. Apple and Microsoft, responded.')).toEqual([
      'Several firms, e.g. Apple and Microsoft, responded.',
    ])
    expect(splitEnglishSentences('One field, i.e. English literature, was excluded.')).toEqual([
      'One field, i.e. English literature, was excluded.',
    ])
  })

  it('uses generated semantic sentence boundaries instead of guessing ambiguous punctuation', () => {
    expect(passageSentences({
      text: 'The largest market is the U.S. Investors reacted.',
      sentences: ['The largest market is the U.S.', 'Investors reacted.'],
    })).toEqual(['The largest market is the U.S.', 'Investors reacted.'])
    expect(passageSentences({
      text: 'The U.S. Federal Reserve raised rates.',
      sentences: ['The U.S. Federal Reserve raised rates.'],
    })).toEqual(['The U.S. Federal Reserve raised rates.'])
  })

  it('normalizes case, whitespace and surrounding punctuation for deduplication', () => {
    expect(normalizeAnnotationText('  “Consequently,”  ')).toBe('consequently')
  })

  it('accepts a compact word or sentence explanation', () => {
    expect(readingLookupSchema.parse({ meaning: '因此', explanation: '在这里表示结果关系。' }).meaning).toBe('因此')
  })

  it('can disable explicit thinking for a dictionary lookup', () => {
    const body = buildChatRequest([{ role: 'user', content: 'lookup' }], 1024, { thinking: 'disabled', temperature: 0.2 })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.temperature).toBe(0.2)
  })

  it('gives repeated words in one paragraph distinct occurrence anchors', () => {
    expect(annotationAnchor('p1', 'word', 0, 2)).not.toBe(annotationAnchor('p1', 'word', 1, 2))
    expect(annotationAnchor('p1', 'sentence', 0)).not.toBe(annotationAnchor('p1', 'sentence', 1))
  })

  it('invalidates late responses when a newer lookup starts or the sheet closes', () => {
    const gate = new LookupRequestGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
    gate.invalidate()
    expect(gate.isCurrent(second)).toBe(false)
  })
})
