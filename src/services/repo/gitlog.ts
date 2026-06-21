import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../../util/logger.js'

const execFileDefault = promisify(execFileCb)

/**
 * Injectable git runner for git-log — same shape as the clone runner but
 * returns stdout so we can capture the log text.
 */
export type GitLogRunner = (
  file: string,
  args: string[],
  cwd: string,
) => Promise<string>

const defaultGitLogRunner: GitLogRunner = async (file, args, cwd) => {
  const { stdout } = await execFileDefault(file, args, { cwd })
  return stdout
}

/**
 * Run `git log -n <count> --pretty=format:"%H %ai %s"` in `localPath`
 * and return the raw output string.
 *
 * The pretty format intentionally stays concise to keep token usage low:
 *   <sha> <ISO-date> <subject line>
 */
export async function readGitLog(
  localPath: string,
  count: number,
  gitLogRunner: GitLogRunner = defaultGitLogRunner,
): Promise<string> {
  logger.debug({ localPath, count }, 'Reading git log')
  const output = await gitLogRunner(
    'git',
    ['log', `-n${count}`, '--pretty=format:%H %ai %s'],
    localPath,
  )
  return output
}
