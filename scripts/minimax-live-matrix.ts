import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { jsonrepair } from 'jsonrepair'
import { createLiveMatrix, type LiveMatrixMode, type LiveTestCase } from '../src/liveTestMatrix'
import { articleGenerationPrompt, questionGenerationPrompt, studyGenerationPrompt, validationPrompt } from '../src/prompts'
import {
  articleDraftSchema,
  draftSchema,
  questionBatchSchema,
  questionsDraftSchema,
  studyDraftSchema,
  validationSchema,
  type GeneratedArticleDraft,
} from '../src/schemas'
import type { TrainingConfig } from '../src/types'

const API_BASE = 'https://api.minimaxi.com/v1'
const APP_MODEL = 'MiniMax-M3'
const SYSTEM_PROMPT = '你必须诚实、严谨，并严格遵循用户要求的 JSON 输出格式。'

type Outcome =
  | 'pass'
  | 'http_failed'
  | 'empty_response'
  | 'json_failed'
  | 'schema_failed'
  | 'quality_failed'

interface Args {
  mode: LiveMatrixMode
  repeats: number
  maxCases: number
  execute: boolean
  confirmLargeRun: boolean
  withValidation: boolean
  model?: string
  maxOutputTokens: number
  timeoutMs: number
  delayMs: number
  output?: string
  resume?: string
  help: boolean
}

interface ApiUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

interface StageResult {
  outcome: Outcome
  durationMs: number
  httpStatus?: number
  finishReason?: string
  contentChars?: number
  rawSha256?: string
  parseMode?: 'strict' | 'repaired' | 'model_repaired'
  schemaIssues?: string[]
  qualityIssues?: string[]
  usage?: ApiUsage
  decision?: 'PASS' | 'REVISE' | 'REJECT'
  error?: string
}

interface CaseResult {
  caseId: string
  config: TrainingConfig
  model: string
  maxOutputTokens: number
  startedAt: string
  article: StageResult
  questions?: StageResult[]
  study?: StageResult
  validation?: StageResult
  passed: boolean
}

function positiveInt(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} 必须是正整数`)
  return value
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'baseline-repeat',
    repeats: 10,
    maxCases: 10,
    execute: false,
    confirmLargeRun: false,
    withValidation: false,
    maxOutputTokens: 32_768,
    timeoutMs: 600_000,
    delayMs: 1_000,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`)
      index += 1
      return value
    }
    if (flag === '--mode') {
      const mode = next()
      if (!['baseline-repeat', 'baseline-exhaustive', 'full-exhaustive'].includes(mode)) {
        throw new Error(`不支持的 mode：${mode}`)
      }
      args.mode = mode as LiveMatrixMode
    } else if (flag === '--repeats') args.repeats = positiveInt(next(), flag)
    else if (flag === '--max-cases') args.maxCases = positiveInt(next(), flag)
    else if (flag === '--max-output-tokens') args.maxOutputTokens = positiveInt(next(), flag)
    else if (flag === '--timeout-ms') args.timeoutMs = positiveInt(next(), flag)
    else if (flag === '--delay-ms') args.delayMs = positiveInt(next(), flag)
    else if (flag === '--model') args.model = next()
    else if (flag === '--output') args.output = next()
    else if (flag === '--resume') args.resume = next()
    else if (flag === '--execute') args.execute = true
    else if (flag === '--confirm-large-run') args.confirmLargeRun = true
    else if (flag === '--with-validation') args.withValidation = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`未知参数：${flag}`)
  }
  return args
}

function printHelp() {
  console.log(`MiniMax 题目生成真实 API 测试器

默认只预览，不联网、不计费：
  npm run test:live:plan

执行 10 次完全相同的失败基线：
  npm run test:live -- --execute

执行固定“考研常规/标准/5题”的 450 个全组合（高费用）：
  npm run test:live -- --mode baseline-exhaustive --max-cases 450 --execute --confirm-large-run

参数：
  --mode baseline-repeat|baseline-exhaustive|full-exhaustive
  --repeats N                baseline-repeat 的重复次数
  --max-cases N              本轮最多执行数，默认 10
  --with-validation          每个生成成功的用例再调用一次审校 Agent
  --model MODEL              覆盖本地配置中的模型名
  --max-output-tokens N      默认 32768，与当前 App 一致
  --timeout-ms N             单请求超时，默认 600000
  --delay-ms N               请求间隔，默认 1000
  --output PATH              JSONL 结果路径
  --resume PATH              跳过该 JSONL 中已完成的 caseId
  --execute                  明确允许真实调用
  --confirm-large-run        超过 50 个用例时必须提供

密钥只从进程环境或本机 .env / .env.minimax.local 读取；支持 MINIMAX_API_KEY 和 MINIMAXKEY，不接受命令行 Key。`)
}

