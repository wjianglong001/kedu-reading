import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { jsonrepair } from 'jsonrepair'
import { credentialStore } from './credentialStore'

const API_BASE = 'https://api.minimaxi.com/v1'
export const MINIMAX_MODEL = 'MiniMax-M3'
export const MINIMAX_READ_TIMEOUT_MS = 600_000
export const MINIMAX_MAX_COMPLETION_TOKENS = 32_768

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  thinking?: 'adaptive' | 'disabled'
  temperature?: number
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string
      reasoning_content?: string
      reasoning_details?: Array<{ text?: string }>
    }
  }>
  error?: { message?: string }
  base_resp?: { status_code?: number; status_msg?: string }
  input_sensitive?: boolean
  output_sensitive?: boolean
}

export function buildChatRequest(messages: ChatMessage[], maxCompletionTokens: number, options: ChatOptions = {}) {
  return {
    model: MINIMAX_MODEL,
    messages,
    stream: false,
    thinking: { type: options.thinking || 'adaptive' },
    reasoning_split: true,
    temperature: options.temperature ?? 0.55,
    max_completion_tokens: maxCompletionTokens,
  }
}

function modelError(status: number, body: unknown): Error {
  const data = body as ChatResponse
  if (status === 401 || status === 403) return new Error('API Key 无效或没有模型权限')
  if (status === 429) return new Error('请求过于频繁或账户额度不足，请稍后再试')
  const detail = data?.error?.message || data?.base_resp?.status_msg
  return new Error(detail || `MiniMax 请求失败（${status}）`)
}

function transportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/time[ -]?out|timed out|etimedout|sockettimeout/i.test(message)) {
    return new Error('MiniMax 在 10 分钟内仍未返回。本次任务不会自动重试，以避免重复计费；请检查网络后减少题量再试。')
  }
  return error instanceof Error ? error : new Error('无法连接 MiniMax，请检查网络后重试')
}

async function request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
  const key = await credentialStore.get()
  if (!key) throw new Error('请先在“我的”中设置 MiniMax API Key')

  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (Capacitor.isNativePlatform()) {
    try {
      const response = await CapacitorHttp.request({
        url: `${API_BASE}${path}`,
        method: init.method,
        headers,
        data: init.body,
        connectTimeout: 30_000,
        readTimeout: MINIMAX_READ_TIMEOUT_MS,
      })
      if (response.status < 200 || response.status >= 300) throw modelError(response.status, response.data)
      return response.data
    } catch (error) {
      throw transportError(error)
    }
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw modelError(response.status, data)
  return data
}

export async function verifyApiKey(): Promise<void> {
  await request('/models', { method: 'GET' })
}

export function extractChatContent(data: ChatResponse, maxCompletionTokens: number): string {
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw modelError(200, data)
  }
  if (data.input_sensitive || data.output_sensitive) {
    throw new Error('MiniMax 内容安全检查阻止了本次生成，请更换主题后重试')
  }

  const choice = data.choices?.[0]
  const content = choice?.message?.content?.trim() || ''
  if (choice?.finish_reason === 'length') {
    throw new Error(`MiniMax 输出达到 ${maxCompletionTokens} Token 上限，当前阶段未完成；已停止保存不完整内容`)
  }
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!cleaned) {
    const reasoningLength = choice?.message?.reasoning_content?.length
      || choice?.message?.reasoning_details?.reduce((total, item) => total + (item.text?.length || 0), 0)
      || 0
    if (reasoningLength > 0) {
      throw new Error('MiniMax 完成了思考但没有留下最终正文；当前阶段的思考过程耗尽了输出预算')
    }
    throw new Error(`MiniMax 没有返回最终正文${choice?.finish_reason ? `（停止原因：${choice.finish_reason}）` : ''}`)
  }
  return cleaned
}

export async function chat(
  messages: ChatMessage[],
  maxCompletionTokens = MINIMAX_MAX_COMPLETION_TOKENS,
  options: ChatOptions = {},
): Promise<string> {
  const data = (await request('/chat/completions', {
    method: 'POST',
    body: buildChatRequest(messages, maxCompletionTokens, options),
  })) as ChatResponse

  return extractChatContent(data, maxCompletionTokens)
}

export function extractJson(raw: string): unknown {
  const unfenced = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const candidates = new Set<string>([unfenced])
  const objectStart = unfenced.indexOf('{')
  const objectEnd = unfenced.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) candidates.add(unfenced.slice(objectStart, objectEnd + 1))
  const arrayStart = unfenced.indexOf('[')
  const arrayEnd = unfenced.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.add(unfenced.slice(arrayStart, arrayEnd + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Continue with the next extraction candidate.
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(jsonrepair(candidate))
    } catch {
      // A single model-assisted compensation may still recover this response.
    }
  }

  throw new Error('模型返回的 JSON 已损坏，本机自动修复失败')
}
