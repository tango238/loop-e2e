import { describe, it, expect } from 'vitest'
import { runCase, collectErrorsFromHtml } from './execute.js'
import type { PageLike } from '../browser/crawler.js'
import type { DiscoveredForm, Baseline, InputCase } from './types.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: '#submit',
  fields: [
    { name: 'email', selector: '#email', htmlType: 'email' },
    { name: 'age', selector: '#age', htmlType: 'number' },
  ],
}
const baseline: Baseline = { '#email': 'valid@example.com', '#age': '30' }

type FakeOpts = { afterSubmitUrl?: string; afterSubmitHtml?: string }
function fakePage(startUrl: string, html: string, opts: FakeOpts = {}): PageLike & { filled: Record<string, string> } {
  const filled: Record<string, string> = {}
  let url = startUrl
  let body = html
  return {
    filled,
    url: () => url,
    title: async () => 'x',
    content: async () => body,
    goto: async (u: string) => { url = u },
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: (selector: string) => ({
      fill: async (v: string) => { filled[selector] = v },
      click: async () => {
        if (selector === '#submit') {
          if (opts.afterSubmitUrl) url = opts.afterSubmitUrl
          if (opts.afterSubmitHtml !== undefined) body = opts.afterSubmitHtml
        }
      },
      count: async () => 1,
    }),
  }
}

describe('collectErrorsFromHtml', () => {
  it('extracts text from error-class elements', () => {
    const html = `<div class="error">メールアドレスの形式が不正です</div><span id="age-error">範囲外</span>`
    const errs = collectErrorsFromHtml(html)
    expect(errs.join(' ')).toContain('形式が不正')
    expect(errs.join(' ')).toContain('範囲外')
  })

  it('returns [] when no error elements', () => {
    expect(collectErrorsFromHtml('<div class="ok">fine</div>')).toEqual([])
  })

  it('does not match negation-ish classes like "errorless"', () => {
    expect(collectErrorsFromHtml('<div class="errorless">all good</div>')).toEqual([])
  })
})

describe('runCase', () => {
  it('fills baseline + overrides the target field, then observes a shown error', async () => {
    const page = fakePage('http://app/user/create', '<form></form>', {
      afterSubmitHtml: '<div class="error">invalid email</div>',
    })
    const target: InputCase = { field: 'email', selector: '#email', value: 'notanemail', expectation: 'reject', rationale: 'malformed' }
    const out = await runCase(page, form, baseline, target, { getLastStatus: () => 422, sleep: async () => {} })
    expect(page.filled['#age']).toBe('30')         // baseline kept
    expect(page.filled['#email']).toBe('notanemail') // target overridden
    expect(out.errorsShown.join(' ')).toContain('invalid email')
    expect(out.submitStatus).toBe(422)
    expect(out.navigatedAway).toBe(false)
  })

  it('detects navigation away with no error (validation gap signal)', async () => {
    const page = fakePage('http://app/user/create', '<form></form>', {
      afterSubmitUrl: 'http://app/user/42',
      afterSubmitHtml: '<div class="ok">saved</div>',
    })
    const target: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min' }
    const out = await runCase(page, form, baseline, target, { getLastStatus: () => 200, sleep: async () => {} })
    expect(out.errorsShown).toEqual([])
    expect(out.navigatedAway).toBe(true)
    expect(out.finalUrl).toBe('http://app/user/42')
  })

  it('masks secrets from shown errors', async () => {
    const page = fakePage('http://app/user/create', '<form></form>', {
      afterSubmitHtml: '<div class="error">bad token s3cr3t</div>',
    })
    const target: InputCase = { field: 'email', selector: '#email', value: 'x', expectation: 'reject', rationale: 'r' }
    const out = await runCase(page, form, baseline, target, { secrets: ['s3cr3t'], sleep: async () => {} })
    expect(out.errorsShown.join(' ')).not.toContain('s3cr3t')
  })
})
