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
}

const MAX_RETRIES = 3

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
  const client: AnthropicClient =
    options.client ?? (new Anthropic({ apiKey }) as unknown as AnthropicClient)

  function modelForRole(role: LlmRole): string {
    return models[role]
  }

  async function callApi(model: string, systemNote: string, prompt: string): Promise<string> {
    const fullPrompt = systemNote ? `${systemNote}\n\n${prompt}` : prompt
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
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
        const parsed = JSON.parse(text) as unknown
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
