/**
 * Where the Login UI background presets come from in the source tree, and the object keys they
 * take in the public assets bucket (PUBLIC_ASSETS). Kept apart from the publication so that the
 * environment deletion can name these keys without importing the uploader.
 */
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const LOGIN_UI_PRESET_SOURCE_DIR =
  'packages/ar-management/assets/login-ui-presets/backgrounds';
export const LOGIN_UI_PRESET_KEY_PREFIX = 'presets/login-ui/backgrounds/';

const SEGMENT = /^[a-z0-9-]{1,64}$/u;
const FILE = /^([a-z0-9-]{1,128})\.(webp|jpe?g|png)$/u;
const CONTENT_TYPES = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
} as const;

export interface LoginUiPresetFile {
  objectKey: string;
  path: string;
  contentType: (typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES];
}

/** The presets in the source tree, sorted by object key; none when the folder is missing. */
export async function listLoginUiPresetFiles(baseDir: string): Promise<LoginUiPresetFile[]> {
  const root = resolve(baseDir, LOGIN_UI_PRESET_SOURCE_DIR);
  let categories: string[];
  try {
    categories = await readdir(root);
  } catch {
    return [];
  }
  const realRoot = await realpath(root);
  const files: LoginUiPresetFile[] = [];
  for (const category of categories.sort()) {
    if (!SEGMENT.test(category)) continue;
    let names: string[];
    try {
      names = await readdir(join(root, category));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const match = FILE.exec(name);
      if (!match) continue;
      const path = await realpath(join(root, category, name));
      // A symlink must not reach outside the presets folder.
      const inside = relative(realRoot, path);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
      files.push({
        objectKey: `${LOGIN_UI_PRESET_KEY_PREFIX}${category}/${name}`,
        path,
        contentType: CONTENT_TYPES[match[2] as keyof typeof CONTENT_TYPES],
      });
    }
  }
  return files;
}
