import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsSetupError } from './setup-aws-cli.mjs';
import { createExecutionPlan } from './setup-execution-plan.mjs';
import { canonicalSetupJson, readSetupJson, setupDigest } from './setup-execution-state.mjs';
import { executeAwsSetup } from './setup-executor.mjs';
import { adoptExecutionPlan } from './setup-plan-adoption.mjs';
import { createSetupConfiguration } from './setup-config.mjs';

export async function runExecutionCommand(args, root = process.cwd()) {
  const [mode, ...rest] = args;
  const options = {};
  const allowed = {
    configure: ['input', 'out'],
    plan: ['config', 'out', 'account-id', 'region'],
    apply: ['plan', 'plan-sha256', 'state', 'through'],
    resume: ['plan', 'plan-sha256', 'state', 'through'],
    status: ['state'],
    'adopt-plan': [
      'previous-plan',
      'previous-plan-sha256',
      'previous-state',
      'previous-state-sha256',
      'plan',
      'plan-sha256',
      'state',
    ],
  }[mode];
  if (!allowed || rest.length % 2) throw new AwsSetupError('aws_setup_arguments_invalid');
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.slice(2);
    if (
      !rest[index]?.startsWith('--') ||
      !allowed.includes(key) ||
      options[key] !== undefined ||
      !rest[index + 1]
    )
      throw new AwsSetupError('aws_setup_arguments_invalid');
    options[key] = rest[index + 1];
  }
  if (mode === 'configure') {
    if (!options.input || !options.out) throw new AwsSetupError('aws_setup_arguments_invalid');
    const config = createSetupConfiguration(
      await readSetupJson(resolve(options.input)),
      resolve(options.out)
    );
    const serialized = canonicalSetupJson(config);
    const file = await open(resolve(options.out), 'wx', 0o600);
    try {
      await file.writeFile(`${serialized}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return { status: 'configured', configSha256: setupDigest(serialized) };
  }
  if (mode === 'adopt-plan') {
    if (allowed.some((key) => !options[key]))
      throw new AwsSetupError('aws_setup_arguments_invalid');
    return adoptExecutionPlan({
      root,
      previousPlanPath: resolve(options['previous-plan']),
      previousPlanSha256: options['previous-plan-sha256'],
      previousStatePath: resolve(options['previous-state']),
      previousStateSha256: options['previous-state-sha256'],
      planPath: resolve(options.plan),
      planSha256: options['plan-sha256'],
      statePath: resolve(options.state),
    });
  }
  if (mode === 'plan') {
    if (!options.config || !options.out) throw new AwsSetupError('aws_setup_arguments_invalid');
    const config = await readSetupJson(resolve(options.config));
    if (
      (options['account-id'] && options['account-id'] !== config.target?.accountId) ||
      (options.region && options.region !== config.target?.region)
    )
      throw new AwsSetupError('aws_setup_target_mismatch');
    const plan = await createExecutionPlan(config, root);
    const serialized = canonicalSetupJson(plan);
    const file = await open(resolve(options.out), 'wx', 0o600);
    try {
      await file.writeFile(`${serialized}\n`);
    } finally {
      await file.close();
    }
    return {
      status: 'planned',
      planSha256: setupDigest(serialized),
      mode: config.mode,
      target: config.target,
      backend: config.backend,
      role: config.role,
    };
  }
  if (!options.state) throw new AwsSetupError('aws_setup_arguments_invalid');
  if (mode === 'status') {
    const state = await readSetupJson(resolve(options.state), { privateFile: true });
    return {
      status: state.status,
      operationId: state.operationId,
      stage: state.currentStage,
      planSha256: state.planSha256,
      target: state.target,
      stages: Object.fromEntries(
        Object.entries(state.stages ?? {}).map(([key, value]) => [key, value.status])
      ),
      ...(state.code ? { code: state.code } : {}),
    };
  }
  if (!options.plan || !options['plan-sha256'])
    throw new AwsSetupError('aws_setup_arguments_invalid');
  return executeAwsSetup({
    mode,
    root,
    plan: await readSetupJson(resolve(options.plan)),
    planSha256: options['plan-sha256'],
    statePath: resolve(options.state),
    through: options.through,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runExecutionCommand(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ status: 'blocked', code: error instanceof AwsSetupError ? error.code : 'aws_setup_execution_failed' })}\n`
      );
      process.exitCode = 2;
    });
}
