import { describe, it, expect, vi } from 'vitest'
import { runSetupHooks } from './setup.js'

describe('runSetupHooks', () => {
  it('runs each command in order via sh -c with cwd=root', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' } })
    await runSetupHooks([{ command: 'echo a' }, { command: 'echo b' }], '/base', { runner })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(calls[0]).toEqual(['sh', '-c', 'echo a'])
    expect(calls[1]).toEqual(['sh', '-c', 'echo b'])
  })
  it('aborts on first failure and does not run later commands', async () => {
    const runner = vi.fn(async (_c: string, args: string[]) => { if (args[0] === '-c' && args[1] === 'bad') throw new Error('boom secret-xyz'); return { stdout: '', stderr: '' } })
    await expect(runSetupHooks([{ command: 'bad' }, { command: 'echo never' }], '/base', { runner, secrets: ['secret-xyz'] }))
      .rejects.toThrow(/setup command failed/)
    expect(runner).toHaveBeenCalledTimes(1) // second command not reached
  })
  it('does not leak a secret in the error message', async () => {
    const runner = vi.fn(async () => { throw new Error('fail secret-xyz') })
    await expect(runSetupHooks([{ command: 'x' }], '/base', { runner, secrets: ['secret-xyz'] }))
      .rejects.not.toThrow(/secret-xyz/)
  })
  it('is a no-op for empty/undefined setup', async () => {
    const runner = vi.fn()
    await runSetupHooks([], '/base', { runner })
    expect(runner).not.toHaveBeenCalled()
  })
})
