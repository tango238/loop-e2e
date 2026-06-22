import { logger } from '../../util/logger.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { DiscoveredForm, FormField } from './types.js'

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return m ? m[1] : undefined
}

function selectorFor(name: string | undefined, id: string | undefined, fallbackTag: string): string {
  if (name) return `[name="${name}"]`
  if (id) return `#${id}`
  return fallbackTag
}

/** Parse a rendered HTML page into a DiscoveredForm, or null if it has no inputs. */
export function parseFormFromHtml(html: string, screenPath: string): DiscoveredForm | null {
  const fields: FormField[] = []

  const inputRe = /<input\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0]
    const type = (attr(tag, 'type') ?? 'text').toLowerCase()
    if (['submit', 'button', 'hidden', 'reset', 'image'].includes(type)) continue
    const name = attr(tag, 'name')
    const id = attr(tag, 'id')
    if (!name && !id) continue
    fields.push({ name: name ?? id!, selector: selectorFor(name, id, `input[type="${type}"]`), htmlType: type })
  }

  for (const [tagName, defType] of [['select', 'select'], ['textarea', 'textarea']] as const) {
    const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
    while ((m = re.exec(html)) !== null) {
      const tag = m[0]
      const name = attr(tag, 'name')
      const id = attr(tag, 'id')
      if (!name && !id) continue
      fields.push({ name: name ?? id!, selector: selectorFor(name, id, tagName), htmlType: defType })
    }
  }

  if (fields.length === 0) return null

  const hasSubmitButton = /<button\b[^>]*type=["']submit["']/i.test(html) || /<input\b[^>]*type=["']submit["']/i.test(html)
  const submitSelector = hasSubmitButton ? 'button[type="submit"],input[type="submit"]' : 'button[type="submit"]'
  return { screenPath, submitSelector, fields }
}

/**
 * Navigate to each screen path and extract its form. Screens without inputs are skipped.
 * NOTE: parsing is regex-over-HTML on the post-`networkidle` `page.content()`; fields in shadow
 * DOM / web components are not seen. A DOM-based extractor (cf. extractPageInfo) would be more robust.
 */
export async function discoverForms(
  page: PageLike,
  target: TargetEnv,
  screenPaths: string[],
): Promise<DiscoveredForm[]> {
  const base = target.baseUrl.replace(/\/$/, '')
  const forms: DiscoveredForm[] = []
  for (const path of screenPaths) {
    const url = /^https?:\/\//i.test(path) ? path : `${base}/${path.replace(/^\//, '')}`
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      const form = parseFormFromHtml(await page.content(), path)
      if (form) forms.push(form)
      else logger.info({ path }, 'explore discover: no input fields — skipping screen')
    } catch (err) {
      logger.warn({ err: String(err), path }, 'explore discover: failed to load screen — skipping')
    }
  }
  return forms
}
