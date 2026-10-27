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
  config?: string;
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

/** Checks stay read-only. A config creates a pinned executable plan locally; apply is separate. */
export async function runAwsSetupCommand(
  mode: 'check' | 'plan',
  options: AwsSetupOptions,
  dependencies: AwsSetupDependencies = {}
): Promise<number> {
  const reportError =
    dependencies.reportError ?? ((message) => process.stderr.write(`${message}\n`));
  const rootDir = resolve(options.source ?? process.cwd());
  const runScript = dependencies.runScript ?? executeScript;
  if (mode === 'plan' && options.config) {
    try {
      if (!options.out) throw new Error('aws_plan_output_missing');
      const script = await requireScript(rootDir, 'setup-execute.mjs');
      return await runScript(
        script,
        [
          'plan',
          '--config',
          resolve(options.config),
          '--out',
          resolve(options.out),
          '--account-id',
          options.accountId,
          '--region',
          options.region,
        ],
        rootDir
      );
    } catch {
      reportError(
        'AWSセットアップの実行計画を作成できませんでした。ソースと設定ファイルを確認してください。'
      );
      return 2;
    }
  }
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
    .option('--config <path>', 'Public deployment config; creates an executable plan locally')
    .action(async (options: AwsSetupOptions) => {
      process.exitCode = await runAwsSetupCommand('plan', options);
    });
  for (const mode of ['apply', 'resume', 'status'] as const) {
    const command = aws
      .command(mode)
      .description(
        mode === 'status'
          ? 'Read saved AWS deployment progress'
          : `${mode === 'apply' ? 'Start' : 'Resume'} a pinned AWS deployment (no Cloudflare or DNS changes)`
      )
      .requiredOption('--state <path>', 'Private durable execution state file')
      .option('--source <path>', 'Authrim source repository');
    if (mode !== 'status')
      command
        .requiredOption('--plan <path>', 'Executable plan created with aws plan --config')
        .requiredOption('--plan-sha256 <sha256>', 'Trusted digest returned by the plan command')
        .addOption(
          new Option('--through <stage>', 'Stop after this stage')
            .choices([
              'bootstrap',
              'foundation',
              'access',
              'endpoint',
              'access-bind',
              'prepare',
              'upload',
              'database',
              'initialize',
              'restore',
              'verify',
              'sp-prepare',
              'manifest',
              'runtime-bind',
              'workload',
              'complete',
            ])
            .default('complete')
        );
    command.action(async (options: AwsExecutionOptions) => {
      process.exitCode = await runAwsExecutionCommand(mode, options);
    });
  }
  aws
    .command('adopt-plan')
    .description(
      'Advanced: verify a blocked pre-initialization deployment against a source-only plan update'
    )
    .requiredOption('--previous-plan <path>', 'Original executable plan (never modified)')
    .requiredOption('--previous-plan-sha256 <sha256>', 'Reviewed original plan digest')
    .requiredOption('--previous-state <path>', 'Blocked original execution state (never modified)')
    .requiredOption(
      '--previous-state-sha256 <sha256>',
      'Reviewed SHA256 of the original state file bytes'
    )
    .requiredOption('--plan <path>', 'New executable plan with identical deployment inputs')
    .requiredOption('--plan-sha256 <sha256>', 'Reviewed new plan digest')
    .requiredOption('--state <path>', 'New private execution state; must not already exist')
    .option('--source <path>', 'Authrim source repository')
    .action(async (options: AwsAdoptPlanOptions) => {
      process.exitCode = await runAwsAdoptPlanCommand(options);
    });
  const dsql = aws
    .command('dsql')
    .description('Evaluate an existing Aurora DSQL cluster; SAML serving is not supported');
  for (const mode of ['check', 'verify'] as const) {
    const command = dsql
      .command(mode)
      .description(
        mode === 'check'
          ? 'Check the selected identity and read-only DSQL connection'
          : 'Run an isolated synthetic identity restore after reviewing the check result'
      )
      .requiredOption('--account-id <id>', 'Expected AWS account ID')
      .requiredOption('--region <region>', 'Expected DSQL region')
      .requiredOption('--profile <name>', 'Existing AWS CLI profile')
      .requiredOption('--config <path>', 'DSQL connection settings without credentials')
      .option('--source <path>', 'Authrim source repository');
    if (mode === 'verify')
      command
        .requiredOption('--config-sha256 <sha256>', 'Connection digest returned by dsql check')
        .requiredOption('--bundle-sha256 <sha256>', 'Program digest returned by dsql check')
        .requiredOption('--principal-arn <arn>', 'Principal ARN returned by dsql check')
        .requiredOption('--principal-id <id>', 'Principal ID returned by dsql check')
        .requiredOption(
          '--write-probe',
          'Explicitly allow synthetic writes in a new disposable schema'
        )
        .option('--users <count>', 'Synthetic users (1–2000)', '1001');
    command.action(async (options: AwsDsqlOptions) => {
      process.exitCode = await runAwsDsqlCommand(mode, options);
    });
  }
}

