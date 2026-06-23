import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import type { DiffFinding, VerifyFinding, FindingVerdict, RunContext } from '../domain/types.js'
import type { Llm } from '../services/llm/client.js'
import type { Config } from '../config/schema.js'
import { writeReport, renderReport } from './report.js'

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
      language: 'ja',
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
    // evidence must be non-empty so the Opus panel has context
    const [, , evidenceArg] = adjudicateMock.mock.calls[0] as [unknown, unknown, string]
    expect(evidenceArg).toBeTruthy()
    expect(evidenceArg.length).toBeGreaterThan(0)
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

  it('ユーザー確認要 section states the page for each uncertain finding (verify + diff)', async () => {
    const verifyFinding: VerifyFinding = {
      category: 'security',
      severity: 'medium',
      title: 'CSRF protection not detected',
      detail: 'Page contains a <form> but no CSRF token was found.',
      evidence: '[https://app.example.com/login] no csrf_token pattern',
    }
    const diffFinding = makeDiffFinding({ location: '/dashboard' })
    const adjudicateMock = vi.fn().mockResolvedValue(makeVerdict({ classification: 'uncertain', confidence: 0.5 }))
    const ctx = makeCtx(tmpRoot)

    await writeReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [diffFinding],
      verifyFindings: [verifyFinding],
      llm: makeMockLlm(),
      adjudicate: adjudicateMock,
      upsertIssue: vi.fn().mockResolvedValue(undefined),
      store: { saveBaseline: vi.fn().mockResolvedValue(undefined) },
      githubClient: null,
      repo: null,
      currentStructure: { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] },
    })

    const md = await readFile(join(tmpRoot, '.loop-e2e', 'reports', ctx.runId, 'report.md'), 'utf8')
    expect(md).toContain('ユーザー確認要')
    expect(md).toContain('**ページ:**')
    // verify finding's page (extracted from evidence) and diff finding's location both appear
    expect(md).toContain('https://app.example.com/login')
    expect(md).toContain('/dashboard')
  })

  it('falls back to a relative screen path when no URL is present (input-validation)', async () => {
    const finding: VerifyFinding = {
      category: 'input-validation',
      severity: 'high',
      title: '入力チェック漏れ: /user/create age',
      detail: '不正値「-1」が /user/create の age で拒否されませんでした。',
      evidence: 'selector=[name="age"] expectation=reject confidence=high',
    }
    const ctx = makeCtx(tmpRoot)
    await writeReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [],
      verifyFindings: [finding],
      llm: makeMockLlm(),
      adjudicate: vi.fn().mockResolvedValue(makeVerdict({ classification: 'uncertain', confidence: 0.5 })),
      upsertIssue: vi.fn().mockResolvedValue(undefined),
      store: { saveBaseline: vi.fn().mockResolvedValue(undefined) },
      githubClient: null,
      repo: null,
      currentStructure: { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] },
    })
    const md = await readFile(join(tmpRoot, '.loop-e2e', 'reports', ctx.runId, 'report.md'), 'utf8')
    expect(md).toMatch(/\*\*ページ:\*\* \/user\/create/)
  })

  it('renderReport: includes an 実施サマリ from activity and does not require a store', async () => {
    const ctx = makeCtx(tmpRoot)
    await renderReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [],
      verifyFindings: [],
      activity: [
        { source: 'grow', runId: 'g1', startedAt: 't', summary: 'proposed 36 scenarios' },
        { source: 'run', runId: 'r1', startedAt: 't', summary: 'executed 6 scenarios' },
      ],
      llm: makeMockLlm(),
      adjudicate: vi.fn(),
      upsertIssue: vi.fn(),
      githubClient: null,
      repo: null,
    })
    const md = await readFile(join(tmpRoot, '.loop-e2e', 'reports', ctx.runId, 'report.md'), 'utf8')
    expect(md).toContain('実施サマリ')
    expect(md).toContain('[grow] proposed 36 scenarios')
    expect(md).toContain('[run] executed 6 scenarios')
  })

  it('renderReport: de-duplicates findings with the same fingerprint across sources', async () => {
    const ctx = makeCtx(tmpRoot)
    const dup: VerifyFinding = { category: 'security', severity: 'medium', title: 'CSRF', detail: 'no token', evidence: '[https://x/login] e' }
    const adjudicateMock = vi.fn().mockResolvedValue(makeVerdict({ classification: 'uncertain', confidence: 0.5 }))
    await renderReport(tmpRoot, ctx.runId, {
      ctx,
      diffFindings: [],
      verifyFindings: [dup, { ...dup }], // same fingerprint (category/title/detail)
      llm: makeMockLlm(),
      adjudicate: adjudicateMock,
      upsertIssue: vi.fn(),
      githubClient: null,
      repo: null,
    })
    // adjudicate runs once per unique finding → de-duplicated to 1
    expect(adjudicateMock).toHaveBeenCalledTimes(1)
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

  it('secrets from ctx do not appear in written report.md or report.json', async () => {
    const secretApiKey = 'sk-SHOULD-NOT-APPEAR-IN-REPORT'
    const secretGhToken = 'gh-SHOULD-NOT-APPEAR-IN-REPORT'

    // Inject secret values into finding fields so they'd appear if not masked
    const finding = makeDiffFinding({
      expected: `Expected value with ${secretApiKey}`,
      actual: `Actual value with ${secretGhToken}`,
    })
    const verdict = makeVerdict({ classification: 'bug', confidence: 0.9, rationale: `rationale with ${secretApiKey}` })
    const adjudicateMock = vi.fn().mockResolvedValue(verdict)
    const upsertIssueMock = vi.fn().mockResolvedValue(undefined)
    const storeMock = { saveBaseline: vi.fn().mockResolvedValue(undefined) }
    const llm: Llm = {
      complete: vi.fn().mockResolvedValue(`Summary mentioning ${secretApiKey}`),
    } as unknown as Llm

    const ctx: RunContext = {
      ...makeCtx(tmpRoot),
      secrets: {
        db: { DB_PASS: 'db-secret-value' },
        targetAuth: { AUTH_PASS: 'auth-secret-value' },
        anthropicApiKey: secretApiKey,
        githubToken: secretGhToken,
      },
    }

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

    const reportDir = join(tmpRoot, '.loop-e2e', 'reports', ctx.runId)
    const mdContent = await readFile(join(reportDir, 'report.md'), 'utf8')
    const jsonContent = await readFile(join(reportDir, 'report.json'), 'utf8')

    // Neither the API key nor the GitHub token should appear in any written file
    expect(mdContent).not.toContain(secretApiKey)
    expect(mdContent).not.toContain(secretGhToken)
    expect(jsonContent).not.toContain(secretApiKey)
    expect(jsonContent).not.toContain(secretGhToken)
  })
})
