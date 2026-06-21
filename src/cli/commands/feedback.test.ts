import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Llm } from '../../services/llm/client.js'
import type { Feedback } from '../../domain/types.js'
import type { FeedbackDeps, FeedbackOpts } from './feedback.js'
import { runFeedback } from './feedback.js'
import { loadFeedback, loadKnownFindings } from '../../state/store.js'
import { saveScenario, loadScenarios } from '../../scenario/schema.js'
import { statePaths } from '../../state/paths.js'
import { writeYaml } from '../../util/fs.js'
import type { Scenario } from '../../scenario/schema.js'
import type { Report } from '../../domain/types.js'

// --- helpers ---

function makeMockLlm(valid: boolean): Llm {
  return {
    complete: vi.fn().mockResolvedValue({
      valid,
      classification: valid ? 'false-positive' : 'misunderstanding',
      rationale: valid ? 'User is correct.' : 'User misunderstood the finding.',
    }),
  } as unknown as Llm
}

function makeReport(runId: string): Report {
  return {
    runId,
    startedAt: '2024-01-01T00:00:00.000Z',
    target: 'staging',
    diffFindings: [],
    verifyFindings: [
      {
        category: 'security',
        severity: 'high',
        title: 'Missing CSRF protection',
        detail: 'No CSRF token found in form submissions.',
        evidence: '<form>...</form>',
      },
    ],
    verdicts: {},
    siteStructureRef: 'run-001',
    summary: 'Test summary',
  }
}

function makeScenario(id: string): Scenario {
  return {
    id,
    title: 'Login scenario',
    businessFlow: 'User logs in',
    steps: [{ action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' }],
    expectedResults: [{ kind: 'ui', description: 'Login button', assertion: 'visible' }],
    expectedDbState: [],
  }
}

// --- tests ---

describe('feedback command', () => {
  let root: string
  let scenarioDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-feedback-'))
    scenarioDir = join(root, 'scenarios')
    // Write a run report that feedback can reference
    const paths = statePaths(root)
    const report = makeReport('run-001')
    await writeYaml(join(paths.reports, 'run-001', 'report.json'), report)
    // Write a scenario
    const scenario = makeScenario('sc-1')
    await saveScenario(scenarioDir, scenario)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('valid feedback — LLM says valid=true', () => {
    it('records the feedback with verdict=valid', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(true),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'This is a false positive.',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const feedbacks = await loadFeedback(root)
      expect(feedbacks).toHaveLength(1)
      expect(feedbacks[0]?.verdict).toBe('valid')
      expect(feedbacks[0]?.userComment).toBe('This is a false positive.')
    })

    it('registers the finding as known-state (suppresses future re-detection)', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(true),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'False positive',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const known = await loadKnownFindings(root)
      expect(known.length).toBeGreaterThan(0)
    })

    it('updates the referenced scenario expectedResults when valid feedback references one', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(true),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'CSRF token is in meta tag, not form field.',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const scenarios = await loadScenarios(scenarioDir)
      const sc = scenarios.find((s) => s.id === 'sc-1')
      // The feedback note should appear in expectedResults
      const hasNote = sc?.expectedResults.some((r) =>
        r.description.includes('feedback') || r.assertion.includes('feedback') ||
        r.description.includes('false-positive') || r.assertion.includes('false-positive') ||
        r.description.includes('[known]') || r.assertion.includes('[known]'),
      )
      expect(hasNote).toBe(true)
    })

    it('marks the feedback as appliedTo the scenario', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(true),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'False positive',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const feedbacks = await loadFeedback(root)
      expect(feedbacks[0]?.appliedTo).toContain('sc-1')
    })
  })

  describe('invalid feedback — LLM says valid=false', () => {
    it('records the feedback with verdict=invalid', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(false),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'I think this is fine.',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const feedbacks = await loadFeedback(root)
      expect(feedbacks).toHaveLength(1)
      expect(feedbacks[0]?.verdict).toBe('invalid')
    })

    it('does NOT mutate the scenario when feedback is invalid', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(false),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'I think this is fine.',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      const originalScenario = makeScenario('sc-1')
      await runFeedback(root, opts, deps)

      const scenarios = await loadScenarios(scenarioDir)
      const sc = scenarios.find((s) => s.id === 'sc-1')
      expect(sc?.expectedResults).toEqual(originalScenario.expectedResults)
    })

    it('does NOT add a known-state entry when feedback is invalid', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(false),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'I think this is fine.',
        scenarioId: 'sc-1',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const known = await loadKnownFindings(root)
      expect(known).toHaveLength(0)
    })
  })

  describe('edge cases', () => {
    it('works when no scenarioId is provided (comment-only feedback)', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(true),
        loadReport: async () => makeReport('run-001'),
      }
      const opts: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'General observation',
        scenarioDir,
      }

      await runFeedback(root, opts, deps)

      const feedbacks = await loadFeedback(root)
      expect(feedbacks).toHaveLength(1)
      expect(feedbacks[0]?.appliedTo).toEqual([])
    })

    it('generates a unique id per feedback item', async () => {
      const deps: FeedbackDeps = {
        llm: makeMockLlm(true),
        loadReport: async () => makeReport('run-001'),
      }
      const opts1: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'First',
        scenarioDir,
      }
      const opts2: FeedbackOpts = {
        runId: 'run-001',
        findingIndex: 0,
        comment: 'Second',
        scenarioDir,
      }

      await runFeedback(root, opts1, deps)
      await runFeedback(root, opts2, deps)

      const feedbacks = await loadFeedback(root)
      expect(feedbacks).toHaveLength(2)
      expect(feedbacks[0]?.id).not.toBe(feedbacks[1]?.id)
    })
  })
})
