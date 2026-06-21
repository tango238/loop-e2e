import { describe, it, expect } from 'vitest'
import { readGitLog, type GitLogRunner } from './gitlog.js'

describe('readGitLog', () => {
  it('calls git log with correct -n flag and pretty format', async () => {
    let capturedArgs: string[] = []
    let capturedCwd = ''

    const runner: GitLogRunner = async (file, args, cwd) => {
      capturedArgs = args
      capturedCwd = cwd
      return 'abc123 2024-01-01 Fix login bug\ndef456 2024-01-02 Add dashboard'
    }

    const result = await readGitLog('/fake/repo', 50, runner)

    expect(capturedArgs[0]).toBe('log')
    expect(capturedArgs).toContain('-n50')
    expect(capturedCwd).toBe('/fake/repo')
    expect(result).toContain('Fix login bug')
  })

  it('passes count as part of -n<count> argument', async () => {
    let capturedArgs: string[] = []
    const runner: GitLogRunner = async (_, args) => {
      capturedArgs = args
      return ''
    }

    await readGitLog('/repo', 25, runner)
    expect(capturedArgs).toContain('-n25')
  })

  it('returns raw output from git log', async () => {
    const expected = 'abc123 2024-01-01T12:00:00+0000 Initial commit'
    const runner: GitLogRunner = async () => expected
    const result = await readGitLog('/repo', 1, runner)
    expect(result).toBe(expected)
  })

  it('returns empty string when log has no entries', async () => {
    const runner: GitLogRunner = async () => ''
    const result = await readGitLog('/repo', 10, runner)
    expect(result).toBe('')
  })
})
