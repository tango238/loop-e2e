import { describe, it, expect } from 'vitest'
import { ConfigSchema } from './schema.js'

const valid = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'staging', baseUrl: 'https://staging.example.com', auth: { strategy: 'none' } }],
  databases: [{ name: 'main', type: 'postgres', host: 'localhost', port: 5432, database: 'app', user: 'app', passwordEnv: 'DB_MAIN_PASSWORD' }],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
}

describe('ConfigSchema', () => {
  it('accepts a valid config', () => { expect(ConfigSchema.parse(valid)).toMatchObject(valid) })
  it('rejects invalid db type', () => {
    expect(() => ConfigSchema.parse({ ...valid, databases: [{ ...valid.databases[0], type: 'oracle' }] })).toThrow()
  })
  it('rejects intervalMinutes < 1', () => {
    expect(() => ConfigSchema.parse({ ...valid, schedule: { intervalMinutes: 0 } })).toThrow()
  })
})
