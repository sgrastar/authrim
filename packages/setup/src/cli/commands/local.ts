/**
 * `authrim-setup local ...`: a complete Authrim environment on this machine.
 *
 * Nothing here needs a Cloudflare account. Workers run under `wrangler dev` (Miniflare D1, KV and
 * Durable Objects), the issuer is http://localhost:<port>, and the Control Worker is not started.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { cwd } from 'node:process';
import { DEFAULT_LOCAL_ENVIRONMENT } from '../../core/local/paths.js';
import {
  initLocalEnvironment,
  rebuildLocalEnvironment,
  assertLocalSourceRoot,
} from '../../core/local/init.js';
import { LOCAL_DEFAULT_PORTS } from '../../core/local/environment.js';
import { runLocalEnvironment } from '../../core/local/runtime.js';

interface CommonOptions {
  env: string;
}

interface InitOptions extends CommonOptions {
  port?: string;
  loginUiPort?: string;
  adminUiPort?: string;
  adminUi?: 'legacy' | 'console';
  tenant?: string;
}

interface UpOptions extends CommonOptions {
  only?: string;
  ui: boolean;
}

function parseOnly(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function progress(message: string): void {
  console.log(chalk.gray(`  ${message}`));
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}

export async function localInitCommand(options: InitOptions): Promise<void> {
  await run(async () => {
    console.log(chalk.bold('\nAuthrim local environment: init\n'));
    const rootDir = cwd();
    const { paths, config } = await initLocalEnvironment({
      rootDir,
      env: options.env,
      routerPort: parsePort(options.port, LOCAL_DEFAULT_PORTS.router),
      loginUiPort: parsePort(options.loginUiPort, LOCAL_DEFAULT_PORTS.loginUi),
      adminUiPort: parsePort(options.adminUiPort, LOCAL_DEFAULT_PORTS.adminUi),
      adminUiVariant: options.adminUi,
      tenantName: options.tenant,
      onProgress: progress,
    });
    console.log(chalk.green(`\nLocal environment "${config.environment.prefix}" is ready.`));
    console.log(chalk.gray(`  state: ${paths.root}`));
    console.log('\nStart it with:');
    console.log(
      chalk.cyan(
        `  pnpm setup:local up${options.env === DEFAULT_LOCAL_ENVIRONMENT ? '' : ` --env ${options.env}`}`
      )
    );
  });
}

export async function localUpCommand(options: UpOptions): Promise<void> {
  await run(async () => {
    const rootDir = cwd();
    assertLocalSourceRoot(rootDir);
    await runLocalEnvironment({
      rootDir,
      env: options.env,
      only: parseOnly(options.only),
      withUi: options.ui,
      onProgress: progress,
    });
  });
}

export async function localResetCommand(options: CommonOptions & { yes?: boolean }): Promise<void> {
  await run(async () => {
    const rootDir = cwd();
    assertLocalSourceRoot(rootDir);
    console.log(chalk.bold(`\nAuthrim local environment: reset (${options.env})\n`));
    await rebuildLocalEnvironment({ rootDir, env: options.env, onProgress: progress });
    console.log(chalk.green('\nLocal environment rebuilt. Start it with `pnpm setup:local up`.'));
  });
}

export function registerLocalCommands(program: Command): void {
  const local = program
    .command('local')
    .description('Run Authrim locally with wrangler dev (no Cloudflare account needed)');

  local
    .command('init')
    .description('Generate keys, Wrangler configs and seeded local D1/KV state')
    .option('--env <name>', 'Local environment name', DEFAULT_LOCAL_ENVIRONMENT)
    .option('--port <port>', 'Router/issuer port', String(LOCAL_DEFAULT_PORTS.router))
    .option(
      '--login-ui-port <port>',
      'Login UI dev server port',
      String(LOCAL_DEFAULT_PORTS.loginUi)
    )
    .option(
      '--admin-ui-port <port>',
      'Admin UI dev server port',
      String(LOCAL_DEFAULT_PORTS.adminUi)
    )
    .option('--admin-ui <variant>', 'Admin UI variant: legacy or console')
    .option('--tenant <id>', 'Initial tenant ID')
    .action(localInitCommand);

  local
    .command('up')
    .description('Start the local Workers and UIs')
    .option('--env <name>', 'Local environment name', DEFAULT_LOCAL_ENVIRONMENT)
    .option(
      '--only <components>',
      'Comma-separated Workers to run (ar-lib-core and ar-router are always included)'
    )
    .option('--no-ui', 'Do not start the Login/Admin UI dev servers')
    .action(localUpCommand);

  local
    .command('reset')
    .description('Delete the local environment and rebuild it from scratch')
    .option('--env <name>', 'Local environment name', DEFAULT_LOCAL_ENVIRONMENT)
    .action(localResetCommand);
}
