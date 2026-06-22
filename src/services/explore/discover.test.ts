import { describe, it, expect } from 'vitest'
import { discoverForms, parseFormFromHtml } from './discover.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'

const target: TargetEnv = { name: 't', baseUrl: 'http://app' }

const formHtml = `
<form>
  <input name="email" type="email" />
  <input name="age" type="number" />
  <select name="role"><option>admin</option></select>
  <textarea name="bio"></textarea>
  <button type="submit">Save</button>
</form>`

function fakePage(htmlByPath: Record<string, string>): PageLike {
  let url = 'http://app/'
  return {
    url: () => url,
    title: async () => 'x',
    content: async () => htmlByPath[new URL(url).pathname] ?? '<html></html>',
    goto: async (u: string) => { url = u },
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 0 }),
  }
}

describe('parseFormFromHtml', () => {
  it('extracts input/select/textarea fields + a submit selector', () => {
    const form = parseFormFromHtml(formHtml, '/user/create')
    expect(form).not.toBeNull()
    expect(form!.fields.map((f) => f.name).sort()).toEqual(['age', 'bio', 'email', 'role'])
    expect(form!.fields.find((f) => f.name === 'email')!.htmlType).toBe('email')
    expect(form!.submitSelector).toBeTruthy()
  })

  it('returns null when there are no input fields', () => {
    expect(parseFormFromHtml('<div>no form</div>', '/x')).toBeNull()
  })
})

describe('discoverForms', () => {
  it('returns one DiscoveredForm per screen that has inputs, skipping empty ones', async () => {
    const page = fakePage({ '/user/create': formHtml, '/empty': '<div>nothing</div>' })
    const forms = await discoverForms(page, target, ['/user/create', '/empty'])
    expect(forms).toHaveLength(1)
    expect(forms[0].screenPath).toBe('/user/create')
  })
})
