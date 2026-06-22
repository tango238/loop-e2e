import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createLlm, extractJson } from './client.js'
import type { CreateLlmOptions } from './client.js'
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
  it('throws a clear error when no api key and no injected client', () => {
    expect(() => createLlm('', models)).toThrow(/ANTHROPIC_API_KEY is required/)
  })

  it('does not require an api key when a client is injected', () => {
    const fakeClient = makeFakeClient('{}')
    expect(() => createLlm('', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })).not.toThrow()
  })

  it('resolves planning role to planning model id', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    await llm.complete('planning', 'test prompt')
    const call = fakeClient.messages.create.mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-8')
  })

  it('resolves report role to report model id', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    await llm.complete('report', 'test prompt')
    const call = fakeClient.messages.create.mock.calls[0][0]
    expect(call.model).toBe('claude-sonnet-4-6')
  })

  it('resolves verification role to verification model id', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    await llm.complete('verification', 'test prompt')
    const call = fakeClient.messages.create.mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-8')
  })

  it('returns text when no schema provided', async () => {
    const fakeClient = makeFakeClient('response text')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    const result = await llm.complete('report', 'prompt')
    expect(result).toBe('response text')
  })

  it('parses and validates JSON when schema is provided', async () => {
    const schema = z.object({ name: z.string(), value: z.number() })
    const fakeClient = makeFakeClient(JSON.stringify({ name: 'test', value: 42 }))
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    const result = await llm.complete('planning', 'prompt', schema)
    expect(result).toEqual({ name: 'test', value: 42 })
  })

  it('requests a generous max_tokens so large extractions are not truncated', async () => {
    const fakeClient = makeFakeClient('hello')
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    await llm.complete('planning', 'prompt')
    expect(fakeClient.messages.create.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(8192)
  })

  it('parses JSON wrapped in markdown code fences (no retry needed)', async () => {
    const schema = z.object({ ok: z.boolean() })
    const fenced = '```json\n{ "ok": true }\n```'
    const fakeClient = makeFakeClient(fenced)
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    const result = await llm.complete('planning', 'prompt', schema)
    expect(result).toEqual({ ok: true })
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1)
  })

  it('parses JSON surrounded by prose (no retry needed)', async () => {
    const schema = z.object({ value: z.number() })
    const prose = 'Sure, here is the result:\n{ "value": 7 }\nLet me know if you need more.'
    const fakeClient = makeFakeClient(prose)
    const llm = createLlm('test-api-key', models, { client: fakeClient as unknown as CreateLlmOptions['client'] })
    const result = await llm.complete('planning', 'prompt', schema)
    expect(result).toEqual({ value: 7 })
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1)
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
      client: fakeClient as unknown as CreateLlmOptions['client'],
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
      client: fakeClient as unknown as CreateLlmOptions['client'],
      backoffMs: 0,
    })
    const result = await llm.complete('planning', 'prompt', schema)
    expect(result).toEqual({ ok: true })
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(2)
  })
})

describe('extractJson', () => {
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('slices an object out of surrounding prose', () => {
    expect(extractJson('here:\n{"a":1}\nthanks')).toBe('{"a":1}')
  })
  it('slices an array out of surrounding prose', () => {
    expect(extractJson('result: [1,2,3] done')).toBe('[1,2,3]')
  })
  it('returns plain JSON unchanged (trimmed)', () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}')
  })
  it('returns the trimmed input when no JSON region is present', () => {
    expect(extractJson('no json here')).toBe('no json here')
  })
})