function readEnvFile(fileName: string): Record<string, string> {
  const file = resolve(fileName)
  if (!existsSync(file)) return {}
  const result: Record<string, string> = {}
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const name = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[name] = value
  }
  return result
}

function readLocalEnv(): Record<string, string> {
  return {
    ...readEnvFile('.env'),
    ...readEnvFile('.env.minimax.local'),
  }
}

function configuredApiKey(localEnv: Record<string, string>): string | undefined {
  return process.env.MINIMAX_API_KEY
    || process.env.MINIMAXKEY
    || localEnv.MINIMAX_API_KEY
    || localEnv.MINIMAXKEY
}

function redact(message: unknown, apiKey: string): string {
  return String(message instanceof Error ? message.message : message)
    .replaceAll(apiKey, '[REDACTED]')
    .slice(0, 1_000)
}

function spreadSelect(cases: LiveTestCase[], count: number): LiveTestCase[] {
  if (count >= cases.length) return cases
  if (count === 1) return [cases[0]]
  return Array.from({ length: count }, (_, index) => {
    const matrixIndex = Math.round(index * (cases.length - 1) / (count - 1))
    return cases[matrixIndex]
  })
}

function completedCaseIds(path: string | undefined): Set<string> {
  if (!path) return new Set()
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`续跑文件不存在：${absolute}`)
  const ids = new Set<string>()
  for (const line of readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as { caseId?: string }
      if (record.caseId) ids.add(record.caseId)
    } catch {
      throw new Error(`续跑文件包含损坏的 JSONL：${absolute}`)
    }
  }
  return ids
}

async function fetchJson(
  path: string,
  apiKey: string,
  timeoutMs: number,
  init: { method: 'GET' | 'POST'; body?: unknown },
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let data: unknown = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = { unparseableResponse: true } }
    return { status: response.status, ok: response.ok, data, durationMs: Math.round(performance.now() - started) }
  } finally {
    clearTimeout(timer)
  }
}

function modelIds(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const records = (data as { data?: unknown }).data
  if (!Array.isArray(records)) return []
  return records.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const id = (entry as { id?: unknown }).id
    return typeof id === 'string' ? [id] : []
  })
}

async function preflight(apiKey: string, model: string, timeoutMs: number) {
  const response = await fetchJson('/models', apiKey, timeoutMs, { method: 'GET' })
  if (!response.ok) throw new Error(`模型列表预检失败（HTTP ${response.status}）`)
  const available = modelIds(response.data)
  if (!available.includes(model)) {
    const display = available.length ? available.join(', ') : '接口没有返回模型 ID'
    throw new Error(`当前 Key 的 /models 列表中没有 ${model}。可用模型：${display}`)
  }
  return available
}

function extractionCandidates(raw: string): string[] {
  const unfenced = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const candidates = new Set([unfenced])
  const objectStart = unfenced.indexOf('{')
  const objectEnd = unfenced.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) candidates.add(unfenced.slice(objectStart, objectEnd + 1))
  return [...candidates]
}

function parseJson(raw: string): { value: unknown; mode: 'strict' | 'repaired' } {
  const candidates = extractionCandidates(raw)
  for (const candidate of candidates) {
    try { return { value: JSON.parse(candidate), mode: 'strict' } } catch { /* try next */ }
  }
  for (const candidate of candidates) {
    try { return { value: JSON.parse(jsonrepair(candidate)), mode: 'repaired' } } catch { /* try next */ }
  }
  throw new Error('本地 JSON 解析与修复均失败')
}

function schemaIssueList(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.slice(0, 20).map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
}

function qualityIssues(draft: ReturnType<typeof draftSchema.parse>, config: TrainingConfig): string[] {
  const issues: string[] = []
  if (draft.questions.length !== config.questionCount) {
    issues.push(`题量 ${draft.questions.length}，期望 ${config.questionCount}`)
  }
  const questionIds = draft.questions.map(({ id }) => id)
  if (new Set(questionIds).size !== questionIds.length) issues.push('题号不唯一')
  const paragraphs = new Map(draft.passage.map(({ id, text }) => [id, text]))
  for (const question of draft.questions) {
    const optionValues = Object.values(question.options).map((value) => value.trim())
    if (optionValues.some((value) => !value)) issues.push(`${question.id} 存在空选项`)
    if (new Set(optionValues).size !== 4) issues.push(`${question.id} 存在重复选项`)
    const paragraph = paragraphs.get(question.evidence.paragraphId)
    if (!paragraph) issues.push(`${question.id} 引用了不存在的段落`)
    else if (!paragraph.includes(question.evidence.quote)) issues.push(`${question.id} 的证据引文未逐字出现`)
  }
  return issues
}

