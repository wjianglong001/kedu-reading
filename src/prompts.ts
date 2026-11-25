import type { GeneratedArticleDraft, GeneratedQuestionsDraft, GeneratedStudyDraft } from './schemas'
import type { Attempt, TrainingConfig, TrainingSet, ValidationIssue, ValidationReport } from './types'

const jsonOnly = '只输出一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加 JSON 之外的文字。'

export function articleGenerationPrompt(config: TrainingConfig): string {
  return `你是考研英语阅读文章写作专家。只生成本轮训练的文章，不生成题目、词汇表或长难句分析。

配置：
- 难度：${config.difficulty}
- 主题：${config.topic}
- 正文篇幅档位：${config.passageLength}
- 具体词数：不要机械追求固定词数；在符合“${config.passageLength}”篇幅体感的前提下，根据难度、论证结构和支撑 ${config.questionCount} 道高质量题目所需的材料量自主决定
- 生僻词密度：${config.rareWordDensity}
- 长难句密度：${config.complexSentenceDensity}

要求：
1. 文章必须逻辑完整、事实自洽，不虚构精确统计或真实机构背书。基础难度侧重清晰论证；考研常规应贴近真题的信息密度与抽象程度；冲刺难度提高概念、逻辑和语言密度，而不是单纯拉长篇幅。
2. 正文分成 4-6 段，每段 id 使用 p1、p2……，同时给出自然准确的中文翻译。每段必须同时输出 sentences 数组：每项是一句完整英文且不含首尾空白；用一个空格连接所有 sentences 后，必须能还原 text（忽略连续空白差异）。句界应在写作时确定，不能事后按句点猜测。
3. 文章应留出足够明确的论证、转折和证据，使后续 Agent 能命制 ${config.questionCount} 道高质量题目，重点倾向“${config.focus}”。

JSON 结构：
{"title":"...","passage":[{"id":"p1","text":"...","sentences":["Sentence one.","Sentence two."],"translation":"..."}]}

${jsonOnly}`
}

export function questionGenerationPrompt(
  article: GeneratedArticleDraft,
  config: TrainingConfig,
  startIndex: number,
  count: number,
  existing: GeneratedQuestionsDraft['questions'] = [],
): string {
  const ids = Array.from({ length: count }, (_, index) => `q${startIndex + index}`)
  return `你是考研英语阅读命题专家。文章已经定稿，只根据原文生成题目，不改写文章，不生成词汇表。

整套题量 ${config.questionCount}；本批只生成 ${count} 题，id 必须依次且仅为 ${ids.join('、')}；难度 ${config.difficulty}；重点 ${config.focus}。
文章：${JSON.stringify(article)}
${existing.length ? `已经生成的其他题目（不得重复考点或选项逻辑）：${JSON.stringify(existing)}` : ''}

要求：
1. 本批生成恰好 ${count} 道四选一题，不能少题；题干和选项均为英文；整套最终覆盖主旨、细节、推理、词义、态度并服从重点配置。
2. 每题只有一个无歧义正确答案。先深度推理正确答案和干扰项，再写最终 JSON。
3. evidence.paragraphId 必须存在；evidence.quote 必须逐字出现在对应 text 中；rationale、explanation、distractorAnalysis 使用中文。distractorAnalysis 必须分析每个错误选项；正确选项可省略，由本地使用 explanation 补齐。
4. 干扰项应有迷惑性，但必须能被原文明确排除；题目 id 依次为 q1、q2……。

JSON 结构（最外层必须是对象，禁止直接输出 questions 数组）：
{"questions":[{"id":"q1","kind":"main_idea|detail|inference|vocabulary|attitude","stem":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correctAnswer":"A|B|C|D","evidence":{"paragraphId":"p1","quote":"...","rationale":"..."},"explanation":"...","distractorAnalysis":{"A":"...","B":"...","C":"...","D":"..."}}]}
${jsonOnly}`
}

