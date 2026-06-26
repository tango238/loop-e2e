import { spawn } from 'node:child_process'

/**
 * Backend that drives the Claude Code CLI (`claude -p` / `claude --print`) as a subprocess
 * instead of calling the Anthropic API. This lets developers run all AI features against
 * their local `claude` login with no ANTHROPIC_API_KEY, while CI / production keep using the
 * API. The prompt is sent on stdin; the model reply is read from stdout as JSON.
 */

export type ClaudeCliRunner = (params: {
  bin: string
  model: string
  prompt: string
  timeoutMs: number
}) => Promise<string>

export const DEFAULT_CLI_BIN = 'claude'
export const DEFAULT_CLI_TIMEOUT_MS = 300_000

/**
 * Spawns `claude --print --output-format json --model <model>` and pipes the prompt in on
 * stdin. Resolves with the raw stdout (a JSON document); rejects on non-zero exit, spawn
 * failure (e.g. `claude` not on PATH), or timeout.
 */
export const defaultClaudeCliRunner: ClaudeCliRunner = ({ bin, model, prompt, timeoutMs }) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['--print', '--output-format', 'json', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `Could not run the Claude Code CLI: '${bin}' was not found on PATH. ` +
              `Install it (npm i -g @anthropic-ai/claude-code) and run 'claude' once to log in, ` +
              `or unset USE_CLAUDE_CODE to use the Anthropic API.`,
          ),
        )
      } else {
        reject(new Error(`Failed to launch the Claude Code CLI ('${bin}'): ${err.message}`))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `claude CLI exited with code ${code}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`,
          ),
        )
      }
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })

/**
 * Extracts the assistant's text from the Claude Code CLI's `--output-format json` payload.
 * The success shape is a single object with a string `result` field; we also tolerate the
 * stream-json array shape (objects with `type: "result"`) and fall back to the raw output so
 * the shared JSON-extraction/parse logic upstream can still try to make sense of it.
 */
export function parseClaudeCliOutput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Not JSON (e.g. CLI run without --output-format json) — hand back the raw text.
    return trimmed
  }

  // Stream shape: an array of events; the final result carries the text.
  if (Array.isArray(parsed)) {
    const result = parsed.find(
      (e): e is { type: string; result?: string } =>
        typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'result',
    )
    if (result && typeof result.result === 'string') return result.result
    return trimmed
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as { result?: unknown; content?: unknown; is_error?: unknown }
    if (typeof obj.result === 'string') return obj.result
    if (typeof obj.content === 'string') return obj.content
  }

  return trimmed
}