function usageFrom(data: unknown): ApiUsage | undefined {
  const usage = data && typeof data === 'object' ? (data as { usage?: unknown }).usage : undefined
  if (!usage || typeof usage !== 'object') return undefined
  const source = usage as Record<string, unknown>
  const number = (name: string) => typeof source[name] === 'number' ? source[name] as number : undefined
  return {
    promptTokens: number('prompt_tokens'),
    completionTokens: number('completion_tokens'),
    totalTokens: number('total_tokens'),
  }
}

function responseFields(data: unknown): { content?: string; finishReason?: string } {
  if (!data || typeof data !== 'object') return {}
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return {}
  const choice = choices[0] as { finish_reason?: unknown; message?: { content?: unknown } }
  return {
    content: typeof choice.message?.content === 'string' ? choice.message.content.trim() : undefined,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
  }
}

function serverError(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const value = data as { error?: { message?: unknown }; base_resp?: { status_msg?: unknown } }
  if (typeof value.error?.message === 'string') return value.error.message
  if (typeof value.base_resp?.status_msg === 'string') return value.base_resp.status_msg
  return undefined
}

async function chatStage(options: {
  apiKey: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
  prompt: string
  schema: typeof articleDraftSchema | typeof questionBatchSchema | typeof questionsDraftSchema | typeof studyDraftSchema | typeof validationSchema
  config?: TrainingConfig
  thinking?: 'adaptive' | 'disabled'
}): Promise<{ result: StageResult; parsed?: unknown }> {
  const body = {
    model: options.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: options.prompt },
    ],
    stream: false,
    thinking: { type: options.thinking || 'adaptive' },
    reasoning_split: true,
    temperature: 0.55,
    max_completion_tokens: options.maxOutputTokens,
  }

  try {
    const response = await fetchJson('/chat/completions', options.apiKey, options.timeoutMs, { method: 'POST', body })
    const usage = usageFrom(response.data)
    const fields = responseFields(response.data)
    if (!response.ok) {
      return {
        result: {
          outcome: 'http_failed', durationMs: response.durationMs, httpStatus: response.status, usage,
          error: serverError(response.data) || `HTTP ${response.status}`,
        },
      }
    }
    if (!fields.content) {
      return {
        result: {
          outcome: 'empty_response', durationMs: response.durationMs, httpStatus: response.status,
          finishReason: fields.finishReason, usage, error: '响应中没有 choices[0].message.content',
        },
      }
    }

    const base = {
      durationMs: response.durationMs,
      httpStatus: response.status,
      finishReason: fields.finishReason,
      contentChars: fields.content.length,
      rawSha256: createHash('sha256').update(fields.content).digest('hex'),
      usage,
    }
    let parsed: { value: unknown; mode: 'strict' | 'repaired' | 'model_repaired' }
    try {
      parsed = parseJson(fields.content)
    } catch (error) {
      const repairBody = {
        model: options.model,
        messages: [
          { role: 'system', content: '你是 JSON 格式修复器。只修复语法、转义、分隔符和闭合，不添加解释。只输出完整 JSON。' },
          { role: 'user', content: `<broken_json>\n${fields.content}\n</broken_json>` },
        ],
        stream: false,
        thinking: { type: 'disabled' },
        reasoning_split: true,
        temperature: 0.2,
        max_completion_tokens: options.maxOutputTokens,
      }
      const repair = await fetchJson('/chat/completions', options.apiKey, options.timeoutMs, { method: 'POST', body: repairBody })
      const repairedFields = responseFields(repair.data)
      if (!repair.ok || !repairedFields.content || repairedFields.finishReason === 'length') {
        return { result: { outcome: 'json_failed', ...base, error: String((error as Error).message) } }
      }
      try {
        const repaired = parseJson(repairedFields.content)
        parsed = { value: repaired.value, mode: 'model_repaired' }
      } catch {
        return { result: { outcome: 'json_failed', ...base, error: '本地与模型 JSON 修复均失败' } }
      }
    }
    const schemaResult = options.schema.safeParse(parsed.value)
    if (!schemaResult.success) {
      return {
        result: {
          outcome: 'schema_failed', ...base, parseMode: parsed.mode,
          schemaIssues: schemaIssueList(schemaResult.error.issues),
        },
      }
    }
    const quality = options.config && options.schema === draftSchema
      ? qualityIssues(schemaResult.data as ReturnType<typeof draftSchema.parse>, options.config)
      : []
    if (options.schema === validationSchema) {
      const report = schemaResult.data as ReturnType<typeof validationSchema.parse>
      const blockingIssues = report.issues
        .filter(({ severity }) => severity === 'error')
        .map(({ target, message }) => `${target}: ${message}`)
      if (report.decision !== 'PASS' || blockingIssues.length) {
        return {
          result: {
            outcome: 'quality_failed', ...base, parseMode: parsed.mode,
            decision: report.decision,
            qualityIssues: blockingIssues.length ? blockingIssues : [`审校决策为 ${report.decision}`],
          },
          parsed: report,
        }
      }
      return {
        result: { outcome: 'pass', ...base, parseMode: parsed.mode, decision: report.decision },
        parsed: report,
      }
    }
    if (quality.length) {
      return {
        result: { outcome: 'quality_failed', ...base, parseMode: parsed.mode, qualityIssues: quality },
        parsed: schemaResult.data,
      }
    }
    return { result: { outcome: 'pass', ...base, parseMode: parsed.mode }, parsed: schemaResult.data }
  } catch (error) {
    return { result: { outcome: 'http_failed', durationMs: 0, error: redact(error, options.apiKey) } }
  }
}

