import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
const conformanceCli = `${workspaceRoot}/node_modules/@modelcontextprotocol/conformance/dist/index.js`;
const fixture = `${packageRoot}/scripts/conformance-http-server.ts`;
const scenarios = ['server-initialize', 'ping', 'tools-list', 'resources-list', 'prompts-list'];

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Fixture startup timed out: ${stderr}`)),
      10_000
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/READY (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Fixture exited before startup (code ${code}): ${stderr}`));
    });
  });
}

const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
  cwd: packageRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const url = await waitForReady(child);
  for (const scenario of scenarios) {
    execFileSync(
      process.execPath,
      [
        conformanceCli,
        'server',
        '--url',
        url,
        '--scenario',
        scenario,
        '--spec-version',
        '2025-11-25',
      ],
      { cwd: workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }
  console.log(`MCP conformance gate passed: ${scenarios.join(', ')}.`);
} finally {
  child.kill('SIGTERM');
}
