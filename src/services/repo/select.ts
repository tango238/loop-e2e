import { readdir, readFile, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { logger } from '../../util/logger.js'

export type SelectedFile = {
  path: string      // absolute path
  relPath: string   // relative to repo root
  content: string
  tokens: number
}

// --- Exclusion patterns ---

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'vendor',
  '.git',
  '.github',
  'coverage',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  'out',
  'target',   // Rust/Java
  'tmp',
  'temp',
])

const EXCLUDED_FILE_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Gemfile\.lock$/,
  /Cargo\.lock$/,
  /composer\.lock$/,
  /\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /generated\./,
  /\.generated\./,
  /\.pb\.go$/,
  /\.pb\.ts$/,
]

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mp3', '.mov', '.avi',
  '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat',
  '.pyc', '.class',
])

const TEST_DIR_PATTERNS = [
  /[/\\]__tests__[/\\]/,
  /[/\\]test[/\\]/,
  /[/\\]tests[/\\]/,
  /[/\\]spec[/\\]/,
  /[/\\]fixtures[/\\]/,
  /[/\\]mocks[/\\]/,
  /[/\\]__mocks__[/\\]/,
]

// --- High-signal file patterns (always included first) ---

const HIGH_SIGNAL_PATTERNS: Array<RegExp> = [
  // README
  /README(\.\w+)?$/i,
  // Docs directory
  /[/\\]docs?[/\\]/i,
  /[/\\]documentation[/\\]/i,
  // DB schemas and migrations
  /schema\.(sql|prisma|ts|js|rb|py)$/i,
  /[/\\]migrations?[/\\]/i,
  /[/\\]db[/\\]/i,
  /\.sql$/,
  // Routing
  /routes?\.(ts|js|rb|py|go)$/i,
  /[/\\]routes?[/\\]/i,
  /[/\\]router[/\\]/i,
  // OpenAPI / GraphQL
  /openapi\.(ya?ml|json)$/i,
  /swagger\.(ya?ml|json)$/i,
  /schema\.graphql$/,
  /\.graphql$/,
  /[/\\]graphql[/\\]/i,
]

// --- Heuristic scoring for other files ---

const SCORE_RULES: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /tsconfig\.json$/, score: 80 },
  { pattern: /package\.json$/, score: 75 },
  { pattern: /\.env\.example$/, score: 70 },
  { pattern: /[/\\]src[/\\]index\.(ts|js)$/, score: 65 },
  { pattern: /[/\\]src[/\\]main\.(ts|js)$/, score: 65 },
  { pattern: /[/\\]app\.(ts|js|py|rb)$/, score: 60 },
  { pattern: /[/\\]config[/\\]/, score: 50 },
  { pattern: /\.(ts|js)$/, score: 30 },
  { pattern: /\.(py|go|rb|java|rs)$/, score: 28 },
  { pattern: /\.(ya?ml|json)$/, score: 15 },
  { pattern: /\.(md|txt)$/, score: 10 },
]

function scoreFile(relPath: string): number {
  for (const { pattern, score } of SCORE_RULES) {
    if (pattern.test(relPath)) return score
  }
  return 5
}

function isHighSignal(relPath: string): boolean {
  return HIGH_SIGNAL_PATTERNS.some((p) => p.test(relPath))
}

function isExcluded(relPath: string, name: string): boolean {
  if (EXCLUDED_DIRS.has(name)) return true
  if (BINARY_EXTENSIONS.has(extname(name).toLowerCase())) return true
  if (EXCLUDED_FILE_PATTERNS.some((p) => p.test(relPath))) return true
  if (TEST_DIR_PATTERNS.some((p) => p.test('/' + relPath + '/'))) return true
  return false
}

/**
 * Estimate token count for `text` using a char-based heuristic with a
 * safety factor of 1.1 (slightly above the ~4 chars/token average for
 * code-heavy content).
 *
 * This is intentionally a fast approximation — correctness matters more
 * than precision here because we only use the estimate for budget gating.
 */
export function estimateTokens(text: string): number {
  const CHARS_PER_TOKEN = 4
  const SAFETY_FACTOR = 1.1
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_FACTOR)
}

/**
 * Walk `localPath` recursively and collect all eligible file paths with
 * their relative paths.
 */
async function walk(
  localPath: string,
  relBase: string,
  out: Array<{ abs: string; rel: string }>,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(localPath)
  } catch {
    return
  }

  for (const entry of entries) {
    const abs = join(localPath, entry)
    const rel = relBase ? `${relBase}/${entry}` : entry

    if (isExcluded(rel, entry)) continue

    let s
    try {
      s = await stat(abs)
    } catch {
      continue
    }

    if (s.isDirectory()) {
      await walk(abs, rel, out)
    } else if (s.isFile()) {
      out.push({ abs, rel })
    }
  }
}

/**
 * Select files from `localPath` up to `budget` tokens.
 *
 * Strategy:
 * 1. Walk the tree, excluding noise (binaries, generated, lock files, tests).
 * 2. Split into "high-signal" (always include first) and "other".
 * 3. Add high-signal files greedily until budget is consumed.
 * 4. Score and sort remaining files; add greedily until budget is consumed.
 */
export async function selectFiles(localPath: string, budget: number): Promise<SelectedFile[]> {
  const all: Array<{ abs: string; rel: string }> = []
  await walk(localPath, '', all)

  const highSignal: typeof all = []
  const other: typeof all = []

  for (const f of all) {
    if (isHighSignal(f.rel)) {
      highSignal.push(f)
    } else {
      other.push(f)
    }
  }

  // Sort other files by heuristic score descending
  other.sort((a, b) => scoreFile(b.rel) - scoreFile(a.rel))

  const selected: SelectedFile[] = []
  let usedTokens = 0

  async function tryAdd(abs: string, rel: string): Promise<void> {
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch {
      return
    }
    const tokens = estimateTokens(content)
    if (usedTokens + tokens > budget) return
    selected.push({ path: abs, relPath: rel, content, tokens })
    usedTokens += tokens
  }

  for (const f of highSignal) {
    await tryAdd(f.abs, f.rel)
  }
  for (const f of other) {
    if (usedTokens >= budget) break
    await tryAdd(f.abs, f.rel)
  }

  logger.debug(
    { selected: selected.length, usedTokens, budget },
    'File selection complete',
  )

  return selected
}
