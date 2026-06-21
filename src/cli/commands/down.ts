import { logger } from '../../util/logger.js'
import type { ProcessState } from '../../state/process.js'
import type { ComposeRunner } from '../../services/compose/compose.js'
import type { Secrets } from '../../domain/types.js'

export interface DownOpts {
  volumes?: boolean
}

export interface DownDeps {
  loadProcessState: (root: string) => Promise<ProcessState | null>
  composeDown: (
    state: { projectName: string; composeFiles: string[] },
    root: string,
    opts: { volumes?: boolean },
    runner?: ComposeRunner,
    secrets?: string[],
  ) => Promise<void>
  clearProcessState: (root: string) => Promise<void>
  secrets?: Secrets
  composeRunner?: ComposeRunner
}

export async function runDown(root: string, opts: DownOpts, deps: DownDeps): Promise<void> {
  const state = await deps.loadProcessState(root)

  if (state === null) {
    logger.info('no running stack')
    return
  }

  const secrets = deps.secrets ?? { anthropicApiKey: '', githubToken: '', db: {}, targetAuth: {} }
  const allSecrets = [
    secrets.anthropicApiKey,
    secrets.githubToken,
    ...Object.values(secrets.db),
    ...Object.values(secrets.targetAuth),
  ].filter(Boolean) as string[]

  await deps.composeDown(state, root, { volumes: opts.volumes ?? false }, deps.composeRunner, allSecrets)
  await deps.clearProcessState(root)

  logger.info('stack stopped and state cleared')
}
