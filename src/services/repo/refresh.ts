import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { maskSecrets } from '../../util/mask.js'
import { logger } from '../../util/logger.js'
import { ensureRepoClone, type RepoConfig } from './clone.js'
import type { ComposeRunner } from '../compose/compose.js'

const pexec = promisify(execFile)
const defaultGitRunner: ComposeRunner = (cmd, args, opts) =>
  pexec(cmd, args, opts) as Promise<{ stdout: string; stderr: string }>

export type RefreshDeps = { gitRunner?: ComposeRunner; secrets?: string[]; gitToken?: string }

/**
 * Refresh a cloned repo to the latest of `branch`:
 * stash (if dirty) → fetch → checkout → pull → restore WIP
 * (auto-drop when no conflict, leave stashed + warn on conflict).
 */
export async function refreshRepo(
  repo: RepoConfig,
  branch: string,
  root: string,
  deps: RefreshDeps = {},
): Promise<void> {
  const git = deps.gitRunner ?? defaultGitRunner
  const secrets = deps.secrets ?? []
  const gitToken = deps.gitToken ?? ''
  const cwd = join(root, 'repos', repo.name)

  const run = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await git('git', args, { cwd })
      return stdout
    } catch (err) {
      throw new Error(`git ${args[0]} failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`)
    }
  }

  // Adapt ComposeRunner to the GitRunner interface expected by ensureRepoClone.
  // ensureRepoClone's GitRunner returns Promise<void>; ComposeRunner returns Promise<{stdout,stderr}>.
  const cloneGitRunner = async (file: string, args: string[], cloneCwd?: string): Promise<void> => {
    await git(file, args, cloneCwd ? { cwd: cloneCwd } : undefined)
  }

  // Ensure the clone exists — pass the github token explicitly (NOT secrets[0]).
  // The secrets array is purely for masking error messages.
  await ensureRepoClone(
    repo,
    gitToken,
    { cloneDepth: 50, tokenBudgetPerRepo: 120_000, gitLogCount: 50 },
    root,
    cloneGitRunner,
  )

  const porcelain = await run(['status', '--porcelain'])
  const dirty = porcelain.trim().length > 0

  if (dirty) {
    await run(['stash', 'push', '-u', '-m', `loop-e2e auto-stash ${repo.name}`])
    logger.info({ repo: repo.name }, 'stashed local changes before refresh')
  }

  await run(['fetch', 'origin', branch])
  await run(['checkout', branch])
  await run(['pull', '--ff-only', 'origin', branch])

  if (dirty) {
    // Restore WIP. Use apply (not pop) so a conflict leaves the stash intact.
    // Route through run() so any error message has secrets masked before we inspect or re-throw it.
    try {
      await run(['stash', 'apply'])
      await run(['stash', 'drop'])
      logger.info({ repo: repo.name }, 'restored stashed changes (no conflict)')
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (/conflict/i.test(msg)) {
        // Conflict: undo the partial apply, keep the stash, warn and continue.
        await run(['reset', '--hard', 'HEAD']).catch(() => {})
        logger.warn(
          { repo: repo.name },
          'stash conflict on auto-restore — WIP kept in stash; run `git stash pop` manually to restore',
        )
      } else {
        // Unexpected error — already masked by run(); re-throw so the caller knows.
        throw err
      }
    }
  }
}