function outputPath(args: Args): string {
  if (args.output) return resolve(args.output)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return resolve('.live-results', `${args.mode}-${stamp}.jsonl`)
}

function summarize(results: CaseResult[]) {
  const outcomes: Record<string, number> = {}
  const finishReasons: Record<string, number> = {}
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  for (const record of results) {
    for (const stage of [record.article, ...(record.questions || []), record.study, record.validation].filter(Boolean) as StageResult[]) {
      outcomes[stage.outcome] = (outcomes[stage.outcome] || 0) + 1
      const finish = stage.finishReason || '<missing>'
      finishReasons[finish] = (finishReasons[finish] || 0) + 1
      promptTokens += stage.usage?.promptTokens || 0
      completionTokens += stage.usage?.completionTokens || 0
      totalTokens += stage.usage?.totalTokens || 0
    }
  }
  const firstRecordByCase = new Map<string, CaseResult>()
  for (const record of results) {
    if (!firstRecordByCase.has(record.caseId)) firstRecordByCase.set(record.caseId, record)
  }
  const uniqueRecords = [...firstRecordByCase.values()]
  const passed = uniqueRecords.filter(({ passed }) => passed).length
  return {
    requests: results.length,
    duplicateRecords: results.length - uniqueRecords.length,
    cases: uniqueRecords.length,
    passed,
    failed: uniqueRecords.length - passed,
    passRate: uniqueRecords.length ? Number((passed / uniqueRecords.length).toFixed(4)) : 0,
    outcomes,
    finishReasons,
    usage: { promptTokens, completionTokens, totalTokens },
  }
}

