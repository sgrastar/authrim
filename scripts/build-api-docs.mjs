import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

const root = process.cwd();
const docsApiDir = path.join(root, 'docs/api');
const copiedSpecsDir = path.join(docsApiDir, 'openapi');
const specsPath = path.join(docsApiDir, 'specs.json');

async function copyOpenApiSpecs(specs) {
  await mkdir(copiedSpecsDir, { recursive: true });

  for (const spec of specs) {
    if (!spec.source) {
      throw new Error(`Missing source for ${spec.id}`);
    }
    if (!spec.spec.startsWith('openapi/')) {
      throw new Error(`Expected ${spec.id}.spec to point under openapi/`);
    }

    const sourcePath = path.resolve(docsApiDir, spec.source);
    const targetPath = path.join(docsApiDir, spec.spec);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);

    const jsonTargetPath = targetPath.replace(/\.ya?ml$/u, '.json');
    if (jsonTargetPath === targetPath) {
      throw new Error(`Expected ${spec.id}.spec to be a YAML file`);
    }

    const document = parse(await readFile(sourcePath, 'utf8'));
    await writeFile(jsonTargetPath, `${JSON.stringify(document, null, 2)}\n`);
  }
}

const specs = JSON.parse(await readFile(specsPath, 'utf8'));
await copyOpenApiSpecs(specs);

process.stdout.write(`Prepared OpenAPI copies for ${specs.length} API documents.\n`);
