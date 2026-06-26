import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createLlm } from './client.js'
import type { CreateLlmOptions } from './client.js'
import { parseClaudeCliOutput } from './claudeCode.js'
import type { Config } from '../../config/schema.js'

const models: Config['models'] = {
  planning: 'claude-opus-4-8',
  report: 'claude-sonnet-4-6',
  verification: 'claude-opus-4-8',
}

/** A fake CLI runner that records its params and returns canned stdout. */
const makeRunner = (stdout: string) => vi.fn().mockResolvedValue(stdout)

describe('createLlm with claude-code provider', () => {
  it('does not require an API key when provider is claude-code', () => {
    const runner = makeRunner('{"result":"ok"}')
    expect(() =>
      createLlm('', models, { provider: 'claude-code', claudeCode: { runner } }),
    ).not.toThrow()
  })

  it('routes prompts through the CLI runner and returns the result text', async () => {
    const runner = makeRunner(JSON.stringify({ type: 'result', result: 'hello from cli' }))
    const llm = createLlm('', models, { provider: 'claude-code', claudeCode: { runner } })
    const out = await llm.complete('report', 'say hi')
    expect(out).toBe('hello from cli')
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('passes the role-resolved model and built prompt to the runner', async () => {
    const runner = makeRunner('{"result":"x"}')
    const llm = createLlm('', models, {
      provider: 'claude-code',
      claudeCode: { runner },
      language: 'en',
    })
    await llm.complete('planning', 'PLAN_THIS')
    const params = runner.mock.calls[0][0]
    expect(params.model).toBe('claude-opus-4-8')
    expect(params.prompt).toContain('PLAN_THIS')
    expect(params.prompt).toContain('English')
    expect(params.bin).toBe('claude')
  })

  it('honors a custom bin and timeout', async () => {
    const runner = makeRunner('{"result":"x"}')
    const llm = createLlm('', models, {
      provider: 'claude-code',
      claudeCode: { runner, bin: '/usr/local/bin/claude', timeoutMs: 1234 },
    })
    await llm.complete('report', 'p')
    const params = runner.mock.calls[0][0]
    expect(params.bin).toBe('/usr/local/bin/claude')
    expect(params.timeoutMs).toBe(1234)
  })

  it('parses and validates structured JSON returned by the CLI', async () => {
    const schema = z.object({ name: z.string(), value: z.number() })
    const runner = makeRunner(
      JSON.stringify({ type: 'result', result: JSON.stringify({ name: 'a', value: 1 }) }),
    )
    const llm = createLlm('', models, { provider: 'claude-code', claudeCode: { runner } })
    const result = await llm.complete('planning', 'p', schema)
    expect(result).toEqual({ name: 'a', value: 1 })
  })

  it('retries structured calls through the CLI on bad JSON then succeeds', async () => {
    const schema = z.object({ ok: z.boolean() })
    const runner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ result: 'not json' }))
      .mockResolvedValueOnce(JSON.stringify({ result: JSON.stringify({ ok: true }) }))
    const llm = createLlm('', models, {
      provider: 'claude-code',
      claudeCode: { runner },
      backoffMs: 0,
    })
    const result = await llm.complete('planning', 'p', schema)
    expect(result).toEqual({ ok: true })
    expect(runner).toHaveBeenCalledTimes(2)
  })
})

describe('provider resolution', () => {
  const origEnv = process.env['USE_CLAUDE_CODE']

  afterEach(() => {
    if (origEnv === undefined) delete process.env['USE_CLAUDE_CODE']
    else process.env['USE_CLAUDE_CODE'] = origEnv
  })

  it('defaults to the API backend (needs a key) when USE_CLAUDE_CODE is unset', () => {
    delete process.env['USE_CLAUDE_CODE']
    expect(() => createLlm('', models)).toThrow(/ANTHROPIC_API_KEY is required/)
  })

  it('selects the CLI backend when USE_CLAUDE_CODE is truthy (no key needed)', () => {
    process.env['USE_CLAUDE_CODE'] = 'true'
    expect(() => createLlm('', models, { claudeCode: { runner: makeRunner('{}') } })).not.toThrow()
  })

  it('an injected API client forces the API backend even if USE_CLAUDE_CODE is set', async () => {
    process.env['USE_CLAUDE_CODE'] = 'true'
    const fakeClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'api' }] }) },
    }
    const llm = createLlm('', models, {
      client: fakeClient as unknown as CreateLlmOptions['client'],
    })
    const out = await llm.complete('report', 'p')
    expect(out).toBe('api')
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1)
  })
})

describe('parseClaudeCliOutput', () => {
  it('extracts result from a success object', () => {
    expect(parseClaudeCliOutput(JSON.stringify({ type: 'result', result: 'hi' }))).toBe('hi')
  })
  it('extracts result from a stream-json array', () => {
    const arr = JSON.stringify([{ type: 'system' }, { type: 'result', result: 'done' }])
    expect(parseClaudeCliOutput(arr)).toBe('done')
  })
  it('falls back to content field', () => {
    expect(parseClaudeCliOutput(JSON.stringify({ content: 'body' }))).toBe('body')
  })
  it('returns raw text when output is not JSON', () => {
    expect(parseClaudeCliOutput('plain text reply')).toBe('plain text reply')
  })
  it('returns empty string for empty output', () => {
    expect(parseClaudeCliOutput('   ')).toBe('')
  })
})
