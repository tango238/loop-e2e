import { createHash } from 'node:crypto'

export function fingerprint(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}
