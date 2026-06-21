import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { statePaths } from '../../state/paths.js'
import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import type { Config } from '../../config/schema.js'

const execFileDefault = promisify(execFileCb)

/** A repository record from Config */
export type RepoConfig = Config['repositories'][number]

/** Ingestion settings from Config */
export type IngestionConfig = Config['ingestion']

/**
 * Injectable git runner — wraps execFile so tests can substitute a mock
 * without touching the real file system or network.
 *
 * @param file  The executable (always "git" in production)
 * @param args  Arguments passed to git
 * @param cwd   Working directory (used for fetch; absent for clone)
 */
export type GitRunner = (file: string, args: string[], cwd?: string) => Promise<void>

const defaultGitRunner: GitRunner = async (file, args, cwd) => {
  await execFileDefault(file, args, cwd ? { cwd } : {})
}

/**
 * Ensures a shallow clone of `repo.url` exists at `repos/<name>`.
 * - If the directory does not exist: clones with `--depth cloneDepth`.
 * - If the directory already exists: runs `git fetch`.
 * The GitHub token is embedded in the URL as `https://<token>@github.com/...`
 * and is masked in all log output.
 *
 * @returns Absolute path to the local clone directory.
 */
export async function ensureRepoClone(
  repo: RepoConfig,
  token: string,
  ingestion: IngestionConfig,
  root: string,
  gitRunner: GitRunner = defaultGitRunner,
): Promise<string> {
  const localPath = join(root, 'repos', repo.name)
  const authenticatedUrl = embedToken(repo.url, token)
  const maskedUrl = maskSecrets(authenticatedUrl, [token])

  const exists = await dirExists(localPath)

  if (!exists) {
    logger.info({ repo: repo.name, url: maskedUrl }, 'Cloning repository')
    try {
      await gitRunner(
        'git',
        ['clone', '--depth', String(ingestion.cloneDepth), authenticatedUrl, localPath],
      )
    } catch (err) {
      const masked = maskSecrets(String((err as Error)?.message ?? err), [token])
      throw new Error(`git clone failed: ${masked}`)
    }
    logger.info({ repo: repo.name }, 'Clone complete')
  } else {
    logger.info({ repo: repo.name }, 'Repository exists — fetching latest')
    try {
      await gitRunner('git', ['fetch', '--depth', String(ingestion.cloneDepth)], localPath)
    } catch (err) {
      const masked = maskSecrets(String((err as Error)?.message ?? err), [token])
      throw new Error(`git fetch failed: ${masked}`)
    }
    logger.info({ repo: repo.name }, 'Fetch complete')
  }

  return localPath
}

/**
 * Embed a GitHub token in an HTTPS URL.
 * `https://github.com/owner/repo` → `https://<token>@github.com/owner/repo`
 */
function embedToken(url: string, token: string): string {
  return url.replace('https://', `https://${token}@`)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
