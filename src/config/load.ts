import { join } from 'node:path'
import dotenv from 'dotenv'
import { readYaml } from '../util/fs.js'
import type { Secrets } from '../domain/types.js'
import { CONFIG_FILENAME, ConfigSchema, type Config } from './schema.js'

export async function loadConfig(root: string): Promise<{ config: Config; secrets: Secrets }> {
  // Load .env from the project root so env vars are available for secret resolution
  dotenv.config({ path: join(root, '.env') })

  const raw = await readYaml<unknown>(join(root, CONFIG_FILENAME))
  const config = ConfigSchema.parse(raw)

  // Collect all required env var names from databases
  const dbEnvNames = config.databases.map((db) => db.passwordEnv)

  // Resolve database secrets
  const dbSecrets: Record<string, string> = {}
  const missing: string[] = []

  for (const envName of dbEnvNames) {
    const value = process.env[envName]
    if (!value) {
      missing.push(envName)
    } else {
      dbSecrets[envName] = value
    }
  }

  // Resolve target auth secrets (usernameEnv + passwordEnv per target).
  // Both are required when referenced by a target's auth config.
  const targetAuthSecrets: Record<string, string> = {}

  for (const target of config.targets) {
    for (const envName of [target.auth?.usernameEnv, target.auth?.passwordEnv]) {
      if (!envName) continue
      const value = process.env[envName]
      if (!value) {
        missing.push(envName)
      } else {
        targetAuthSecrets[envName] = value
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  // Service secrets are OPTIONAL — needed only by specific commands
  // (ANTHROPIC_API_KEY for AI scenario generation / verification, GITHUB_TOKEN for
  // issue filing). Resolve to empty string when absent so launch/login-only flows
  // (init, down, login execution) work without them; commands that need them fail
  // with a clear message at point of use.
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
  const githubToken = process.env['GITHUB_TOKEN'] ?? ''

  const secrets: Secrets = {
    db: dbSecrets,
    targetAuth: targetAuthSecrets,
    anthropicApiKey,
    githubToken,
  }

  return { config, secrets }
}
