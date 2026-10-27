import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwsSetupWebRunner,
  AwsWebError,
  runAwsWebProcess,
  type AwsWebProcessInput,
  type AwsWebProcessResult,
  type AwsWebRun,
} from '../web/aws-setup-runner.js';

const target = { accountId: '123456789012', region: 'ap-northeast-1' };
const stages = [
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
];
const pins = {
  configSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
  principalArn: `arn:aws:iam::${target.accountId}:role/evaluation`,
  principalId: 'AROAEXAMPLEIDENTITY',
};
const hostname = `${'a'.repeat(26)}.dsql.${target.region}.on.aws`;
let root: string;
let calls: AwsWebProcessInput[];
let handler: (input: AwsWebProcessInput) => Promise<AwsWebProcessResult>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function ok(value: unknown): AwsWebProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
}
function arg(input: AwsWebProcessInput, name: string) {
  return input.args[input.args.indexOf(name) + 1];
}
async function planProcess(input: AwsWebProcessInput) {
  const plan = {
    formatVersion: 2,
    config: {
      backend: 'aws',
      role: 'secondary',
      mode: 'browser-rehearsal',
      target,
      privateSentinel: 'PRIVATE_SENTINEL',
      identities: {
        bootstrap: {
          profile: 'bootstrap',
          principalArn: `arn:aws:iam::${target.accountId}:user/bootstrap`,
          secret: 'PRIVATE_SENTINEL',
        },
        operator: {
          profile: 'operator',
          principalArn: `arn:aws:iam::${target.accountId}:role/authrim-dr/operator/test-operator`,
        },
      },
      stacks: Object.fromEntries(
        ['bootstrap', 'foundation', 'access', 'database', 'workload'].map((stage) => [
          stage,
          {
            name: `test-${stage}`,
            disposition: stage === 'foundation' ? 'reuse' : 'create',
            parameters: { private: 'PRIVATE_SENTINEL' },
          },
        ])
      ),
    },
    stages,
  };
  await writeFile(arg(input, '--out'), JSON.stringify(plan), { mode: 0o600 });
  return ok({ status: 'planned', planSha256: hash(plan), config: plan.config });
}
function runner(options: ConstructorParameters<typeof AwsSetupWebRunner>[0] = {}) {
  return new AwsSetupWebRunner({
    rootDir: root,
    observationMs: 0,
    sleep: async () => undefined,
    runProcess: async (input) => {
      calls.push(input);
      return handler(input);
    },
    ...options,
  });
}
function input() {
  return { ...target, configPath: join(root, 'public.json') };
}
async function waitStatus(client: AwsSetupWebRunner, id: string, status: string) {
  let result: AwsWebRun | undefined;
  await vi.waitFor(async () => {
    result = await client.status(id);
    expect(result.status).toBe(status);
    expect(
      await stat(join(root, '.authrim/aws-web', id, 'web.lock')).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
  return result!;
}
async function planned(client: AwsSetupWebRunner) {
  const run = await client.plan(input());
  return waitStatus(client, run.runId, 'planned');
}
function dsqlChecked() {
  return ok({
    status: 'checked',
    database: 'aurora-dsql',
    fullRuntimeReady: false,
    target: { ...target, hostname },
    profile: 'evaluation',
    ...pins,
    report: { passed: true },
    raw: 'PRIVATE_SENTINEL',
  });
}
function dsqlResult(passed = true) {
  return {
    status: passed ? 'verified' : 'failed',
    database: 'aurora-dsql',
    fullRuntimeReady: false,
    report: {
      formatVersion: 1,
      mode: 'synthetic-native-identity',
      fullRuntimeReady: false,
      passed,
      cleanup: passed ? 'complete' : 'failed',
      schema: `authrim_dsql_identity_${'a'.repeat(32)}`,
      checks: [
        'database',
        'native-schema-and-indexes',
        'encrypted-synthetic-backup',
        'partial-import',
        'changed-source-and-tenant-rejected',
        'resume-after-reopening-backup',
        'native-readback-and-reference-verification',
        'native-uniqueness-enforced',
        'precise-json-number-change-rejected',
        'changed-native-row-rejected',
      ].map((name) => ({ name, passed, secret: 'PRIVATE_SENTINEL' })),
      restoredRows: { 'core.users_core': 1001, 'pii.users_pii': 1001, 'core.passkeys': 1001 },
      chunks: 33,
      maxChunkRows: 100,
      secret: 'PRIVATE_SENTINEL',
    },
    ...(passed
      ? {
          configurationReport: {
            formatVersion: 1,
            mode: 'synthetic-native-configuration',
            fullRuntimeReady: false,
            passed: true,
            cleanup: 'complete',
            schema: `authrim_dsql_configuration_${'b'.repeat(32)}`,
            checks: [
              'database',
              'native-schema-and-indexes',
              'encrypted-synthetic-backup',
              'partial-import',
              'changed-source-and-tenant-rejected',
              'resume-after-reopening-backup',
              'native-readback-and-reference-verification',
              'native-uniqueness-enforced',
              'native-foreign-key-enforced',
              'native-target-shape-enforced',
              'cross-tenant-reference-rejected',
              'missing-sp-reference-rejected',
              'unsupported-target-inventory-rejected',
              'invalid-configuration-json-rejected',
              'precise-json-number-change-rejected',
              'changed-native-row-rejected',
            ].map((name) => ({ name, passed: true, secret: 'PRIVATE_SENTINEL' })),
            restoredRows: {
              'core.identity_providers': 101,
              'core.flows': 101,
              'core.flow_versions': 101,
              'core.flow_assignments': 102,
            },
            chunks: 8,
            maxChunkRows: 100,
            secret: 'PRIVATE_SENTINEL',
          },
        }
      : {}),
  };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-aws-web-')));
  const scripts = join(root, 'packages/ar-runtime-aws/scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'setup-execute.mjs'), '// test executor');
  await writeFile(join(scripts, 'setup-dsql.mjs'), '// test evaluation');
  calls = [];
  handler = async (input) =>
    input.args[1] === 'plan' ? planProcess(input) : ok({ status: 'inProgress' });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('AWS setup web runner', () => {
  it('saves validated public configuration in a new private directory without deploying', async () => {
    const client = runner();
    const value = { database: 'aurora-dsql', ...target, hostname, user: 'authrim' };
    handler = async (command) => {
      expect(command.args[1]).toBe('configure');
      expect(JSON.parse(await readFile(arg(command, '--input'), 'utf8'))).toEqual(value);
      const config = { hostname, region: target.region, user: 'authrim' };
      await writeFile(arg(command, '--out'), JSON.stringify(config), { mode: 0o600 });
      return ok({ status: 'configured', configSha256: hash(config) });
    };
    const first = await client.configure(value);
    const second = await client.configure(value);
    expect(first.configPath).not.toBe(second.configPath);
    expect((await stat(first.configPath)).mode & 0o077).toBe(0);
    expect(calls.every((item) => item.args[1] === 'configure')).toBe(true);
    await expect(
      client.configure({ ...value, password: 'PRIVATE_SENTINEL' })
    ).rejects.toMatchObject({ code: 'aws_web_configuration_invalid' });
    expect(calls).toHaveLength(2);
  });
  it('pins a plan with private managed files and returns only review fields', async () => {
    const client = runner();
    const run = await client.plan(input());
    expect(run.status).toBe('planning');
    const review = await waitStatus(client, run.runId, 'planned');
    expect(review.plan).toMatchObject({
      target,
      database: 'postgresql',
      role: 'secondary',
      mode: 'browser-rehearsal',
      stages,
    });
    expect(review.plan?.stacks).toContainEqual({
      stage: 'foundation',
      name: 'test-foundation',
      disposition: 'reuse',
    });
    expect(review.plan?.identities?.operator.profile).toBe('operator');
    expect(JSON.stringify(review)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(review)).not.toContain(root);
    const directory = join(root, '.authrim/aws-web', run.runId);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'web.json'))).mode & 0o777).toBe(0o600);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].args[0]).toBe(join(root, 'packages/ar-runtime-aws/scripts/setup-execute.mjs'));
    expect(dirname(arg(calls[0], '--out'))).toBe(directory);
  });
  it('rejects wrong digest, premature resume and invalid paths without execution', async () => {
    const client = runner();
    await expect(client.plan({ ...input(), configPath: 'relative.json' })).rejects.toMatchObject({
      code: 'aws_web_config_path_invalid',
    });
    const review = await planned(client);
    await expect(client.start(review.runId, 'apply', 'c'.repeat(64))).rejects.toMatchObject({
      code: 'aws_web_plan_digest_mismatch',
    });
    await expect(
      client.start(review.runId, 'resume', review.plan!.planSha256)
    ).rejects.toMatchObject({ code: 'aws_web_execution_mode_invalid' });
    await expect(client.status('../escape')).rejects.toMatchObject({
      code: 'aws_web_run_id_invalid',
    });
    expect(calls).toHaveLength(1);
  });
  it('observes a bounded apply, resumes persisted state after restart and never claims browser verification', async () => {
    const client = runner();
    const review = await planned(client);
    handler = async (command) => {
      await writeFile(
        arg(command, '--state'),
        JSON.stringify({
          planSha256: review.plan!.planSha256,
          target,
          currentStage: 'foundation',
          stages: {
            foundation: { status: 'executing' },
            unknown: { status: 'PRIVATE_SENTINEL' },
            bootstrap: { status: 'PRIVATE_SENTINEL' },
          },
        }),
        { mode: 0o600 }
      );
      return ok({ status: 'inProgress' });
    };
    await client.start(review.runId, 'apply', review.plan!.planSha256);
    const pending = await waitStatus(client, review.runId, 'inProgress');
    expect(pending.currentStage).toBe('foundation');
    expect(pending.stages).toEqual({ foundation: 'executing' });
    const restarted = runner();
    expect((await restarted.status(review.runId)).status).toBe('inProgress');
    handler = async () =>
      ok({
        status: 'complete',
        origin: 'https://aws.example.test',
        testSpUrl: 'https://aws.example.test/test-sp/start',
        browserLoginVerified: true,
        secrets: 'PRIVATE_SENTINEL',
      });
    await restarted.start(review.runId, 'resume', review.plan!.planSha256);
    const completed = await waitStatus(restarted, review.runId, 'complete');
    expect(completed.browserLoginVerified).toBe(false);
    expect(completed.testSpUrl).toBe('https://aws.example.test/test-sp/start');
    expect(JSON.stringify(completed)).not.toContain('PRIVATE_SENTINEL');
    expect(calls.map((call) => call.args[1])).toEqual(['plan', 'apply', 'resume']);
  });
  it('allows one start per process and one durable owner across server instances', async () => {
    const client = runner();
    const review = await planned(client);
    let finish!: (value: AwsWebProcessResult) => void;
    handler = async () =>
      new Promise<AwsWebProcessResult>((resolve) => {
        finish = resolve;
      });
    const one = client.start(review.runId, 'apply', review.plan!.planSha256);
    const two = client.start(review.runId, 'apply', review.plan!.planSha256);
    await expect(two).rejects.toMatchObject({ code: 'aws_web_operation_running' });
    await one;
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(
      runner().start(review.runId, 'resume', review.plan!.planSha256)
    ).rejects.toMatchObject({ code: 'aws_web_operation_lock_requires_review' });
    finish(ok({ status: 'complete' }));
    await waitStatus(client, review.runId, 'complete');
    await expect(
      runner().start(review.runId, 'apply', review.plan!.planSha256)
    ).rejects.toMatchObject({ code: 'aws_web_execution_mode_invalid' });
    expect(calls.filter((call) => call.args[1] === 'apply')).toHaveLength(1);
  });
  it('reports interrupted metadata after server restart and refuses stale lock replay', async () => {
    const client = runner();
    const review = await planned(client);
    const directory = join(root, '.authrim/aws-web', review.runId);
    const path = join(directory, 'web.json');
    const value = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...value, status: 'running' }), { mode: 0o600 });
    await writeFile(join(directory, 'web.lock'), JSON.stringify({ token: 'existing-owner' }), {
      mode: 0o600,
    });
    const restarted = runner();
    expect((await restarted.status(review.runId)).status).toBe('interrupted');
    await expect(
      restarted.start(review.runId, 'resume', review.plan!.planSha256)
    ).rejects.toMatchObject({ code: 'aws_web_operation_lock_requires_review' });
    expect(calls).toHaveLength(1);
  });
  it('rejects symlink-managed directories and plans with changed digest', async () => {
    await mkdir(join(root, '.authrim'), { mode: 0o700 });
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(root, '.authrim/aws-web'));
    await expect(runner().plan(input())).rejects.toMatchObject({
      code: 'aws_web_directory_invalid',
    });
    await rm(join(root, '.authrim/aws-web'));
    handler = async (command) => {
      await planProcess(command);
      return ok({ status: 'planned', planSha256: 'c'.repeat(64) });
    };
    const client = runner();
    const run = await client.plan(input());
    expect((await waitStatus(client, run.runId, 'blocked')).code).toBe('aws_web_plan_invalid');
  });
  it('checks CLI and target identity without claiming deployment permissions', async () => {
    handler = async (command) =>
      command.args[0] === '--version'
        ? { exitCode: 0, stdout: 'aws-cli/2.32.0', stderr: '' }
        : ok({
            Account: target.accountId,
            Arn: `arn:aws:iam::${target.accountId}:role/operator`,
            Private: 'PRIVATE_SENTINEL',
          });
    const result = await runner().check({ ...target, profile: 'operator' });
    expect(result).toMatchObject({
      status: 'passed',
      permissionsVerified: false,
      writeAuthorization: 'not_proven',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(calls[1].args).toContain('get-caller-identity');
    handler = async (command) =>
      command.args[0] === '--version'
        ? { exitCode: 0, stdout: 'aws-cli/2.32.0', stderr: '' }
        : ok({ Account: '999999999999', Arn: 'arn:aws:iam::999999999999:root' });
    await expect(runner().check({ ...target, profile: 'operator' })).rejects.toMatchObject({
      code: 'aws_web_account_mismatch',
    });
  });
  it('requires explicit DSQL verification and forwards only server-stored pins', async () => {
    handler = async (command) => (command.args[1] === 'check' ? dsqlChecked() : ok(dsqlResult()));
    const client = runner();
    const run = await client.dsqlCheck({ ...input(), profile: 'evaluation' });
    const review = await waitStatus(client, run.runId, 'planned');
    expect(calls.map((call) => call.args[1])).toEqual(['check']);
    expect(review.plan).toMatchObject({
      database: 'aurora-dsql',
      fullRuntimeReady: false,
      scope: 'existing-cluster-only',
      mode: 'identity-evaluation',
      hostname,
    });
    expect(JSON.stringify(review)).not.toContain(pins.principalId);
    await expect(client.start(run.runId, 'apply', review.plan!.planSha256)).rejects.toMatchObject({
      code: 'aws_web_execution_mode_invalid',
    });
    await client.start(run.runId, 'verify', review.plan!.planSha256);
    const complete = await waitStatus(client, run.runId, 'complete');
    const verify = calls[1];
    expect(arg(verify, '--config-sha256')).toBe(pins.configSha256);
    expect(arg(verify, '--principal-id')).toBe(pins.principalId);
    expect(arg(verify, '--users')).toBe('1001');
    expect(verify.args).toContain('--write-probe');
    expect(verify.timeoutMs).toBeGreaterThan(46 * 60 * 1000);
    expect(complete.result).toMatchObject({
      passed: true,
      cleanup: 'complete',
      checks: expect.arrayContaining([{ name: 'database', passed: true }]),
      configurationReport: {
        passed: true,
        cleanup: 'complete',
        restoredRows: { 'core.flow_assignments': 102 },
      },
    });
    expect(JSON.stringify(complete)).not.toContain('PRIVATE_SENTINEL');
    await expect(client.start(run.runId, 'verify', review.plan!.planSha256)).rejects.toMatchObject({
      code: 'aws_web_verification_invalid',
    });
  });
  it('retains safe failed DSQL cleanup evidence and prevents automatic/repeated writes', async () => {
    handler = async (command) =>
      command.args[1] === 'check'
        ? dsqlChecked()
        : {
            exitCode: 2,
            stdout: JSON.stringify(dsqlResult(false)),
            stderr: 'password=PRIVATE_SENTINEL',
          };
    const client = runner();
    const run = await client.dsqlCheck({ ...input(), profile: 'evaluation' });
    const review = await waitStatus(client, run.runId, 'planned');
    await client.start(run.runId, 'verify', review.plan!.planSha256);
    const failed = await waitStatus(client, run.runId, 'blocked');
    expect(failed.code).toBe('aws_web_dsql_verification_failed');
    expect(failed.result).toMatchObject({
      passed: false,
      cleanup: 'failed',
      schema: `authrim_dsql_identity_${'a'.repeat(32)}`,
    });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
    await expect(client.start(run.runId, 'verify', review.plan!.planSha256)).rejects.toMatchObject({
      code: 'aws_web_verification_invalid',
    });
    expect(calls.filter((call) => call.args[1] === 'verify')).toHaveLength(1);
  });
  it('keeps identity success and configuration cleanup failure visible without marking complete', async () => {
    const result = dsqlResult();
    if (!result.configurationReport) throw new Error('test_configuration_missing');
    result.status = 'failed';
    result.configurationReport.passed = false;
    result.configurationReport.cleanup = 'creation-unconfirmed';
    result.configurationReport.checks = [
      { name: 'native-schema-and-indexes', passed: false, secret: 'PRIVATE_SENTINEL' },
    ];
    handler = async (command) =>
      command.args[1] === 'check' ? dsqlChecked() : { ...ok(result), exitCode: 2 };
    const client = runner();
    const run = await client.dsqlCheck({ ...input(), profile: 'evaluation' });
    const review = await waitStatus(client, run.runId, 'planned');
    await client.start(run.runId, 'verify', review.plan!.planSha256);
    const failed = await waitStatus(client, run.runId, 'blocked');
    expect(failed.code).toBe('aws_web_dsql_verification_failed');
    expect(failed.result).toMatchObject({
      passed: true,
      configurationReport: { passed: false, cleanup: 'creation-unconfirmed' },
    });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
  });
  it.each(['missing', 'duplicated-check', 'wrong-count', 'wrong-schema', 'missing-check'])(
    'rejects a false configuration success: %s',
    async (scenario) => {
      const result = dsqlResult();
      if (!result.configurationReport) throw new Error('test_configuration_missing');
      if (scenario === 'missing') delete result.configurationReport;
      else if (scenario === 'duplicated-check')
        result.configurationReport.checks = result.configurationReport.checks.map(
          () => result.configurationReport!.checks[0]
        );
      else if (scenario === 'wrong-count')
        result.configurationReport.restoredRows['core.flow_assignments'] = 101;
      else if (scenario === 'wrong-schema')
        result.configurationReport.schema = result.report.schema;
      else result.configurationReport.checks.pop();
      handler = async (command) => (command.args[1] === 'check' ? dsqlChecked() : ok(result));
      const client = runner();
      const run = await client.dsqlCheck({ ...input(), profile: 'evaluation' });
      const review = await waitStatus(client, run.runId, 'planned');
      await client.start(run.runId, 'verify', review.plan!.planSha256);
      const failed = await waitStatus(client, run.runId, 'blocked');
      expect(failed.code).toBe(
        scenario === 'missing' ? 'aws_web_dsql_verification_failed' : 'aws_web_dsql_report_invalid'
      );
      expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
    }
  );
  it('keeps DSQL outcome-unknown codes but discards arbitrary child output', async () => {
    handler = async (command) =>
      command.args[1] === 'check'
        ? dsqlChecked()
        : {
            exitCode: 2,
            stdout: 'password=PRIVATE_SENTINEL',
            stderr: JSON.stringify({
              code: 'aws_dsql_probe_outcome_unknown',
              secret: 'PRIVATE_SENTINEL',
            }),
          };
    const client = runner();
    const run = await client.dsqlCheck({ ...input(), profile: 'evaluation' });
    const review = await waitStatus(client, run.runId, 'planned');
    await client.start(run.runId, 'verify', review.plan!.planSha256);
    const failed = await waitStatus(client, run.runId, 'blocked');
    expect(failed.code).toBe('aws_dsql_probe_outcome_unknown');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
  });
  it('treats an interrupted DSQL subprocess as unknown outcome without replay', async () => {
    handler = async (command) => {
      if (command.args[1] === 'check') return dsqlChecked();
      throw new AwsWebError('aws_web_process_limit');
    };
    const client = runner();
    const run = await client.dsqlCheck({ ...input(), profile: 'evaluation' });
    const review = await waitStatus(client, run.runId, 'planned');
    await client.start(run.runId, 'verify', review.plan!.planSha256);
    expect((await waitStatus(client, run.runId, 'blocked')).code).toBe(
      'aws_dsql_probe_outcome_unknown'
    );
    expect(calls.filter((call) => call.args[1] === 'verify')).toHaveLength(1);
  });
  it('bounds child output and terminates timed-out local processes without returning output', async () => {
    await expect(
      runAwsWebProcess({
        file: process.execPath,
        args: ['-e', 'process.stdout.write("PRIVATE_SENTINEL".repeat(100000))'],
        cwd: root,
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({ code: 'aws_web_process_limit' });
    await expect(
      runAwsWebProcess({
        file: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
        timeoutMs: 100,
      })
    ).rejects.toMatchObject({ code: 'aws_web_process_limit' });
  });
});
