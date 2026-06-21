import { describe, it, expect, vi } from 'vitest'
import { seedDatabase } from './seed.js'

describe('seedDatabase', () => {
  it('runs sh -c "<command>" with cwd: root', async () => {
    const calls: Array<[string, string[], { cwd?: string } | undefined]> = []
    const runner = vi.fn(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push([cmd, args, opts])
      return { stdout: '', stderr: '' }
    })
    await seedDatabase({ command: 'npm run seed' }, '/base', runner)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(calls[0][0]).toBe('sh')
    expect(calls[0][1]).toEqual(['-c', 'npm run seed'])
    expect(calls[0][2]).toEqual({ cwd: '/base' })
  })

  it('wraps runner errors with a clear message and no secret leak', async () => {
    const runner = vi.fn(async () => { throw new Error('connection failed token=mysecret') })
    await expect(seedDatabase({ command: 'seed' }, '/base', runner, ['mysecret']))
      .rejects.toThrow(/seed failed/)
    await expect(seedDatabase({ command: 'seed' }, '/base', runner, ['mysecret']))
      .rejects.not.toThrow(/mysecret/)
  })
})
