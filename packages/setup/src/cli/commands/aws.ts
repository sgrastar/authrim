/** Repository-only AWS setup entry. Existing Cloudflare commands stay independent. */
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command, Option } from 'commander';

export interface AwsSetupOptions {
  accountId: string;
  region: string;
  profile?: string;
  phase?: 'bootstrap' | 'foundation' | 'workload';
  source?: string;
  json?: boolean;
  issuerHost?: string;
  out?: string;
}

interface AwsSetupDependencies {
  runScript?: (script: string, args: string[], rootDir: string) => Promise<number>;
  reportError?: (message: string) => void;
}

function executeScript(script: string, args: string[], rootDir: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

async function requireScript(rootDir: string, name: string): Promise<string> {
  const script = join(rootDir, 'packages', 'ar-runtime-aws', 'scripts', name);
  const metadata = await lstat(script);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('aws_source_missing');
  return script;
}

/** Check before creating a local plan. Never invokes an AWS mutation or login command. */
export async function runAwsSetupCommand(
  mode: 'check' | 'plan',
  options: AwsSetupOptions,
  dependencies: AwsSetupDependencies = {}
): Promise<number> {
  const reportError =
    dependencies.reportError ?? ((message) => process.stderr.write(`${message}\n`));
  const rootDir = resolve(options.source ?? process.cwd());
  const runScript = dependencies.runScript ?? executeScript;
  let checkScript: string;
  let planScript: string | undefined;
  try {
    checkScript = await requireScript(rootDir, 'aws-preflight.mjs');
    if (mode === 'plan') planScript = await requireScript(rootDir, 'setup-plan.mjs');
  } catch {
    reportError(
      options.json
        ? JSON.stringify({ status: 'blocked', code: 'aws_setup_source_missing' })
        : 'AWSセットアップのソースが見つかりません。Authrimリポジトリ直下で実行するか、--source で指定してください。'
    );
    return 2;
  }

  const checkArgs = [
    '--account-id',
    options.accountId,
    '--region',
    options.region,
    '--phase',
    options.phase ?? 'foundation',
  ];
  if (options.profile !== undefined) checkArgs.push('--profile', options.profile);
  if (options.json) checkArgs.push('--json');

  try {
    const checkExit = await runScript(checkScript, checkArgs, rootDir);
    if (checkExit !== 0 || mode === 'check') return checkExit;
    if (!options.out || !planScript) throw new Error('aws_plan_output_missing');
    const planArgs = [
      'create',
      '--account-id',
      options.accountId,
      '--region',
      options.region,
      '--out',
      resolve(options.out),
    ];
    if (options.issuerHost !== undefined) planArgs.push('--issuer-host', options.issuerHost);
    return await runScript(planScript, planArgs, rootDir);
  } catch {
    reportError(
      options.json
        ? JSON.stringify({ status: 'blocked', code: 'aws_setup_process_failed' })
        : 'AWSセットアップの確認処理を実行できませんでした。Node.jsとソースの配置を確認してください。'
    );
    return 2;
  }
}

function commonOptions(command: Command): Command {
  return command
    .requiredOption('--account-id <id>', 'Expected AWS account ID (12 digits)')
    .requiredOption('--region <region>', 'Expected deployment region')
    .option('--profile <name>', 'Existing AWS CLI profile')
    .addOption(
      new Option('--phase <phase>', 'Setup phase to check')
        .choices(['bootstrap', 'foundation', 'workload'])
        .default('foundation')
    )
    .option('--source <path>', 'Authrim source repository (defaults to current directory)')
    .option('--json', 'Emit machine-readable results');
}

export function registerAwsCommands(program: Command): void {
  const aws = program
    .command('aws')
    .description('Check AWS setup prerequisites and prepare a deployment plan (source repository)');
  commonOptions(
    aws.command('check').description('Check AWS CLI, login, target account and role permissions')
  ).action(async (options: AwsSetupOptions) => {
    process.exitCode = await runAwsSetupCommand('check', options);
  });
  commonOptions(
    aws.command('plan').description('Check AWS prerequisites, then write a local deployment plan')
  )
    .requiredOption('--out <path>', 'New plan file (existing files are never overwritten)')
    .option('--issuer-host <hostname>', 'Existing SAML issuer hostname')
    .action(async (options: AwsSetupOptions) => {
      process.exitCode = await runAwsSetupCommand('plan', options);
    });
}
