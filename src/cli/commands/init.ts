import { join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { saveConfig } from '../../config/save.js'
import { ensureDir } from '../../util/fs.js'
import { logger } from '../../util/logger.js'
import { statePaths } from '../../state/paths.js'
import { parseRepoUrl } from '../../services/github/labels.js'
import type { Config } from '../../config/schema.js'
import type { GithubClient } from '../../services/github/client.js'
import type { RepoRef, LabelConfig } from '../../services/github/labels.js'

export interface InitOpts {
  [key: string]: unknown
}

export interface InitDeps {
  /** Collects config from the user (prompts or test mock) */
  prompt: (root: string, opts: InitOpts) => Promise<Config>
  /** Creates/skips labels on a single repo */
  ensureLabels: (client: GithubClient, repo: RepoRef, labels: LabelConfig) => Promise<void>
  /** Optional pre-built github client; if absent, ensureLabels receives null */
  githubClient?: GithubClient | null
}

function buildEnvExample(config: Config): string {
  const keys: string[] = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN']

  for (const db of config.databases) {
    if (!keys.includes(db.passwordEnv)) {
      keys.push(db.passwordEnv)
    }
  }

  for (const target of config.targets) {
    if (target.auth?.usernameEnv && !keys.includes(target.auth.usernameEnv)) {
      keys.push(target.auth.usernameEnv)
    }
    if (target.auth?.passwordEnv && !keys.includes(target.auth.passwordEnv)) {
      keys.push(target.auth.passwordEnv)
    }
  }

  return keys.map((k) => `${k}=`).join('\n') + '\n'
}

/** Returns the required ignore lines for this config (pure, no I/O). */
function buildGitignore(config: Config): string[] {
  const lines = ['.loop-e2e/', '.env']
  if (config.baseline.commit) {
    lines.push('!.loop-e2e/baseline/')
  }
  return lines
}

/** Merges required lines into existing .gitignore content, preserving user lines. */
function mergeGitignore(existing: string, required: string[]): string {
  const existingLines = existing.split('\n')
  const missing = required.filter((line) => !existingLines.includes(line))
  if (missing.length === 0) {
    return existing
  }
  const base = existing.endsWith('\n') ? existing : existing + '\n'
  return base + missing.join('\n') + '\n'
}

export async function runInit(root: string, opts: InitOpts, deps: InitDeps): Promise<void> {
  try {
    logger.info({ root }, 'running init')

    const config = await deps.prompt(root, opts)

    // Persist config
    await saveConfig(root, config)
    logger.info('config saved')

    // Write .env.example (env var names with empty values only)
    const envExamplePath = join(root, '.env.example')
    await writeFile(envExamplePath, buildEnvExample(config), 'utf8')
    logger.info('.env.example written')

    // Create scenario dir and state dirs
    const paths = statePaths(root)
    await ensureDir(join(root, config.scenarioDir))

    for (const dir of [paths.baseline, paths.runs, paths.reports, paths.feedback]) {
      await ensureDir(dir)
    }
    logger.info('directories created')

    // Write .gitignore — preserve existing user content, append only missing lines
    const gitignorePath = join(root, '.gitignore')
    const requiredLines = buildGitignore(config)
    let gitignoreContent: string
    try {
      const existing = await readFile(gitignorePath, 'utf8')
      gitignoreContent = mergeGitignore(existing, requiredLines)
    } catch {
      // File does not exist — create it
      gitignoreContent = requiredLines.join('\n') + '\n'
    }
    await writeFile(gitignorePath, gitignoreContent, 'utf8')
    logger.info('.gitignore written')

    // Ensure labels on each repo — skip entirely when github client is absent
    const githubClient = deps.githubClient ?? null
    if (githubClient === null) {
      if (config.repositories.length > 0) {
        logger.warn('GITHUB_TOKEN not set; skipping label creation')
      }
    } else {
      for (const repo of config.repositories) {
        const parsed = parseRepoUrl(repo.url)
        await deps.ensureLabels(
          githubClient,
          { owner: parsed.owner, name: parsed.name },
          { ready: config.github.labels.ready, autoDetect: config.github.labels.autoDetect },
        )
      }
    }

    logger.info('init complete')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`init failed: ${message}`)
  }
}
