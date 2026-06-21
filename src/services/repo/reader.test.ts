import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRequirements, type RequirementContext, type RepoConfig, type IngestionConfig } from './reader.js'
import type { Llm } from '../llm/client.js'
import type { GitRunner } from './clone.js'
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
  let tempRepoDir: string
  let root: string

  // We need to set up a fake local path that the gitRunner will "clone" into.
  // We override ensureRepoClone via the gitRunner (which creates the dir).

  async function setupFakeRepo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-repo-'))
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, content, 'utf8')
    }
    return dir
  }

  it('returns RequirementContext for each repo', async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    tempRepoDir = await setupFakeRepo({
      'README.md': '# Test App\nDoes stuff',
      'src/index.ts': 'export const x = 1',
    })

    // gitRunner: simulates clone by noting the target dir path
    // We need to make ensureRepoClone return our tempRepoDir.
    // Since the real ensureRepoClone computes the path as `root/repos/name`,
    // we pre-create that dir with our files.
    const expectedCloneDir = join(root, 'repos', repo.name)
    await mkdir(expectedCloneDir, { recursive: true })
    // Copy files
    for (const [rel, content] of Object.entries({
      'README.md': '# Test App\nDoes stuff',
      'src/index.ts': 'export const x = 1',
    })) {
      const abs = join(expectedCloneDir, rel)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, content, 'utf8')
    }

    const gitRunner: GitRunner = async () => {}  // no-op: dir already exists
    const gitLogRunner: GitLogRunner = async () => 'abc123 2024-01-01 Initial commit'

    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      gitRunner,
      gitLogRunner,
    })

    expect(contexts).toHaveLength(1)
    const ctx = contexts[0] as RequirementContext
    expect(ctx.repo.name).toBe(repo.name)
    expect(ctx.readme).toContain('Test App')
    expect(ctx.gitlogSummary).toContain('Initial commit')

    await rm(root, { recursive: true, force: true })
    await rm(tempRepoDir, { recursive: true, force: true })
  })

  it('merges --from files into codeSummary', async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const fromFile = join(tmpdir(), 'extra-requirements.md')
    await writeFile(fromFile, '# Extra Requirements\nMust handle payments')

    const expectedCloneDir = join(root, 'repos', repo.name)
    await mkdir(expectedCloneDir, { recursive: true })
    await writeFile(join(expectedCloneDir, 'src', 'index.ts'), 'export {}', 'utf8').catch(
      async () => {
        await mkdir(join(expectedCloneDir, 'src'), { recursive: true })
        await writeFile(join(expectedCloneDir, 'src', 'index.ts'), 'export {}', 'utf8')
      },
    )

    const gitRunner: GitRunner = async () => {}
    const gitLogRunner: GitLogRunner = async () => ''

    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      fromPaths: [fromFile],
      gitRunner,
      gitLogRunner,
    })

    expect(contexts[0]?.codeSummary).toContain('Extra Requirements')

    await rm(root, { recursive: true, force: true })
    await rm(fromFile, { force: true })
  })

  it('populates docs array with docs directory files', async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const expectedCloneDir = join(root, 'repos', repo.name)
    await mkdir(join(expectedCloneDir, 'docs'), { recursive: true })
    await writeFile(join(expectedCloneDir, 'docs', 'api.md'), '# API Docs')
    await writeFile(join(expectedCloneDir, 'README.md'), '# Readme')

    const gitRunner: GitRunner = async () => {}
    const gitLogRunner: GitLogRunner = async () => ''

    const contexts = await collectRequirements([repo], {
      llm: makeMockLlm(),
      token: 'fake-token',
      root,
      ingestion,
      gitRunner,
      gitLogRunner,
    })

    expect(contexts[0]?.docs.length).toBeGreaterThan(0)
    expect(contexts[0]?.docs[0]).toContain('API Docs')

    await rm(root, { recursive: true, force: true })
  })

  it('docs files do not appear in codeSummary (no double-counting)', async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-reader-root-'))
    const expectedCloneDir = join(root, 'repos', repo.name)
    await mkdir(join(expectedCloneDir, 'docs'), { recursive: true })
    await mkdir(join(expectedCloneDir, 'src'), { recursive: true })
    const docContent = 'UNIQUE_DOC_SENTINEL_XYZ: This belongs only in docs[]'
    await writeFile(join(expectedCloneDir, 'docs', 'guide.md'), docContent)
    await writeFile(join(expectedCloneDir, 'src', 'index.ts'), 'export const x = 1')
    await writeFile(join(expectedCloneDir, 'README.md'), '# Readme')

    // Use a real LLM mock that passes source content through (simulates summarize passthrough)
    const llm: Llm = { complete: vi.fn(async () => 'summarized source') } as unknown as Llm

    const gitRunner: GitRunner = async () => {}
    const gitLogRunner: GitLogRunner = async () => ''

    const contexts = await collectRequirements([repo], {
      llm,
      token: 'fake-token',
      root,
      ingestion,
      gitRunner,
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
