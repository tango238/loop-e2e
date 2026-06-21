import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRequirements, type RequirementContext, type RepoConfig, type IngestionConfig } from './reader.js'
import type { Llm } from '../llm/client.js'
import type { GitLogRunner } from './gitlog.js'

const repo: RepoConfig = {
  name: 'test-app',
  label: 'Test App',
  url: 'https://github.com/acme/test-app',
  role: 'backend',
  audience: 'user',
}

const ingestion: IngestionConfig = {
  cloneDepth: 5,
  tokenBudgetPerRepo: 100000,
  gitLogCount: 10,
}

function makeMockLlm(): Llm {
  const mock = vi.fn(async () => 'mocked summary')
  return { complete: mock } as unknown as Llm
}

describe('collectRequirements', () => {
  it('returns RequirementContext for each repo reading from repos/<name> directly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(repoDir, { recursive: true })
    await mkdir(join(repoDir, 'src'), { recursive: true })
    await writeFile(join(repoDir, 'README.md'), '# Test App\nDoes stuff', 'utf8')
    await writeFile(join(repoDir, 'src', 'index.ts'), 'export const x = 1', 'utf8')

    const gitLogRunner: GitLogRunner = async () => 'abc123 2024-01-01 Initial commit'

    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      gitLogRunner,
    })

    expect(contexts).toHaveLength(1)
    const ctx = contexts[0] as RequirementContext
    expect(ctx.repo.name).toBe(repo.name)
    expect(ctx.readme).toContain('Test App')
    expect(ctx.gitlogSummary).toContain('Initial commit')

    await rm(root, { recursive: true, force: true })
  })

  it('throws a clear error when repos/<name> does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    // deliberately do NOT create repos/test-app

    await expect(
      collectRequirements([repo], {
        llm: makeMockLlm(),
        token: 'fake-token',
        root,
        ingestion,
      }),
    ).rejects.toThrow("repository not cloned: test-app — run 'loop-e2e init' first")

    await rm(root, { recursive: true, force: true })
  })

  it('does not call ensureRepoClone (no gitRunner passed, yet succeeds when repos/<name> exists)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'README.md'), '# App', 'utf8')

    const gitLogRunner: GitLogRunner = async () => ''

    // No gitRunner injected — if ensureRepoClone were called it would try real git and fail
    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      gitLogRunner,
    })

    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.readme).toContain('App')

    await rm(root, { recursive: true, force: true })
  })

  it('merges --from files into codeSummary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const fromFile = join(tmpdir(), 'extra-requirements.md')
    await writeFile(fromFile, '# Extra Requirements\nMust handle payments')

    const repoDir = join(root, 'repos', repo.name)
    await mkdir(join(repoDir, 'src'), { recursive: true })
    await writeFile(join(repoDir, 'src', 'index.ts'), 'export {}', 'utf8')

    const gitLogRunner: GitLogRunner = async () => ''

    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      fromPaths: [fromFile],
      gitLogRunner,
    })

    expect(contexts[0]?.codeSummary).toContain('Extra Requirements')

    await rm(root, { recursive: true, force: true })
    await rm(fromFile, { force: true })
  })

  it('populates docs array with docs directory files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(join(repoDir, 'docs'), { recursive: true })
    await writeFile(join(repoDir, 'docs', 'api.md'), '# API Docs')
    await writeFile(join(repoDir, 'README.md'), '# Readme')

    const gitLogRunner: GitLogRunner = async () => ''

    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      gitLogRunner,
    })

    expect(contexts[0]?.docs.length).toBeGreaterThan(0)
    expect(contexts[0]?.docs[0]).toContain('API Docs')

    await rm(root, { recursive: true, force: true })
  })

  it('docs files do not appear in codeSummary (no double-counting)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(join(repoDir, 'docs'), { recursive: true })
    await mkdir(join(repoDir, 'src'), { recursive: true })
    const docContent = 'UNIQUE_DOC_SENTINEL_XYZ: This belongs only in docs[]'
    await writeFile(join(repoDir, 'docs', 'guide.md'), docContent)
    await writeFile(join(repoDir, 'src', 'index.ts'), 'export const x = 1')
    await writeFile(join(repoDir, 'README.md'), '# Readme')

    const llm: Llm = { complete: vi.fn(async () => 'summarized source') } as unknown as Llm

    const gitLogRunner: GitLogRunner = async () => ''

    const contexts = await collectRequirements([repo], {
      llm,
      token: 'fake-token',
      root,
      ingestion,
      gitLogRunner,
    })

    const ctx = contexts[0]
    // docs field must include the doc content
    expect(ctx?.docs.some((d) => d.includes('UNIQUE_DOC_SENTINEL_XYZ'))).toBe(true)
    // codeSummary must NOT contain the doc content
    expect(ctx?.codeSummary).not.toContain('UNIQUE_DOC_SENTINEL_XYZ')

    await rm(root, { recursive: true, force: true })
  })
})
