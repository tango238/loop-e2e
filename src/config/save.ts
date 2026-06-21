import { join } from 'node:path'
import { writeYaml } from '../util/fs.js'
import { CONFIG_FILENAME, type Config } from './schema.js'

export async function saveConfig(root: string, config: Config): Promise<void> {
  await writeYaml(join(root, CONFIG_FILENAME), config)
}
