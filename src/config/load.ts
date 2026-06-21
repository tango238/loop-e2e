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

  // Also collect auth passwordEnv references from targets
  for (const target of config.targets) {
    if (target.auth?.passwordEnv) {
      const envName = target.auth.passwordEnv
      const value = process.env[envName]
      if (!value) {
        missing.push(envName)
      }
    }
  }

  // Resolve required service secrets
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY']
  const githubToken = process.env['GITHUB_TOKEN']

  if (!anthropicApiKey) missing.push('ANTHROPIC_API_KEY')
  if (!githubToken) missing.push('GITHUB_TOKEN')

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const secrets: Secrets = {
    db: dbSecrets,
    anthropicApiKey: anthropicApiKey as string,
    githubToken: githubToken as string,
  }

  return { config, secrets }
}
