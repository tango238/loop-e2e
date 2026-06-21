import { createHash } from 'node:crypto'

export function fingerprint(parts: string[]): string {
  // '\n' separator: stable, order-sensitive, handles multi-line parts without ambiguity
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}