function wait(ms: number) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const matrix = createLiveMatrix(args.mode, args.repeats)
  const selected = spreadSelect(matrix, Math.min(args.maxCases, matrix.length))
  const callsPerCase = args.withValidation ? '至少 5（格式异常时增加 1 次修复）' : '至少 4（格式异常时增加 1 次修复）'
  console.log(`模式：${args.mode}`)
  console.log(`矩阵总数：${matrix.length}；本轮选择：${selected.length}；每用例请求：${callsPerCase}`)
  console.log(`模型默认值：${args.model || APP_MODEL}；max_completion_tokens：${args.maxOutputTokens}`)
  if (!args.execute) {
    console.log('DRY-RUN：未读取 API Key，未发送网络请求，未产生费用。')
    console.log(`首个用例：${JSON.stringify(selected[0]?.config)}`)
    console.log(`末个用例：${JSON.stringify(selected.at(-1)?.config)}`)
    return
  }
  if (selected.length > 50 && !args.confirmLargeRun) {
    throw new Error(`本轮将执行 ${selected.length} 个用例；超过 50 个必须增加 --confirm-large-run`)
  }

  const localEnv = readLocalEnv()
  const apiKey = configuredApiKey(localEnv)
  if (!apiKey) throw new Error('未找到 MINIMAX_API_KEY 或 MINIMAXKEY；请写入已被 Git 忽略的 .env 或 .env.minimax.local')
  const model = args.model || process.env.MINIMAX_MODEL || localEnv.MINIMAX_MODEL || APP_MODEL
  const available = await preflight(apiKey, model, args.timeoutMs)
  console.log(`预检通过：Key 可用，模型 ${model} 已出现在 /models（共 ${available.length} 个模型）。`)

  const done = completedCaseIds(args.resume)
  const pending = selected.filter(({ id }) => !done.has(id))
  const destination = outputPath(args)
  mkdirSync(dirname(destination), { recursive: true })
  console.log(`待执行：${pending.length}；结果：${destination}`)

  const results: CaseResult[] = []
  for (let index = 0; index < pending.length; index += 1) {
    const testCase = pending[index]
    const article = await chatStage({
      apiKey,
      model,
      maxOutputTokens: args.maxOutputTokens,
      timeoutMs: args.timeoutMs,
      prompt: articleGenerationPrompt(testCase.config),
      schema: articleDraftSchema,
      thinking: 'disabled',
    })
    const questionBatches: Array<Awaited<ReturnType<typeof chatStage>>> = []
    let study: Awaited<ReturnType<typeof chatStage>> | undefined
    let merged: unknown
    if (article.result.outcome === 'pass' && article.parsed) {
      const articleDraft = article.parsed as GeneratedArticleDraft
      if (args.delayMs) await wait(args.delayMs)
      const firstCount = Math.ceil(testCase.config.questionCount / 2)
      let existing: ReturnType<typeof questionsDraftSchema.parse>['questions'] = []
      for (const batch of [{ start: 1, count: firstCount }, { start: firstCount + 1, count: testCase.config.questionCount - firstCount }]) {
        const generated = await chatStage({
          apiKey, model, maxOutputTokens: args.maxOutputTokens, timeoutMs: args.timeoutMs,
          prompt: questionGenerationPrompt(articleDraft, testCase.config, batch.start, batch.count, existing), schema: questionBatchSchema,
          thinking: 'adaptive',
        })
        questionBatches.push(generated)
        if (generated.parsed) existing = [...existing, ...(generated.parsed as { questions: typeof existing }).questions]
        if (args.delayMs) await wait(args.delayMs)
      }
      if (args.delayMs) await wait(args.delayMs)
      study = await chatStage({
        apiKey, model, maxOutputTokens: args.maxOutputTokens, timeoutMs: args.timeoutMs,
        prompt: studyGenerationPrompt(articleDraft, testCase.config), schema: studyDraftSchema,
        thinking: 'disabled',
      })
      if (existing.length === testCase.config.questionCount && study.parsed) {
        const candidate = draftSchema.safeParse({ ...articleDraft, questions: existing, ...study.parsed })
        if (candidate.success && qualityIssues(candidate.data, testCase.config).length === 0) merged = candidate.data
      }
    }
    let validation: StageResult | undefined
    if (args.withValidation && merged) {
      if (args.delayMs) await wait(args.delayMs)
      validation = (await chatStage({
        apiKey,
        model,
        maxOutputTokens: args.maxOutputTokens,
        timeoutMs: args.timeoutMs,
        prompt: validationPrompt(merged, testCase.config, 1),
        schema: validationSchema,
      })).result
    }
    const record: CaseResult = {
      caseId: testCase.id,
      config: testCase.config,
      model,
      maxOutputTokens: args.maxOutputTokens,
      startedAt: new Date().toISOString(),
      article: article.result,
      questions: questionBatches.map(({ result }) => result),
      study: study?.result,
      validation,
      passed: !!merged && (!args.withValidation || validation?.outcome === 'pass'),
    }
    appendFileSync(destination, `${JSON.stringify(record)}\n`, 'utf8')
    results.push(record)
    console.log(`[${index + 1}/${pending.length}] ${record.caseId}: ${record.passed ? 'PASS' : 'FAIL'} (article=${record.article.outcome}, questions=${record.questions?.map(({ outcome }) => outcome).join('+') || 'skipped'}, study=${record.study?.outcome || 'skipped'})`)
    if (index < pending.length - 1 && args.delayMs) await wait(args.delayMs)
  }

  const persistedResults = readFileSync(destination, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaseResult)
  const summary = summarize(persistedResults)
  const summaryPath = `${destination}.summary.json`
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`汇总：${JSON.stringify(summary)}`)
  console.log(`摘要：${summaryPath}`)
  if (summary.failed > 0) process.exitCode = 1
}

main().catch((error) => {
  const localEnv = readLocalEnv()
  const apiKey = configuredApiKey(localEnv) || '<missing-key>'
  console.error(`测试停止：${redact(error, apiKey)}`)
  process.exitCode = 1
})
