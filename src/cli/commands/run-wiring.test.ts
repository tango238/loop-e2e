import { describe, it, expect, vi } from 'vitest'
import { buildTargetResolver, buildDbQuery } from './run.js'
import type { Config } from '../../config/schema.js'

const config = {
  targets: [
    { name: 'admin', baseUrl: 'https://admin.test', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'A_U', passwordEnv: 'A_P' } },
    { name: 'storefront', baseUrl: 'https://shop.test', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'S_U', passwordEnv: 'S_P' } },
  ],
  databases: [{ name: 'main', type: 'postgres', host: 'h', port: 5432, database: 'd', user: 'u', passwordEnv: 'DB_P' }],
} as unknown as Config

const secrets = { targetAuth: { A_U: 'a', A_P: 'ap', S_U: 's', S_P: 'sp' }, db: { DB_P: 'x' } } as never

describe('buildTargetResolver', () => {
  it('resolves a target name to TargetEnv + creds', () => {
    const r = buildTargetResolver(config, secrets)('storefront')
    expect(r?.target.baseUrl).toBe('https://shop.test')
    expect(r?.creds).toEqual({ username: 's', password: 'sp' })
  })
  it('returns undefined for an unknown or credential-less target', () => {
    expect(buildTargetResolver(config, secrets)('ghost')).toBeUndefined()
  })
})

describe('buildDbQuery', () => {
  it('lazily creates one adapter per connection and closes all', async () => {
    const query = vi.fn(async () => [{ id: 1 }])
    const close = vi.fn(async () => {})
    const createDbAdapter = vi.fn(() => ({ query, close }))
    const { dbQuery, close: closeAll } = buildDbQuery(config, { DB_P: 'x' }, undefined, createDbAdapter as never)
    await dbQuery!('main', 'SELECT 1')
    await dbQuery!('main', 'SELECT 2') // reuses the same adapter
    expect(createDbAdapter).toHaveBeenCalledTimes(1)
    await closeAll()
    expect(close).toHaveBeenCalledOnce()
  })
  it('returns undefined dbQuery when no databases are configured', () => {
    const { dbQuery } = buildDbQuery({ ...config, databases: [] } as Config, {}, undefined)
    expect(dbQuery).toBeUndefined()
  })
})
