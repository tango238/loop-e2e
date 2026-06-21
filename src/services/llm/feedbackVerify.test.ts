import { describe, it, expect, vi } from 'vitest'
import type { Llm } from './client.js'
import { verifyFeedback, type FeedbackEvidence } from './feedbackVerify.js'
import type { Feedback } from '../../domain/types.js'

function makeMockLlm(response: unknown): Llm {
  return {
    complete: vi.fn().mockResolvedValue(response),
  } as unknown as Llm
}

const baseFeedback: Feedback = {
  id: 'fb-1',
  targetFindingId: 'finding-abc',
  userComment: 'This is a false positive — the CSRF token is actually present via meta tag.',
  verdict: undefined,
  appliedTo: [],
  createdAt: '2024-01-01T00:00:00.000Z',
}

const baseEvidence: FeedbackEvidence = {
  findingTitle: 'Missing CSRF protection',
  findingDetail: 'No CSRF token found in form submissions.',
  findingCategory: 'security',
}

describe('feedbackVerify', () => {
  describe('verifyFeedback', () => {
    it('returns valid=true when LLM classifies feedback as a real correction', async () => {
      const llm = makeMockLlm({
        valid: true,
        classification: 'false-positive',
        rationale: 'User correctly identified CSRF token via meta tag pattern.',
      })

      const result = await verifyFeedback(llm, baseFeedback, baseEvidence)

      expect(result.valid).toBe(true)
      expect(result.classification).toBe('false-positive')
      expect(result.rationale).toBeTypeOf('string')
      expect(result.rationale.length).toBeGreaterThan(0)
    })

    it('returns valid=false when LLM classifies feedback as a misunderstanding', async () => {
      const llm = makeMockLlm({
        valid: false,
        classification: 'misunderstanding',
        rationale: 'User is confused about what CSRF protection requires.',
      })

      const result = await verifyFeedback(llm, baseFeedback, baseEvidence)

      expect(result.valid).toBe(false)
      expect(result.classification).toBe('misunderstanding')
    })

    it('uses role=verification (Opus) for the LLM call', async () => {
      const mockComplete = vi.fn().mockResolvedValue({
        valid: true,
        classification: 'false-positive',
        rationale: 'Ok',
      })
      const llm = { complete: mockComplete } as unknown as Llm

      await verifyFeedback(llm, baseFeedback, baseEvidence)

      expect(mockComplete).toHaveBeenCalledWith(
        'verification',
        expect.any(String),
        expect.any(Object),
      )
    })

    it('validates LLM output with zod — throws on malformed response after retries', async () => {
      const llm = {
        complete: vi.fn().mockRejectedValue(new Error('LLM structured output failed after 3 attempts')),
      } as unknown as Llm

      await expect(verifyFeedback(llm, baseFeedback, baseEvidence)).rejects.toThrow(
        /LLM structured output failed/,
      )
    })

    it('handles feedback without a targetFindingId gracefully', async () => {
      const llm = makeMockLlm({
        valid: true,
        classification: 'general-correction',
        rationale: 'General feedback accepted.',
      })
      const feedbackNoTarget: Feedback = {
        ...baseFeedback,
        targetFindingId: undefined,
      }

      const result = await verifyFeedback(llm, feedbackNoTarget, baseEvidence)

      expect(result.valid).toBe(true)
    })
  })
})
