import { refreshRepo as defaultRefreshRepo } from '../services/repo/refresh.js'
import { runSetupHooks as defaultRunSetupHooks } from '../services/setup/setup.js'
import type { Config } from '../config/schema.js'
import type { refreshRepo } from '../services/repo/refresh.js'
import type { runSetupHooks } from '../services/setup/setup.js'

export type PrepareDeps = {
  refreshRepo?: typeof refreshRepo
  runSetupHooks?: typeof runSetupHooks
  secrets?: string[]
}

/**
 * The prepare pipeline phase:
 * ① For each repository that has a `branch` set, call refreshRepo in order.
 * ② If config.setup is set and non-empty, call runSetupHooks.
 *
 * All repo refreshes complete before setup hooks start (strict order).
 * Dependencies are injectable for unit testing.
 */
export async function prepare(
  config: Config,
  root: string,
  deps: PrepareDeps = {},
): Promise<void> {
  const refresh = deps.refreshRepo ?? defaultRefreshRepo
  const setupHooks = deps.runSetupHooks ?? defaultRunSetupHooks
  const { secrets } = deps

  // Step ①: refresh repos with a branch set, in order
  for (const repo of config.repositories) {
    if (repo.branch !== undefined) {
      await refresh(repo, repo.branch, root, { secrets })
    }
  }

  // Step ②: run setup hooks if configured and non-empty
  if (config.setup !== undefined && config.setup.length > 0) {
    await setupHooks(config.setup, root, { secrets })
  }
}
