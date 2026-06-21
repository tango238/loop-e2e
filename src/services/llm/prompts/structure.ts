import type { RawPage } from '../../../domain/types.js'

/**
 * Builds the prompt for extracting structured PageInfo from a raw crawled page.
 * Used by structureExtract (role: planning).
 */
export function buildStructurePrompt(raw: RawPage): string {
  const metaEntries = Object.entries(raw.meta)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')

  return `You are a web QA analyst. Analyze the following web page and extract structured information.

URL: ${raw.url}
Title: ${raw.title}
${metaEntries ? `Meta tags:\n${metaEntries}` : ''}

HTML (truncated to 8000 chars):
${raw.html.slice(0, 8000)}

Return a JSON object with exactly these fields:
{
  "url": "${raw.url}",
  "title": "page title",
  "description": "one-sentence description of what this page does",
  "meta": { "key": "value" },
  "displayItems": [
    { "type": "heading|text|image|list|table|button|link", "label": "visible text", "selector": "optional CSS selector" }
  ],
  "inputItems": [
    { "type": "text|email|password|select|checkbox|radio|textarea|file", "label": "field label", "name": "field name attr", "selector": "optional CSS selector", "required": true }
  ],
  "expectations": ["what a user would expect to be able to do on this page"],
  "capabilities": ["specific actions or features available"]
}`
}
