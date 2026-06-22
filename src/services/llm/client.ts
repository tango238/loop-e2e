import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { logger } from '../../util/logger.js'
import type { Config } from '../../config/schema.js'

export type LlmRole = 'planning' | 'report' | 'verification'

export type Llm = {
  complete(role: LlmRole, prompt: string): Promise<string>
  complete<T>(role: LlmRole, prompt: string, schema: z.ZodType<T>): Promise<T>
}

type AnthropicClient = {
  messages: {
    create: (params: {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: string }>
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export type CreateLlmOptions = {
  /** Injectable Anthropic client for testing — defaults to new Anthropic({ apiKey }) */
  client?: AnthropicClient
  /** Base backoff in ms between retries (0 in tests) */
  backoffMs?: number
  /** Language for human-readable generated text (config.language). Defaults to Japanese. */
  language?: string
}

const MAX_RETRIES = 3

const LANGUAGE_NAMES: Record<string, string> = { ja: 'Japanese', en: 'English' }

/**
 * Instruction prepended to every prompt so AI-generated human-readable text (scenario titles,
 * report prose, finding details, rationale) is produced in the configured language. Code,
 * selectors, URLs, identifiers, and JSON keys are explicitly left untranslated.
 */
function languageDirective(language: string | undefined): string {
  const lang = (language ?? 'ja').trim()
  const name = LANGUAGE_NAMES[lang.toLowerCase()] ?? lang
  return (
    `Write all human-readable text you generate (titles, descriptions, business flows, summaries, ` +
    `finding details, and rationale) in ${name}. Do not translate or alter code, CSS/DOM selectors, ` +
    `URLs, file paths, identifiers, env-var names, or JSON keys — keep those exactly as written.`
  )
}

/**
 * Creates an Llm instance that routes prompts to the correct model by role,
 * validates structured output with Zod, and retries with exponential backoff.
 */
export function createLlm(
  apiKey: string,
  models: Config['models'],
  options: CreateLlmOptions = {},
): Llm {
  const { backoffMs = 500 } = options
  // ANTHROPIC_API_KEY is optional at config-load time so launch/login-only flows
  // work without it. Fail with a clear message only when a real client is needed
  // (no injected client) but the key is absent — instead of a cryptic 401 later.
  if (!options.client && !apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for AI features (scenario generation, diff/verify judgment, report). Set it in .env.',
    )
  }
  const client: AnthropicClient =
    options.client ?? (new Anthropic({ apiKey }) as unknown as AnthropicClient)

  const langNote = languageDirective(options.language)

  function modelForRole(role: LlmRole): string {
    return models[role]
  }

  async function callApi(model: string, systemNote: string, prompt: string): Promise<string> {
    const fullPrompt = [langNote, systemNote, prompt].filter(Boolean).join('\n\n')
    const response = await client.messages.create({
      model,
      // Structured page-extraction outputs can be large; 4096 truncated big pages mid-JSON,
      // which failed JSON.parse on every retry. 8192 gives headroom without much cost.
      max_tokens: 8192,
      messages: [{ role: 'user', content: fullPrompt }],
    })
    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }

  async function complete(role: LlmRole, prompt: string): Promise<string>
  async function complete<T>(role: LlmRole, prompt: string, schema: z.ZodType<T>): Promise<T>
  async function complete<T>(
    role: LlmRole,
    prompt: string,
    schema?: z.ZodType<T>,
  ): Promise<string | T> {
    const model = modelForRole(role)

    if (!schema) {
      return callApi(model, '', prompt)
    }

    const systemNote =
      'Respond with valid JSON only — no markdown, no code fences, no explanation. Output the raw JSON object.'

    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const text = await callApi(model, systemNote, prompt)
        const parsed = JSON.parse(extractJson(text)) as unknown
        return schema.parse(parsed)
      } catch (err) {
        lastError = err
        if (attempt < MAX_RETRIES) {
          const delay = backoffMs * 2 ** (attempt - 1)
          logger.warn({ attempt, delay }, 'LLM response parse/validation failed, retrying')
          if (delay > 0) await sleep(delay)
        }
      }
    }
    throw new Error(
      `LLM structured output failed after ${MAX_RETRIES} attempts: ${String(lastError)}`,
    )
  }

  return { complete }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Extract a JSON document from a model response that may, despite instructions, wrap it in
 * markdown code fences or surround it with prose. Strips ```json/``` fences, else slices from
 * the first opening bracket to the last matching closing bracket. Returns the input trimmed
 * when no JSON-looking region is found (so the caller's JSON.parse throws a clear error).
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()

  // 1) Fenced block: ```json\n...\n``` or ```\n...\n```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence && fence[1].trim()) return fence[1].trim()

  // 2) First balanced object/array region: from the first { or [ to the last } or ].
  const firstObj = trimmed.indexOf('{')
  const firstArr = trimmed.indexOf('[')
  const candidates = [firstObj, firstArr].filter((i) => i >= 0)
  if (candidates.length > 0) {
    const start = Math.min(...candidates)
    const open = trimmed[start]
    const close = open === '{' ? '}' : ']'
    const end = trimmed.lastIndexOf(close)
    if (end > start) return trimmed.slice(start, end + 1)
  }

  return trimmed
}
