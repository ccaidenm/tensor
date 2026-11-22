import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { DEFAULT_CONFIG, type Config } from './schema';

const CONFIG_FILENAME = 'config.json';

async function getConfigPath(): Promise<string> {
  const dir = await appConfigDir();
  return join(dir, CONFIG_FILENAME);
}

export async function loadConfigFromDisk(): Promise<unknown> {
  const path = await getConfigPath();

  if (!(await exists(path))) {
    return {}; // no file yet — schema defaults will fill everything in
  }

  const raw = await readTextFile(path);
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // corrupted file — fall back to defaults, don't crash
  }
}

export async function saveConfigToDisk(config: Config): Promise<void> {
  try {
    const dir = await appConfigDir();
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    const path = await getConfigPath();
    await writeTextFile(path, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to save config to disk:', err);
  }
}

/** Settings > About "Configuration Files": reveals config.json in the
 * OS file manager, writing DEFAULT_CONFIG first if no save has landed
 * yet. */
export async function revealConfigFile(): Promise<void> {
  const path = await getConfigPath();

  if (!(await exists(path))) {
    const dir = await appConfigDir();
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    await writeTextFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }

  await revealItemInDir(path);
}
