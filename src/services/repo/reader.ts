import { readFile } from 'node:fs/promises'
import { logger } from '../../util/logger.js'
import { selectFiles, estimateTokens } from './select.js'
import { summarizeIfOverBudget } from './summarize.js'
import { readGitLog, type GitLogRunner } from './gitlog.js'
import { ensureRepoClone, type GitRunner } from './clone.js'
import type { Llm } from '../llm/client.js'
import type { Config } from '../../config/schema.js'

export type RepoConfig = Config['repositories'][number]
export type IngestionConfig = Config['ingestion']

/**
 * Rich requirement context gathered from a single repository.
 * Consumed by scenarioGen to generate scenarios.
 */
export type RequirementContext = {
  repo: RepoConfig
  /** Raw README content (empty string if not found) */
  readme: string
  /** Additional documentation file contents */
  docs: string[]
  /** Source code, either raw or LLM-summarized (if over budget) */
  codeSummary: string
  /** Recent git log entries */
  gitlogSummary: string
}

export type CollectReaderDeps = {
  llm: Llm
  token: string
  root: string
  ingestion: IngestionConfig
  /** Optional extra requirement files to merge in (from --from flag) */
  fromPaths?: string[]
  gitRunner?: GitRunner
  gitLogRunner?: GitLogRunner
}

/**
 * Collect requirement context for every repository.
 * Optionally merges additional requirement files passed via `--from`.
 */
export async function collectRequirements(
  repos: RepoConfig[],
  deps: CollectReaderDeps,
): Promise<RequirementContext[]> {
  const contexts = await Promise.all(
    repos.map((repo) => collectForRepo(repo, deps)),
  )

  // Merge --from requirement files into each context's codeSummary
  if (deps.fromPaths && deps.fromPaths.length > 0) {
    const fromContents = await loadFromFiles(deps.fromPaths)
    return contexts.map((ctx) => ({
      ...ctx,
      codeSummary: [ctx.codeSummary, ...fromContents].filter(Boolean).join('\n\n---\n\n'),
    }))
  }

  return contexts
}

async function collectForRepo(
  repo: RepoConfig,
  deps: CollectReaderDeps,
): Promise<RequirementContext> {
  logger.info({ repo: repo.name }, 'Collecting requirements')

  const localPath = await ensureRepoClone(
    repo,
    deps.token,
    deps.ingestion,
    deps.root,
    deps.gitRunner,
  )

  const [files, gitlogSummary] = await Promise.all([
    selectFiles(localPath, deps.ingestion.tokenBudgetPerRepo),
    readGitLog(localPath, deps.ingestion.gitLogCount, deps.gitLogRunner),
  ])

  // Extract README from selected files
  const readmeFile = files.find(
    (f) => /^README(\.\w+)?$/i.test(f.relPath) || /[/\\]README(\.\w+)?$/i.test(f.relPath),
  )
  const readme = readmeFile?.content ?? ''

  // Extract doc files
  const docFiles = files.filter(
    (f) =>
      /[/\\]docs?[/\\]/i.test('/' + f.relPath) ||
      /[/\\]documentation[/\\]/i.test('/' + f.relPath),
  )
  const docs = docFiles.map((f) => f.content)

  // Source files are everything else
  const sourceFiles = files.filter(
    (f) => f !== readmeFile && !docFiles.includes(f),
  )

  const codeSummary = await summarizeIfOverBudget(
    deps.llm,
    sourceFiles,
    deps.ingestion.tokenBudgetPerRepo,
  )

  logger.info({ repo: repo.name, selectedFiles: files.length }, 'Requirements collected')

  return { repo, readme, docs, codeSummary, gitlogSummary }
}

async function loadFromFiles(paths: string[]): Promise<string[]> {
  const contents: string[] = []
  for (const p of paths) {
    try {
      const content = await readFile(p, 'utf8')
      contents.push(`// from: ${p}\n${content}`)
    } catch (err) {
      logger.warn({ path: p, err }, 'Could not read --from file')
    }
  }
  return contents
}
