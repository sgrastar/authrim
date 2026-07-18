import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

const artifactPaths = new Set([packageJson.main, packageJson.types]);
for (const contract of Object.values(packageJson.exports ?? {})) {
  if (typeof contract === 'string') artifactPaths.add(contract);
  else if (contract && typeof contract === 'object') {
    if (typeof contract.import === 'string') artifactPaths.add(contract.import);
    if (typeof contract.types === 'string') artifactPaths.add(contract.types);
  }
}

for (const artifactPath of artifactPaths) {
  if (!artifactPath) continue;
  const absolute = path.resolve(packageRoot, artifactPath);
  try {
    if (!(await stat(absolute)).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Missing ar-agent-access build artifact: ${artifactPath}`);
  }
}

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return declarationFiles(absolute);
      return entry.isFile() && entry.name.endsWith('.d.ts') ? [absolute] : [];
    })
  );
  return nested.flat();
}

for (const declaration of await declarationFiles(path.join(packageRoot, 'dist'))) {
  const source = await readFile(declaration, 'utf8');
  if (
    /node_modules\/agents\/dist\//u.test(source) ||
    /agents\/dist\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+/u.test(source)
  ) {
    throw new Error(
      `Agents SDK internal type leaked into ${path.relative(packageRoot, declaration)}`
    );
  }
}

console.log(`ar-agent-access build contract: ${artifactPaths.size} public artifacts verified`);
