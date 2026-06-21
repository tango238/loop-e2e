import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { maskSecrets } from '../../util/mask.js'
import { logger } from '../../util/logger.js'
import type { ComposeRunner } from '../compose/compose.js'

const pexec = promisify(execFile)
const defaultRunner: ComposeRunner = (cmd, args, opts) =>
  pexec(cmd, args, opts) as Promise<{ stdout: string; stderr: string }>

export type SetupDeps = { runner?: ComposeRunner; secrets?: string[] }

export async function runSetupHooks(
  setup: { command: string }[],
  root: string,
  deps: SetupDeps = {},
): Promise<void> {
  const runner = deps.runner ?? defaultRunner
  const secrets = deps.secrets ?? []
  for (const { command } of setup) {
    logger.info({ command: maskSecrets(command, secrets) }, 'running setup hook')
    try {
      await runner('sh', ['-c', command], { cwd: root })
    } catch (err) {
      throw new Error(`setup command failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`)
    }
  }
}
