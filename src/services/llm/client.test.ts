import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createLlm } from './client.js'
import type { Config } from '../../config/schema.js'

const models: Config['models'] = {
  planning: 'claude-opus-4-8',
  report: 'claude-sonnet-4-6',
  verification: 'claude-opus-4-8',
}

// --- Fake Anthropic client factory ---
const makeFakeClient = (textContent: string) => ({
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: textContent }],
    }),
  },
})

describe('LLM client', () => {
  it('resolves planning role to planning model id', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'] })
    await llm.complete('planning', 'test prompt')
    const call = fakeClient.messages.create.mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-8')
  })

  it('resolves report role to report model id', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'] })
    await llm.complete('report', 'test prompt')
    const call = fakeClient.messages.create.mock.calls[0][0]
    expect(call.model).toBe('claude-sonnet-4-6')
  })

  it('resolves verification role to verification model id', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'] })
    await llm.complete('verification', 'test prompt')
    const call = fakeClient.messages.create.mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-8')
  })

  it('returns text when no schema provided', async () => {
    const fakeClient = makeFakeClient('response text')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'] })
    const result = await llm.complete('report', 'prompt')
    expect(result).toBe('response text')
  })

  it('parses and validates JSON when schema is provided', async () => {
    const schema = z.object({ name: z.string(), value: z.number() })
    const fakeClient = makeFakeClient(JSON.stringify({ name: 'test', value: 42 }))
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'] })
    const result = await llm.complete('planning', 'prompt', schema)
    expect(result).toEqual({ name: 'test', value: 42 })
  })

  it('retries on invalid JSON and eventually throws after max attempts', async () => {
    const schema = z.object({ name: z.string() })
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'not valid json at all' }],
        }),
      },
    }
    const llm = createLlm('test-api-key', models, {
      client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'],
      backoffMs: 0, // no delay in tests
    })
    await expect(llm.complete('planning', 'prompt', schema)).rejects.toThrow()
    // Should have been called 3 times (initial + 2 retries)
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(3)
  })

  it('retries on first failure then succeeds on second attempt', async () => {
    const schema = z.object({ ok: z.boolean() })
    const goodJson = JSON.stringify({ ok: true })
    const fakeClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'bad json' }] })
          .mockResolvedValueOnce({ content: [{ type: 'text', text: goodJson }] }),
      },
    }
    const llm = createLlm('test-api-key', models, {
      client: fakeClient as unknown as Parameters<typeof createLlm>[2]['client'],
      backoffMs: 0,
    })
    const result = await llm.complete('planning', 'prompt', schema)
    expect(result).toEqual({ ok: true })
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(2)
  })
})
