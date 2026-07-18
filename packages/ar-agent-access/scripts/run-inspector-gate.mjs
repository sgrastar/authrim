import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
const inspectorBuild = `${workspaceRoot}/node_modules/@modelcontextprotocol/inspector-cli/build`;
const inspectorCli = `${inspectorBuild}/index.js`;
const fixture = `${packageRoot}/scripts/inspector-server.ts`;

function inspect(args) {
  const output = execFileSync(
    process.execPath,
    [inspectorCli, process.execPath, '--import', 'tsx', fixture, ...args],
    {
      cwd: inspectorBuild,
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
assert(Array.isArray(tools) && tools.length === 47, `Expected 47 Tools, received ${tools?.length}`);
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
