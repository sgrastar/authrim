import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = `${packageRoot}/scripts/inspector-server.ts`;
// The Inspector has its own package and lockfile outside the pnpm workspace: 2.x depends on
// Vite 8, which would move the workspace's Vite 7 toolchain. npm ci installs exactly the locked
// tree, with integrity checks and no install scripts.
const inspectorRoot = `${packageRoot}/tools/mcp-inspector`;
const inspectorCli = `${inspectorRoot}/node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js`;

execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: inspectorRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
});

function inspect(args) {
  const output = execFileSync(
    process.execPath,
    [inspectorCli, process.execPath, '--import', 'tsx', fixture, ...args],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  return JSON.parse(output);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tools = inspect(['--method', 'tools/list']).tools;
assert(Array.isArray(tools) && tools.length === 50, `Expected 50 Tools, received ${tools?.length}`);
for (const name of [
  'get_agent_settings',
  'create_public_oauth_client',
  'cancel_auth_config_plan',
]) {
  assert(
    tools.some((tool) => tool.name === name),
    `Inspector did not observe Tool ${name}`
  );
}

const resources = inspect(['--method', 'resources/list']).resources;
assert(Array.isArray(resources) && resources.length === 4, 'Expected four static Resources');

const resourceTemplates = inspect(['--method', 'resources/templates/list']).resourceTemplates;
assert(
  Array.isArray(resourceTemplates) && resourceTemplates.length === 4,
  'Expected four Resource templates'
);

const prompts = inspect(['--method', 'prompts/list']).prompts;
assert(Array.isArray(prompts) && prompts.length === 4, 'Expected four Prompts');

const callResult = inspect(['--method', 'tools/call', '--tool-name', 'get_agent_settings']);
assert(callResult.isError === false, 'Expected get_agent_settings to succeed');
assert(callResult.structuredContent?.settings?.fixture === true, 'Missing fixture Tool result');

console.log(
  `MCP Inspector gate passed: ${tools.length} Tools, ${resources.length} Resources, ` +
    `${resourceTemplates.length} Resource templates, ${prompts.length} Prompts, 1 Tool call.`
);
