import { describe, it, expect, vi } from 'vitest'
import { refreshRepo } from './refresh.js'

const repo = { name: 'web', label: 'l', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' } as const

// gitRunner mock that records the git subcommands and returns canned output per command.
function makeGit(porcelain: string, applyFails = false) {
  const calls: string[][] = []
  const runner = vi.fn(async (cmd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'status') return { stdout: porcelain, stderr: '' }
    if (args[0] === 'stash' && args[1] === 'apply' && applyFails) throw new Error('CONFLICT (content): Merge conflict')
    return { stdout: '', stderr: '' }
  })
  return { runner, calls }
}
const sub = (calls: string[][]) => calls.map((a) => a.join(' '))

describe('refreshRepo', () => {
  it('clean tree: fetch → checkout → pull, no stash', async () => {
    const { runner, calls } = makeGit('') // empty porcelain = clean
    await refreshRepo(repo, 'main', '/base', { gitRunner: runner })
    const seq = sub(calls)
    expect(seq.some((s) => s.startsWith('stash push'))).toBe(false)
    expect(seq).toContain('checkout main')
    expect(seq.some((s) => s.startsWith('fetch'))).toBe(true)
    expect(seq.some((s) => s.startsWith('pull'))).toBe(true)
  })

  it('dirty tree, no conflict: stash → checkout → pull → apply → drop (auto restore)', async () => {
    const { runner, calls } = makeGit(' M file.ts\n')
    await refreshRepo(repo, 'main', '/base', { gitRunner: runner })
    const seq = sub(calls)
    expect(seq.some((s) => s.startsWith('stash push'))).toBe(true)
    const iApply = seq.findIndex((s) => s === 'stash apply')
    const iDrop = seq.findIndex((s) => s === 'stash drop')
    expect(iApply).toBeGreaterThan(-1)
    expect(iDrop).toBeGreaterThan(iApply) // drop only after a successful apply
    // checkout happened before apply
    expect(seq.findIndex((s) => s === 'checkout main')).toBeLessThan(iApply)
  })

  it('dirty tree, apply conflict: reset --hard, keep stash (no drop), do not throw', async () => {
    const { runner, calls } = makeGit(' M file.ts\n', /* applyFails */ true)
    await expect(refreshRepo(repo, 'main', '/base', { gitRunner: runner })).resolves.toBeUndefined()
    const seq = sub(calls)
    expect(seq).toContain('stash apply')
    expect(seq.some((s) => s.startsWith('reset --hard'))).toBe(true)
    expect(seq).not.toContain('stash drop') // WIP preserved in stash
  })

  it('masks the token if a git error message contains it', async () => {
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') return { stdout: '', stderr: '' }
      if (args[0] === 'pull') throw new Error('fatal: auth failed for tok-secret-123')
      return { stdout: '', stderr: '' }
    })
    await expect(refreshRepo(repo, 'main', '/base', { gitRunner: runner, secrets: ['tok-secret-123'] }))
      .rejects.not.toThrow(/tok-secret-123/)
  })
})
