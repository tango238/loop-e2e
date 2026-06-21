import { describe, it, expect, vi } from 'vitest'
import { composeUp, composeDown } from './compose.js'

const launch = { compose: { files: ['a.yml', 'b.yml'], projectName: 'e2e', envFile: '.env' },
  readiness: { url: 'http://x', timeoutSec: 180, intervalSec: 3 }, targetName: 'local' }

describe('composeUp', () => {
  it('invokes docker compose up -d with -p, -f files and --env-file', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' } })
    await composeUp(launch as any, '/base', runner)
    expect(runner).toHaveBeenCalledTimes(1)
    const args = calls[0]
    expect(args[0]).toBe('docker')
    expect(args).toContain('compose'); expect(args).toContain('-p'); expect(args).toContain('e2e')
    expect(args).toContain('-f'); expect(args).toContain('a.yml'); expect(args).toContain('b.yml')
    expect(args).toContain('--env-file'); expect(args).toContain('.env')
    expect(args).toContain('up'); expect(args).toContain('-d')
  })
  it('wraps runner errors with a clear message and no secret leak', async () => {
    const runner = vi.fn(async () => { throw new Error('boom token=secret123') })
    await expect(composeUp(launch as any, '/base', runner, ['secret123']))
      .rejects.toThrow(/compose up failed/)
    await expect(composeUp(launch as any, '/base', runner, ['secret123']))
      .rejects.not.toThrow(/secret123/)
  })
})

describe('composeDown', () => {
  it('invokes docker compose down with -p, -f files and --volumes when opts.volumes=true', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' } })
    const state = { projectName: 'e2e', composeFiles: ['a.yml', 'b.yml'] }
    await composeDown(state, '/base', { volumes: true }, runner)
    expect(runner).toHaveBeenCalledTimes(1)
    const args = calls[0]
    expect(args[0]).toBe('docker')
    expect(args).toContain('compose'); expect(args).toContain('-p'); expect(args).toContain('e2e')
    expect(args).toContain('-f'); expect(args).toContain('a.yml'); expect(args).toContain('b.yml')
    expect(args).toContain('down'); expect(args).toContain('--volumes')
  })
  it('omits --volumes when opts.volumes is false or undefined', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' } })
    const state = { projectName: 'e2e', composeFiles: ['a.yml'] }
    await composeDown(state, '/base', {}, runner)
    expect(runner).toHaveBeenCalledTimes(1)
    const args = calls[0]
    expect(args).not.toContain('--volumes')
    expect(args).toContain('down')
  })
  it('wraps runner errors with a clear message and no secret leak', async () => {
    const runner = vi.fn(async () => { throw new Error('connection failed token=secret123') })
    const state = { projectName: 'e2e', composeFiles: ['a.yml'] }
    await expect(composeDown(state, '/base', {}, runner, ['secret123']))
      .rejects.toThrow(/compose down failed/)
    await expect(composeDown(state, '/base', {}, runner, ['secret123']))
      .rejects.not.toThrow(/secret123/)
  })
})