export interface AwsDsqlOptions {
  accountId: string;
  region: string;
  profile: string;
  config: string;
  source?: string;
  configSha256?: string;
  bundleSha256?: string;
  principalArn?: string;
  principalId?: string;
  writeProbe?: boolean;
  users?: string;
}

/** DSQL remains an explicit evaluation branch, never a PostgreSQL deployment mode. */
export async function runAwsDsqlCommand(
  mode: 'check' | 'verify',
  options: AwsDsqlOptions,
  dependencies: AwsSetupDependencies = {}
): Promise<number> {
  try {
    const root = resolve(options.source ?? process.cwd());
    const script = await requireScript(root, 'setup-dsql.mjs');
    const args = [
      mode,
      '--account-id',
      options.accountId,
      '--region',
      options.region,
      '--profile',
      options.profile,
      '--config',
      resolve(options.config),
    ];
    if (mode === 'verify') {
      if (
        !options.writeProbe ||
        !options.configSha256 ||
        !options.bundleSha256 ||
        !options.principalArn ||
        !options.principalId
      )
        throw new Error('aws_dsql_review_required');
      args.push(
        '--config-sha256',
        options.configSha256,
        '--bundle-sha256',
        options.bundleSha256,
        '--principal-arn',
        options.principalArn,
        '--principal-id',
        options.principalId,
        '--write-probe'
      );
      if (options.users !== undefined) args.push('--users', options.users);
    }
    return await (dependencies.runScript ?? executeScript)(script, args, root);
  } catch {
    (dependencies.reportError ?? ((message) => process.stderr.write(`${message}\n`)))(
      'DSQLの確認を実行できませんでした。接続設定と確認結果を見直してください。SAMLの構築・有効化は行いません。'
    );
    return 2;
  }
}

export interface AwsExecutionOptions {
  source?: string;
  state: string;
  plan?: string;
  planSha256?: string;
  through?: string;
}

/** Only this explicit command enters the AWS writer; it never launches a login or arbitrary shell. */
export async function runAwsExecutionCommand(
  mode: 'apply' | 'resume' | 'status',
  options: AwsExecutionOptions,
  dependencies: AwsSetupDependencies = {}
): Promise<number> {
  try {
    const root = resolve(options.source ?? process.cwd());
    const script = await requireScript(root, 'setup-execute.mjs');
    const args = [mode, '--state', resolve(options.state)];
    if (mode !== 'status') {
      if (!options.plan || !options.planSha256) throw new Error('aws_plan_missing');
      args.push('--plan', resolve(options.plan), '--plan-sha256', options.planSha256);
      if (options.through) args.push('--through', options.through);
    }
    return await (dependencies.runScript ?? executeScript)(script, args, root);
  } catch {
    (dependencies.reportError ?? ((message) => process.stderr.write(`${message}\n`)))(
      'AWSセットアップを実行できませんでした。計画・状態ファイルとソースの配置を確認してください。'
    );
    return 2;
  }
}

export interface AwsAdoptPlanOptions {
  previousPlan: string;
  previousPlanSha256: string;
  previousState: string;
  previousStateSha256: string;
  plan: string;
  planSha256: string;
  state: string;
  source?: string;
}

/** Explicit advanced recovery; cloud reconciliation stays in the fixed executor script. */
export async function runAwsAdoptPlanCommand(
  options: AwsAdoptPlanOptions,
  dependencies: AwsSetupDependencies = {}
): Promise<number> {
  try {
    if (
      ![options.previousPlanSha256, options.previousStateSha256, options.planSha256].every(
        (value) => /^[a-f0-9]{64}$/u.test(value ?? '')
      )
    )
      throw new Error('aws_adoption_digest_missing');
    const root = resolve(options.source ?? process.cwd());
    const script = await requireScript(root, 'setup-execute.mjs');
    return await (dependencies.runScript ?? executeScript)(
      script,
      [
        'adopt-plan',
        '--previous-plan',
        resolve(options.previousPlan),
        '--previous-plan-sha256',
        options.previousPlanSha256,
        '--previous-state',
        resolve(options.previousState),
        '--previous-state-sha256',
        options.previousStateSha256,
        '--plan',
        resolve(options.plan),
        '--plan-sha256',
        options.planSha256,
        '--state',
        resolve(options.state),
      ],
      root
    );
  } catch {
    (dependencies.reportError ?? ((message) => process.stderr.write(`${message}\n`)))(
      'AWSの構築記録を引き継げませんでした。元と新しい計画・状態ファイルの識別情報を確認してください。'
    );
    return 2;
  }
}
