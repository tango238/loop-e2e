import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readYaml<T>(path: string): Promise<T> {
  return parse(await readFile(path, 'utf8')) as T
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

export async function writeYaml(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path))
  await writeFile(path, stringify(data), 'utf8')
}
