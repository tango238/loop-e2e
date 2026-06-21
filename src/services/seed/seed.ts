import { maskSecrets } from '../../util/mask.js'
import type { ComposeRunner } from '../compose/compose.js'

export async function seedDatabase(
  seed: { command: string },
  root: string,
  runner: ComposeRunner = defaultRunner,
  secrets: string[] = [],
): Promise<void> {
  try {
    await runner('sh', ['-c', seed.command], { cwd: root })
  } catch (err) {
    throw new Error(`seed failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`)
  }
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)
const defaultRunner: ComposeRunner = (cmd, args, opts) => pexec(cmd, args, opts)
