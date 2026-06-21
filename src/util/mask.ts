export function maskSecrets(text: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce(
    (acc, secret) => acc.split(secret).join('***'),
    text,
  )
}
