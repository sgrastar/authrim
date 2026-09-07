import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const registryPath = resolve(root, 'security/mcp-server-registry.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
if (registry.schemaVersion !== 'authrim-mcp-server-registry-v1') {
  throw new TypeError('Unsupported MCP server registry schema');
}

const registered = new Set();
const ids = new Set();
for (const server of registry.servers ?? []) {
  if (!server.id || ids.has(server.id)) throw new TypeError('MCP server IDs must be unique');
  ids.add(server.id);
  if (!['production', 'local-test-only'].includes(server.exposure)) {
    throw new TypeError(`Invalid MCP exposure for ${server.id}`);
  }
  if (!server.authentication || !server.dataClassification || !server.transport) {
    throw new TypeError(`Incomplete MCP security ownership record: ${server.id}`);
  }
  for (const sourceFile of server.sourceFiles ?? []) {
    const absolute = resolve(root, sourceFile);
    if (!absolute.startsWith(`${root}/`)) throw new TypeError('MCP registry path escaped repository');
    if (!(await stat(absolute)).isFile()) throw new TypeError(`Missing MCP source: ${sourceFile}`);
    registered.add(sourceFile);
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', 'dist', 'coverage', '.svelte-kit', '.wrangler'].includes(entry.name)) {
      continue;
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|js|mjs)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

const candidates = [
  ...(await sourceFiles(resolve(root, 'packages'))),
].filter((path) => !path.includes('/__tests__/') && !path.endsWith('.test.ts'));
const serverMarkers = /McpAgent\.serve\(|extends\s+McpAgent|createAgentAccessMcpSdkServer\(/u;
const unregistered = [];
for (const file of candidates) {
  const contents = await readFile(file, 'utf8');
  if (!serverMarkers.test(contents)) continue;
  const path = relative(root, file);
  if (!registered.has(path)) unregistered.push(path);
}
if (unregistered.length > 0) {
  throw new Error(`Unregistered MCP server implementation:\n${unregistered.join('\n')}`);
}

console.log(`MCP registry verified: ${ids.size} owned server profiles, ${registered.size} source files`);
