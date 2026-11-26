export type Difficulty = '基础' | '考研常规' | '冲刺'
export type Topic = '社会与文化' | '科技与伦理' | '教育与成长' | '经济与商业' | '自然与环境'
export type PassageLength = '短篇' | '标准' | '长篇'
export type Focus = '综合' | '主旨' | '推理' | '词义' | '态度'
export type Density = '少' | '适中' | '多'

export interface TrainingConfig {
  difficulty: Difficulty
  topic: Topic
  passageLength: PassageLength
  questionCount: 4 | 5 | 6
  focus: Focus
  rareWordDensity: Density
  complexSentenceDensity: Density
  timed: boolean
}

export interface PassageParagraph {
  id: string
  text: string
  /** Stable sentence boundaries produced with the passage. Legacy saved sets may omit this. */
  sentences?: string[]
  translation: string
}

export type QuestionKind = 'main_idea' | 'detail' | 'inference' | 'vocabulary' | 'attitude'

export interface Question {
  id: string
  kind: QuestionKind
  stem: string
  options: Record<'A' | 'B' | 'C' | 'D', string>
  correctAnswer: 'A' | 'B' | 'C' | 'D'
  evidence: {
    paragraphId: string
    quote: string
    rationale: string
  }
  explanation: string
  distractorAnalysis: Record<'A' | 'B' | 'C' | 'D', string>
}

export interface VocabularyItem {
  id: string
  word: string
  phonetic?: string
  meaning: string
  sentence: string
  sourceSetId?: string
  status: 'new' | 'learning' | 'mastered'
  createdAt: string
}

export interface ReadingAnnotation {
  id: string
  setId: string
  paragraphId: string
  anchor: string
  kind: 'word' | 'sentence'
  text: string
  normalizedText: string
  meaning: string
  explanation: string
  contextSentence: string
  phonetic?: string
  label?: string
  createdAt: string
}

export interface ComplexSentence {
  sentence: string
  structure: string
  translation: string
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  target: string
  message: string
  suggestion: string
  replacement?: string
}

export interface ValidationReport {
  decision: 'PASS' | 'REVISE' | 'REJECT'
  summary: string
  issues: ValidationIssue[]
  checkedAt: string
  attempt: number
}

export interface PendingRevision {
  id: string
  config: TrainingConfig
  draft: import('./schemas').GeneratedDraft
  report: ValidationReport
}

export interface TrainingSet {
  id: string
  title: string
  passage: PassageParagraph[]
  questions: Question[]
  vocabulary: VocabularyItem[]
  complexSentences: ComplexSentence[]
  config: TrainingConfig
  validation: ValidationReport
  createdAt: string
}

export interface ReviewQuestion {
  questionId: string
  comment: string
  method: string
}

export interface Attempt {
  id: string
  setId: string
  answers: Record<string, string>
  score: number
  total: number
  durationSeconds: number
  completedAt: string
  aiSummary?: string
  aiReviews?: ReviewQuestion[]
}

export interface GenerationProgress {
  stage: 'article' | 'questions' | 'validating' | 'revising' | 'saving'
  label: string
  detail: string
  validationAttempt: number
}

export const DEFAULT_CONFIG: TrainingConfig = {
  difficulty: '考研常规',
  topic: '社会与文化',
  passageLength: '标准',
  questionCount: 5,
  focus: '综合',
  rareWordDensity: '适中',
  complexSentenceDensity: '适中',
  timed: false,
}
