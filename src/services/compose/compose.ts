import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { maskSecrets } from '../../util/mask.js'
import type { Launch } from '../../config/schema.js'

const pexec = promisify(execFile)
export type ComposeRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
export const defaultComposeRunner: ComposeRunner = (cmd, args, opts) => pexec(cmd, args, opts) as Promise<{ stdout: string; stderr: string }>

function baseArgs(projectName: string, files: string[], envFile?: string): string[] {
  const args = ['compose', '-p', projectName]
  for (const f of files) { args.push('-f', f) }
  if (envFile) { args.push('--env-file', envFile) }
  return args
}

export async function composeUp(launch: Launch, root: string, runner: ComposeRunner = defaultComposeRunner, secrets: string[] = []): Promise<void> {
  const args = [...baseArgs(launch.compose.projectName, launch.compose.files, launch.compose.envFile), 'up', '-d']
  try { await runner('docker', args, { cwd: root }) }
  catch (err) { throw new Error(`compose up failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`) }
}

export async function composeDown(state: { projectName: string; composeFiles: string[] }, root: string, opts: { volumes?: boolean }, runner: ComposeRunner = defaultComposeRunner, secrets: string[] = []): Promise<void> {
  const args = [...baseArgs(state.projectName, state.composeFiles), 'down']
  if (opts.volumes) { args.push('--volumes') }
  try { await runner('docker', args, { cwd: root }) }
  catch (err) { throw new Error(`compose down failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`) }
}