export function studyGenerationPrompt(article: GeneratedArticleDraft, config: TrainingConfig): string {
  return `你是考研英语阅读学习资料编辑。文章已经定稿，只生成词汇和长难句资料，不生成或修改题目。

配置：难度 ${config.difficulty}；生僻词密度 ${config.rareWordDensity}；长难句密度 ${config.complexSentenceDensity}。
文章：${JSON.stringify(article)}

要求：
1. 提取 6-12 个值得学习的词。word 必须使用文章中实际出现的完整词形，且必须逐字出现在 sentence 中（忽略大小写）；不得用原文未出现的派生词、词性变化或词形还原替代。
2. 每个词条的 sentence 必须从文章 sentences 数组中逐字选取一整句，不得改写或另造例句；释义使用中文并符合该句语境。
3. 提取 2-4 个原文长难句，sentence 同样必须逐字来自文章，并给出中文结构分析与翻译。
JSON 结构：
{"vocabulary":[{"word":"...","phonetic":"...","meaning":"...","sentence":"..."}],"complexSentences":[{"sentence":"...","structure":"...","translation":"..."}]}
${jsonOnly}`
}

function relevantIssues(issues: ValidationIssue[], pattern: RegExp) {
  return issues.filter((issue) => pattern.test(`${issue.target} ${issue.message}`))
}

export function questionRevisionPrompt(
  article: GeneratedArticleDraft,
  current: GeneratedQuestionsDraft['questions'],
  report: ValidationReport,
  config: TrainingConfig,
) {
  const issues = relevantIssues(report.issues, /q\d|question|题|option|answer|evidence|选项|答案|证据/i)
  const ids = current.map(({ id }) => id)
  return `你是考研英语题目修订 Agent。保持文章不变，只修订本批题目并输出完整 questions。
文章：${JSON.stringify(article)}
当前批次：${JSON.stringify(current)}
审校问题：${JSON.stringify(issues.length ? issues : report.issues)}
修订后必须仍为 ${current.length} 题，id 依次且仅为 ${ids.join('、')}；整套题量为 ${config.questionCount}；证据逐字存在、答案唯一。
输出结构与题目生成阶段完全相同。${jsonOnly}`
}

export function studyRevisionPrompt(
  article: GeneratedArticleDraft,
  current: GeneratedStudyDraft,
  report: ValidationReport,
) {
  const issues = relevantIssues(report.issues, /vocabulary|complex|word|词汇|单词|长难句|翻译/i)
  return `你是学习资料修订 Agent。保持文章不变，只修订词汇和长难句资料。
文章：${JSON.stringify(article)}
当前资料：${JSON.stringify(current)}
审校问题：${JSON.stringify(issues.length ? issues : report.issues)}
修订后的每个 vocabulary.word 必须以完全相同的词形逐字出现在原文及其 sentence 中，sentence 必须是文章 sentences 数组中的完整原句；不得用派生词、变形词或改写例句替代。
输出结构与学习资料生成阶段完全相同。${jsonOnly}`
}

export function validationPrompt(draft: unknown, config: TrainingConfig, attempt: number): string {
  return `你是独立的考研英语审校 Agent。请严格检查下方题目草稿。你没有参与生成，不能因为整体看起来合理就放行。

检查维度：文章质量和难度匹配；每段 sentences 的语义句界是否准确且连接后能还原 text；题目是否能从原文推出；唯一正确答案；引文是否逐字存在；干扰项是否有歧义；翻译、词义与长难句分析是否准确；JSON 内容是否完整；题量是否为 ${config.questionCount}。

决策规则：
- PASS：没有实质性错误，warnings 也不影响作答。
- REVISE：可以局部修正。
- REJECT：核心文章或多数题目不可用，应重写。
- issues 必须指出明确 target，例如 q2.evidence 或 passage.p3。

这是第 ${attempt} 次审校。草稿：
${JSON.stringify(draft)}

JSON 结构：{"decision":"PASS|REVISE|REJECT","summary":"中文总结","issues":[{"severity":"error|warning","target":"...","message":"...","suggestion":"..."}]}
${jsonOnly}`
}

export function reviewPrompt(set: TrainingSet, attempt: Attempt): string {
  const essentials = {
    title: set.title,
    passage: set.passage,
    questions: set.questions.map(({ id, stem, options, correctAnswer, evidence, explanation }) => ({
      id, stem, options, correctAnswer, evidence, explanation, userAnswer: attempt.answers[id] || '未作答',
    })),
    score: `${attempt.score}/${attempt.total}`,
  }
  return `你是考研阅读讲评老师。根据已经确定的标准答案和用户答案做简洁、证据导向的讲评。不得修改标准答案。summary 用中文总结最值得改进的一个阅读习惯；每题 comment 说明对错和证据，method 给出可复用的方法。

答题数据：${JSON.stringify(essentials)}

JSON 结构：{"summary":"...","reviews":[{"questionId":"q1","comment":"...","method":"..."}]}
${jsonOnly}`
}
