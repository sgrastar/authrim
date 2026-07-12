import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const defaultWebsiteRoot = '/Users/yuta/Documents/Authrim/authrim-website';
const websiteArgIndex = process.argv.indexOf('--website');
const websiteRoot =
  websiteArgIndex >= 0 && process.argv[websiteArgIndex + 1]
    ? process.argv[websiteArgIndex + 1]
    : process.env.AUTHRIM_WEBSITE_ROOT ?? defaultWebsiteRoot;

const root = process.cwd();
const sourceDir = path.join(root, 'docs/api');
const targetDir = path.join(websiteRoot, 'public/api');
const publishEntries = ['openapi'];

async function assertDirectory(label, directory) {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`${label} is not a directory: ${directory}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${directory}`);
    }
    throw error;
  }
}

await assertDirectory('Generated API docs directory', sourceDir);
await assertDirectory('Website root', websiteRoot);

await rm(targetDir, { force: true, recursive: true });
await mkdir(targetDir, { recursive: true });

for (const entry of publishEntries) {
  const sourcePath = path.join(sourceDir, entry);
  const targetPath = path.join(targetDir, entry);
  await stat(sourcePath);
  await cp(sourcePath, targetPath, { recursive: true });
}

process.stdout.write(`Synced API docs to ${targetDir}\n`);
