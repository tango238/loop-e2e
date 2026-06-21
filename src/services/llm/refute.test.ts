import { describe, it, expect, vi } from 'vitest'
import type { Llm } from './client.js'
import type { DiffFinding, RefuterVote } from '../../domain/types.js'
import { adjudicate } from './refute.js'

const sampleFinding: DiffFinding = {
  kind: 'transition',
  severity: 'high',
  expected: 'nav link present',
  actual: 'nav link removed',
  location: '/home',
}

function makeVote(overrides: Partial<RefuterVote>): RefuterVote {
  return {
    lens: 'correctness',
    refuted: false,
    classification: 'bug',
    confidence: 0.9,
    rationale: 'This is a real bug',
    ...overrides,
  }
}

function makeSuccessLlm(votes: RefuterVote[]): Llm {
  let callCount = 0
  return {
    complete: vi.fn().mockImplementation(() => {
      const vote = votes[callCount % votes.length]
      callCount++
      return Promise.resolve(vote)
    }),
  } as unknown as Llm
}

const defaultRefutation = {
  panelSize: 3,
  confidenceThreshold: 0.8,
  lenses: ['correctness', 'security', 'intentionality'] as ('correctness' | 'security' | 'intentionality')[],
}

describe('adjudicate', () => {
  it('3/3 fail to refute → bug, high confidence', async () => {
    const votes = [
      makeVote({ lens: 'correctness', refuted: false, classification: 'bug', confidence: 0.9 }),
      makeVote({ lens: 'security', refuted: false, classification: 'bug', confidence: 0.8 }),
      makeVote({ lens: 'intentionality', refuted: false, classification: 'bug', confidence: 0.85 }),
    ]
    const llm = makeSuccessLlm(votes)
    const verdict = await adjudicate(llm, sampleFinding, 'evidence', defaultRefutation)

    expect(verdict.classification).toBe('bug')
    expect(verdict.confirmedCount).toBe(3)
    expect(verdict.panelSize).toBe(3)
    // Mean confidence of confirmed bug votes: (0.9 + 0.8 + 0.85) / 3 ≈ 0.85
    expect(verdict.confidence).toBeCloseTo(0.85, 2)
    expect(verdict.votes).toHaveLength(3)
  })

  it('2/3 refuted successfully → uncertain', async () => {
    const votes = [
      makeVote({ lens: 'correctness', refuted: true, classification: 'bug', confidence: 0.7 }),
      makeVote({ lens: 'security', refuted: true, classification: 'bug', confidence: 0.6 }),
      makeVote({ lens: 'intentionality', refuted: false, classification: 'bug', confidence: 0.9 }),
    ]
    const llm = makeSuccessLlm(votes)
    const verdict = await adjudicate(llm, sampleFinding, 'evidence', defaultRefutation)

    expect(verdict.classification).toBe('uncertain')
    expect(verdict.confirmedCount).toBe(1)
    expect(verdict.panelSize).toBe(3)
  })

  it('3/3 fail to refute, 2 classify unnecessary and 1 bug → unnecessary', async () => {
    const votes = [
      makeVote({ lens: 'correctness', refuted: false, classification: 'unnecessary', confidence: 0.85 }),
      makeVote({ lens: 'security', refuted: false, classification: 'unnecessary', confidence: 0.9 }),
      makeVote({ lens: 'intentionality', refuted: false, classification: 'bug', confidence: 0.7 }),
    ]
    const llm = makeSuccessLlm(votes)
    const verdict = await adjudicate(llm, sampleFinding, 'evidence', defaultRefutation)

    expect(verdict.classification).toBe('unnecessary')
    expect(verdict.confirmedCount).toBe(3)
  })

  it('lenses replicated to fill panelSize when fewer lenses than panelSize', async () => {
    const refutation = {
      panelSize: 3,
      confidenceThreshold: 0.8,
      lenses: ['correctness', 'security'] as ('correctness' | 'security' | 'intentionality')[],
    }
    const votes = [
      makeVote({ lens: 'correctness', refuted: false }),
      makeVote({ lens: 'security', refuted: false }),
      makeVote({ lens: 'correctness', refuted: false }),
    ]
    const llm = makeSuccessLlm(votes)
    const verdict = await adjudicate(llm, sampleFinding, 'evidence', refutation)

    // The lenses assigned should cycle: correctness, security, correctness
    expect(verdict.votes[0]?.lens).toBe('correctness')
    expect(verdict.votes[1]?.lens).toBe('security')
    expect(verdict.votes[2]?.lens).toBe('correctness')
    expect(verdict.confirmedCount).toBe(3)
  })
})
