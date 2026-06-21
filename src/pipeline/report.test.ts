import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import type { DiffFinding, VerifyFinding, FindingVerdict, RunContext } from '../domain/types.js'
import type { Llm } from '../services/llm/client.js'
import type { Config } from '../config/schema.js'
import { writeReport } from './report.js'

const defaultRefutation: Config['refutation'] = {
  panelSize: 3,
  confidenceThreshold: 0.8,
  lenses: ['correctness', 'security', 'intentionality'],
}

const defaultModels: Config['models'] = {
  planning: 'claude-opus-4-8',
  report: 'claude-sonnet-4-6',
  verification: 'claude-opus-4-8',
}

function makeDiffFinding(overrides: Partial<DiffFinding> = {}): DiffFinding {
  return {
    kind: 'transition',
    severity: 'high',
    expected: 'nav link present',
    actual: 'nav link removed',
    location: '/home',
    ...overrides,
  }
}

function makeVerdict(overrides: Partial<FindingVerdict> = {}): FindingVerdict {
  return {
    classification: 'bug',
    confidence: 0.9,
    confirmedCount: 3,
    panelSize: 3,
    votes: [],
    rationale: 'Clearly a bug',
    ...overrides,
  }
}

function makeMockLlm(): Llm {
  return {
    complete: vi.fn().mockResolvedValue('## Report\n\nFindings summary here.'),
  } as unknown as Llm
}

function makeCtx(root: string): RunContext {
  return {
    root,
    runId: 'run-2024-01-01',
    config: {
      repositories: [{ name: 'repo', label: 'repo', url: 'https://github.com/o/r', role: 'frontend', audience: 'user' }],
      targets: [{ name: 'staging', baseUrl: 'https://staging.example.com' }],
      databases: [],
      schedule: { intervalMinutes: 60 },
      scenarioDir: 'scenarios',
      github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
      baseline: { commit: false },
      models: defaultModels,
      ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
      refutation: defaultRefutation,
    },
    secrets: {
      db: {},
      targetAuth: {},
      anthropicApiKey: 'sk-test',
      githubToken: 'gh-test',
    },
  }
}

describe('writeReport', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = join(tmpdir(), `report-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpRoot, { recursive: true })
  })

  it('gate-pass: bug + confidence≥0.8 → upsertIssue called, report.md and report.json written', async () => {
    const finding = makeDiffFinding()
    const verdict = makeVerdict({ classification: 'bug', confidence: 0.9 })
    const adjudicateMock = vi.fn().mockResolvedValue(verdict)
    const upsertIssueMock = vi.fn().mockResolvedValue(undefined)
    const storeMock = { saveBaseline: vi.fn().mockResolvedValue(undefined) }
    const llm = makeMockLlm()
    const ctx = makeCtx(tmpRoot)

    await writeReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [finding],
      verifyFindings: [],
      llm,
      adjudicate: adjudicateMock,
      upsertIssue: upsertIssueMock,
      store: storeMock,
      githubClient: {} as never,
      repo: { owner: 'acme', name: 'myapp' },
      currentStructure: { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] },
    })

    expect(upsertIssueMock).toHaveBeenCalledOnce()
    const reportDir = join(tmpRoot, '.loop-e2e', 'reports', ctx.runId)
    const mdContent = await readFile(join(reportDir, 'report.md'), 'utf8')
    const jsonContent = await readFile(join(reportDir, 'report.json'), 'utf8')
    expect(mdContent).toBeTruthy()
    const parsed = JSON.parse(jsonContent) as { runId: string }
    expect(parsed.runId).toBe(ctx.runId)
  })

  it('gate-fail confidence<0.8: verdict.confidence=0.5 → upsertIssue NOT called, report written', async () => {
    const finding = makeDiffFinding()
    const verdict = makeVerdict({ classification: 'bug', confidence: 0.5 })
    const adjudicateMock = vi.fn().mockResolvedValue(verdict)
    const upsertIssueMock = vi.fn().mockResolvedValue(undefined)
    const storeMock = { saveBaseline: vi.fn().mockResolvedValue(undefined) }
    const ctx = makeCtx(tmpRoot)

    await writeReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [finding],
      verifyFindings: [],
      llm: makeMockLlm(),
      adjudicate: adjudicateMock,
      upsertIssue: upsertIssueMock,
      store: storeMock,
      githubClient: {} as never,
      repo: { owner: 'acme', name: 'myapp' },
      currentStructure: { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] },
    })

    expect(upsertIssueMock).not.toHaveBeenCalled()
    const reportDir = join(tmpRoot, '.loop-e2e', 'reports', ctx.runId)
    const mdContent = await readFile(join(reportDir, 'report.md'), 'utf8')
    expect(mdContent).toContain('ユーザー確認要')
  })

  it('gate-fail uncertain: classification=uncertain → upsertIssue NOT called', async () => {
    const finding = makeDiffFinding()
    const verdict = makeVerdict({ classification: 'uncertain', confidence: 0.9 })
    const adjudicateMock = vi.fn().mockResolvedValue(verdict)
    const upsertIssueMock = vi.fn().mockResolvedValue(undefined)
    const storeMock = { saveBaseline: vi.fn().mockResolvedValue(undefined) }
    const ctx = makeCtx(tmpRoot)

    await writeReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [finding],
      verifyFindings: [],
      llm: makeMockLlm(),
      adjudicate: adjudicateMock,
      upsertIssue: upsertIssueMock,
      store: storeMock,
      githubClient: null,
      repo: null,
      currentStructure: { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] },
    })

    expect(upsertIssueMock).not.toHaveBeenCalled()
  })

  it('no findings: empty input → report still written, no upsertIssue', async () => {
    const adjudicateMock = vi.fn()
    const upsertIssueMock = vi.fn()
    const storeMock = { saveBaseline: vi.fn().mockResolvedValue(undefined) }
    const ctx = makeCtx(tmpRoot)

    await writeReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [],
      verifyFindings: [],
      llm: makeMockLlm(),
      adjudicate: adjudicateMock,
      upsertIssue: upsertIssueMock,
      store: storeMock,
      githubClient: null,
      repo: null,
      currentStructure: { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] },
    })

    expect(upsertIssueMock).not.toHaveBeenCalled()
    expect(adjudicateMock).not.toHaveBeenCalled()
    const reportDir = join(tmpRoot, '.loop-e2e', 'reports', ctx.runId)
    const jsonRaw = await readFile(join(reportDir, 'report.json'), 'utf8')
    const parsed = JSON.parse(jsonRaw) as { diffFindings: unknown[] }
    expect(parsed.diffFindings).toHaveLength(0)
  })
})
