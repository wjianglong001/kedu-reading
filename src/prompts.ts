import type { GeneratedArticleDraft, GeneratedDraft, GeneratedQuestionsDraft, GeneratedStudyDraft } from './schemas'
import { articleSources } from './articleSources'
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
2. 正文分成 4-6 段，每段 id 使用 p1、p2……，同时给出自然准确的中文翻译。正文只写一次，放在 sentences 数组：每项是一句完整英文。应用会自动连接成段落，不要重复输出 text 字段。
3. 为 ${config.questionCount} 道“${config.focus}”题预留不同的论证关系或事实依据。写完逐句对照译文，核实否定、比较方向、转折和代词指向。

JSON 结构：
{"title":"...","passage":[{"id":"p1","sentences":["Sentence one.","Sentence two."],"translation":"..."}]}

${jsonOnly}`
}

export function questionGenerationPrompt(
  article: GeneratedArticleDraft,
  config: TrainingConfig,
  startIndex: number,
  count: number,
): string {
  const ids = Array.from({ length: count }, (_, index) => `q${startIndex + index}`)
  const kinds = ['主旨', '细节', '推理', '词义', '态度', '细节']
  const plan = ids.map((id, offset) => {
    const index = startIndex - 1 + offset
    const kind = config.focus === '综合' ? kinds[index] : config.focus
    const paragraph = article.passage[index % article.passage.length]
    return `${id}：${kind}，优先从 ${paragraph.id} 选取证据，可结合全文`
  })
  const passage = articleSources(article)
  return `你是考研英语阅读命题专家。文章已经定稿，只根据原文生成题目，不改写文章，不生成词汇表。

整套题量 ${config.questionCount}；本批只生成 ${count} 题，id 必须依次且仅为 ${ids.join('、')}；难度 ${config.difficulty}；重点 ${config.focus}。
本批分工：${plan.join('；')}。各题考查不同论点或论证关系。
标题：${article.title}
英文原文：${JSON.stringify(passage)}

要求：
1. 本批生成恰好 ${count} 道四选一题，不能少题；题干和选项均为英文；按本批分工命题。
2. 每题只有一个无歧义正确答案。核对正确答案和每个干扰项的依据。每个错误选项用一句中文说明与原文的具体差异；explanation 点出推理关系，避免重复原文、题干和选项。
3. 先选能直接支撑答案的原句 sourceId，再写正确选项。若引文只与话题有关，或推断需要额外假设，换证据或换题。evidence 只填 sourceId 和中文 rationale，应用按编号取原句。
4. 写完逐项回读题干与选项。若第二个选项也能由原文推出，先改选项。每条干扰项分析都要对应这个字母的实际措辞，并指出它改动了原文的哪个条件、对象或因果方向。explanation 与三条干扰项分析用中文，只输出错误选项的分析。

kind 取 main_idea、detail、inference、vocabulary 或 attitude。以下用正确答案 B 举例，实际按题填写。
JSON 结构（最外层必须是对象，禁止直接输出 questions 数组）：
{"questions":[{"id":"${ids[0]}","kind":"inference","stem":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correctAnswer":"B","evidence":{"sourceId":"${passage[0].sourceId}","rationale":"..."},"explanation":"...","distractorAnalysis":{"A":"...","C":"...","D":"..."}}]}
${jsonOnly}`
}

export function studyGenerationPrompt(article: GeneratedArticleDraft, config: TrainingConfig): string {
  return `你是考研英语阅读学习资料编辑。文章已经定稿，只生成词汇和长难句资料，不生成或修改题目。

配置：难度 ${config.difficulty}；生僻词密度 ${config.rareWordDensity}；长难句密度 ${config.complexSentenceDensity}。
标题：${article.title}
英文原句：${JSON.stringify(articleSources(article))}

要求：
1. 提取 6-12 个值得学习的词。word 必须使用文章中实际出现的完整词形，且必须逐字出现在 sentence 中（忽略大小写）；不得用原文未出现的派生词、词性变化或词形还原替代。
2. 通过 sourceId 指定含有该词形的原句，应用填入完整例句。用中文写出该词在这句话里的词义，尤其注意一词多义和短语搭配。
3. 提取 2-4 个长难句，用 sourceId 指定。先找主语和限定动词，再解释最影响理解的一处从句、并列或修饰关系。译文核对否定和比较的范围。
JSON 结构：
{"vocabulary":[{"word":"...","phonetic":"...","meaning":"...","sourceId":"p1.s1"}],"complexSentences":[{"sourceId":"p1.s1","structure":"...","translation":"..."}]}
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
英文原文：${JSON.stringify(article.passage.map(({ id, text }) => ({ id, text })))}
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
英文原句：${JSON.stringify(article.passage.map(({ id, sentences }) => ({ id, sentences })))}
当前资料：${JSON.stringify(current)}
审校问题：${JSON.stringify(issues.length ? issues : report.issues)}
修订后的每个 vocabulary.word 必须以完全相同的词形逐字出现在原文及其 sentence 中，sentence 必须是文章 sentences 数组中的完整原句；不得用派生词、变形词或改写例句替代。
输出结构与学习资料生成阶段完全相同。${jsonOnly}`
}

export function validationPrompt(draft: GeneratedDraft, config: TrainingConfig, attempt: number, previous?: ValidationReport): string {
  // The local gate already verified that joining these sentences restores text.
  const auditDraft = {
    ...draft,
    passage: draft.passage.map(({ id, sentences, translation }) => ({ id, sentences, translation })),
  }
  return `你是独立的考研英语审校 Agent。请严格检查下方题目草稿。你没有参与生成，不能因为整体看起来合理就放行。

检查维度：文章质量和难度匹配；根据逐句英文原文检查语义句界；题目是否能从原文推出；唯一正确答案；引文是否逐字存在；干扰项是否有歧义或不同题目重复考查同一论点；翻译、词义与长难句分析是否准确；是否符合 ${config.difficulty} 难度、${config.focus}重点和 ${config.questionCount} 题的要求。

决策规则：
- PASS：没有实质性错误，warnings 也不影响作答。
- REVISE：指出会误导学习者的具体错误，例如另一选项也能成立、译文反转原意、语法关系讲错。首轮一次列全；意思正确的同义措辞或表达偏好仅计 warning。
- REJECT：核心文章或多数题目不可用，应重写。
- issues 必须指出明确 target，例如 q2.evidence 或 passage.p3。
- 对词义、长难句的结构或译文、单个干扰项的排除理由，若能直接改正，在该条 issue 的 replacement 字段给出可直接展示的完整中文正文，不要写“建议改为”。如果还需更改选项、答案或引文，只写 suggestion。所有修改均会再审。

逐题比对四个选项、引文和正确答案，并检查词句资料。通过时只写一句总结，issues 留空；需要修订时仅写问题、精确字段和一句可执行的修法。字段示例 passage.p3.translation、q2.evidence、complexSentences[0].structure。不要复述草稿。
这是第 ${attempt} 次审校。${previous?.decision === 'REVISE' ? `上轮问题：${JSON.stringify(previous.issues.map(({ target, severity, message }) => ({ target, severity, message })))}。逐项核实修订结果，同时检查整套题。若发现实质错误，请指出具体依据。` : ''}草稿：
${JSON.stringify(auditDraft)}

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
