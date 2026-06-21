import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectFiles, estimateTokens } from './select.js'

describe('estimateTokens', () => {
  it('returns a positive integer for non-empty text', () => {
    const t = estimateTokens('hello world')
    expect(t).toBeGreaterThan(0)
    expect(Number.isInteger(t)).toBe(true)
  })

  it('is monotonic — more text → more tokens', () => {
    const short = estimateTokens('short')
    const long = estimateTokens('a'.repeat(1000))
    expect(long).toBeGreaterThan(short)
  })

  it('returns 0 or positive for empty string', () => {
    expect(estimateTokens('')).toBeGreaterThanOrEqual(0)
  })
})

describe('selectFiles', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-select-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeFiles(files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, content, 'utf8')
    }
  }

  it('returns empty array for an empty directory', async () => {
    const result = await selectFiles(root, 100000)
    expect(result).toEqual([])
  })

  it('always includes README (high-signal)', async () => {
    await writeFiles({
      'README.md': '# My App\n' + 'x'.repeat(100),
      'unrelated.txt': 'other',
    })
    const result = await selectFiles(root, 100000)
    const readme = result.find((f) => f.relPath === 'README.md')
    expect(readme).toBeDefined()
  })

  it('excludes node_modules', async () => {
    await writeFiles({
      'node_modules/lodash/index.js': 'module.exports = {}',
      'src/index.ts': 'export {}',
    })
    const result = await selectFiles(root, 100000)
    expect(result.every((f) => !f.relPath.includes('node_modules'))).toBe(true)
  })

  it('excludes dist directory', async () => {
    await writeFiles({
      'dist/bundle.js': 'minified code',
      'src/app.ts': 'export const x = 1',
    })
    const result = await selectFiles(root, 100000)
    expect(result.every((f) => !f.relPath.startsWith('dist'))).toBe(true)
  })

  it('excludes lock files', async () => {
    await writeFiles({
      'pnpm-lock.yaml': 'lockfile content here',
      'src/main.ts': 'export {}',
    })
    const result = await selectFiles(root, 100000)
    expect(result.every((f) => !f.relPath.includes('pnpm-lock.yaml'))).toBe(true)
  })

  it('respects token budget — total tokens must not exceed budget', async () => {
    // Each file ~30 tokens; budget of 50 means only ~1-2 files fit
    const content = 'a'.repeat(100) // ~27 tokens
    await writeFiles({
      'README.md': content,
      'src/a.ts': content,
      'src/b.ts': content,
      'src/c.ts': content,
    })
    const budget = 60  // tight budget
    const result = await selectFiles(root, budget)
    const totalTokens = result.reduce((sum, f) => sum + f.tokens, 0)
    expect(totalTokens).toBeLessThanOrEqual(budget)
  })

  it('selects SQL schema files as high-signal', async () => {
    await writeFiles({
      'db/schema.sql': 'CREATE TABLE users (id INT, name TEXT)',
      'src/random.ts': 'export const x = 1',
    })
    const result = await selectFiles(root, 100000)
    expect(result.some((f) => f.relPath.includes('schema.sql'))).toBe(true)
  })

  it('selects OpenAPI files as high-signal', async () => {
    await writeFiles({
      'openapi.yaml': 'openapi: 3.0.0\ninfo:\n  title: API',
      'src/index.ts': 'export {}',
    })
    const result = await selectFiles(root, 100000)
    expect(result.some((f) => f.relPath.includes('openapi.yaml'))).toBe(true)
  })

  it('populates path, relPath, content, and tokens fields', async () => {
    await writeFiles({ 'README.md': '# hello' })
    const result = await selectFiles(root, 100000)
    expect(result.length).toBeGreaterThan(0)
    const file = result[0]!
    expect(typeof file.path).toBe('string')
    expect(typeof file.relPath).toBe('string')
    expect(typeof file.content).toBe('string')
    expect(typeof file.tokens).toBe('number')
    expect(file.tokens).toBeGreaterThan(0)
  })
})
