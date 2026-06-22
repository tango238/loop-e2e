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

const baseValid = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' } }],
  databases: [],
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
  it('leaves language unset by default (consumer defaults to Japanese)', () => {
    expect(ConfigSchema.parse(valid).language).toBeUndefined()
  })
  it('accepts an explicit language', () => {
    expect(ConfigSchema.parse({ ...valid, language: 'en' }).language).toBe('en')
  })
  it('rejects an empty language string', () => {
    expect(() => ConfigSchema.parse({ ...valid, language: '' })).toThrow()
  })
})

describe('LaunchSchema', () => {
  it('accepts a valid launch config', () => {
    const cfg = ConfigSchema.parse({ ...baseValid, launch: {
      compose: { files: ['docker-compose.yml'], projectName: 'e2e' },
      readiness: { url: 'http://localhost:3000/login' },
      seed: { command: 'docker compose exec -T backend npm run seed:test' },
      targetName: 'local',
    } })
    expect(cfg.launch?.readiness.timeoutSec).toBe(180) // default
    expect(cfg.launch?.readiness.intervalSec).toBe(3)  // default
  })
  it('omits launch when not provided', () => {
    expect(ConfigSchema.parse(baseValid).launch).toBeUndefined()
  })
  it('rejects launch with empty compose.files', () => {
    expect(() => ConfigSchema.parse({ ...baseValid, launch: {
      compose: { files: [], projectName: 'e2e' }, readiness: { url: 'http://x' }, targetName: 'local',
    } })).toThrow()
  })
})

describe('branch + setup schema', () => {
  const base = {
    repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
    targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'none' } }],
    databases: [],
    schedule: { intervalMinutes: 60 },
    scenarioDir: 'scenarios',
    github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  }

  it('accepts optional repo branch and setup commands', () => {
    const cfg = ConfigSchema.parse({
      ...base,
      repositories: [{ ...base.repositories[0], branch: 'main' }],
      setup: [{ command: 'echo hi' }, { command: 'docker compose exec -T app true' }],
    })
    expect(cfg.repositories[0].branch).toBe('main')
    expect(cfg.setup?.length).toBe(2)
  })
  it('omits branch and setup when not provided', () => {
    const cfg = ConfigSchema.parse(base)
    expect(cfg.repositories[0].branch).toBeUndefined()
    expect(cfg.setup).toBeUndefined()
  })
  it('rejects a setup entry with empty command', () => {
    expect(() => ConfigSchema.parse({ ...base, setup: [{ command: '' }] })).toThrow()
  })
})

describe('twoFactor + grow schema', () => {
  const base = {
    repositories: [{ name: 'web', label: 'l', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
    targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'U', passwordEnv: 'P' } }],
    databases: [], schedule: { intervalMinutes: 60 }, scenarioDir: 'scenarios',
    github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  }

  it('accepts twoFactor on auth and grow config with defaults', () => {
    const cfg = ConfigSchema.parse({
      ...base,
      targets: [{ ...base.targets[0], auth: { ...base.targets[0].auth, twoFactor: { pinCommand: 'echo 123456' } } }],
      grow: {},
    })
    expect(cfg.targets[0].auth?.twoFactor?.pinCommand).toBe('echo 123456')
    expect(cfg.grow?.maxPages).toBe(50)   // default
    expect(cfg.grow?.maxDepth).toBe(3)    // default
  })
  it('omits twoFactor and grow when absent', () => {
    const cfg = ConfigSchema.parse(base)
    expect(cfg.targets[0].auth?.twoFactor).toBeUndefined()
    expect(cfg.grow).toBeUndefined()
  })
  it('rejects twoFactor with empty pinCommand', () => {
    expect(() => ConfigSchema.parse({ ...base, targets: [{ ...base.targets[0], auth: { ...base.targets[0].auth, twoFactor: { pinCommand: '' } } }] })).toThrow()
  })
})
