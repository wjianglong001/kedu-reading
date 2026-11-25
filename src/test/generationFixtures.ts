import type { GeneratedDraft } from '../schemas'
import type { ValidationReport } from '../types'

const paragraphTexts = [
  'Public institutions often adopt new technology before citizens have agreed on how its risks should be distributed fairly.',
  'Supporters argue that careful experimentation can improve access, while critics warn that efficiency may hide unequal consequences.',
  'A durable policy therefore needs transparent evidence, public revision, and a willingness to correct confident early assumptions.',
]

export function makeDraft(questionCount = 5): GeneratedDraft {
  return {
    title: 'Technology and Public Judgment',
    passage: paragraphTexts.map((text, index) => ({
      id: `p${index + 1}`,
      text,
      sentences: [text],
      translation: `这是用于测试的第 ${index + 1} 段中文翻译，长度满足数据契约要求。`,
    })),
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: `q${index + 1}`,
      kind: index === 0 ? 'main_idea' : index === 1 ? 'detail' : index === 2 ? 'inference' : index === 3 ? 'vocabulary' : 'attitude',
      stem: `What can reasonably be concluded from test question ${index + 1}?`,
      options: {
        A: `Supported answer ${index + 1}`,
        B: `Distractor based on exaggeration ${index + 1}`,
        C: `Distractor reversing the relation ${index + 1}`,
        D: `Distractor outside the passage ${index + 1}`,
      },
      correctAnswer: 'A',
      evidence: {
        paragraphId: `p${(index % 3) + 1}`,
        quote: paragraphTexts[index % 3].slice(0, 34),
        rationale: 'The quoted sentence directly supports the answer and excludes the distractors.',
      },
      explanation: 'The correct option follows the scope and logic of the cited sentence.',
      distractorAnalysis: {
        A: 'This is the supported answer.',
        B: 'This option exaggerates the claim.',
        C: 'This option reverses the relation.',
        D: 'This option is outside the passage.',
      },
    })) as GeneratedDraft['questions'],
    vocabulary: [
      { word: 'institutions', phonetic: '/ˌɪnstɪˈtjuːʃənz/', meaning: '机构', sentence: paragraphTexts[0] },
      { word: 'distributed', phonetic: '/dɪˈstrɪbjuːtɪd/', meaning: '分配', sentence: paragraphTexts[0] },
      { word: 'experimentation', phonetic: '/ɪkˌsperɪmenˈteɪʃən/', meaning: '试验', sentence: paragraphTexts[1] },
      { word: 'consequences', phonetic: '/ˈkɒnsɪkwensɪz/', meaning: '后果', sentence: paragraphTexts[1] },
      { word: 'assumptions', phonetic: '/əˈsʌmpʃənz/', meaning: '假设', sentence: paragraphTexts[2] },
    ],
    complexSentences: [{
      sentence: paragraphTexts[2],
      structure: '主句并列多个名词短语，后接不定式作后置修饰。',
      translation: '持久的政策需要透明证据、公开修订以及纠正早期判断的意愿。',
    }],
  }
}

export function validation(decision: ValidationReport['decision'], issues: ValidationReport['issues'] = []) {
  return JSON.stringify({
    decision,
    summary: decision === 'PASS' ? '全部检查通过' : '需要继续修订内容',
    issues,
  })
}
