import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dsqlSetupEnvironment, runDsqlSetupCommand } from './setup-dsql.mjs';

const accountId = '123456789012';
const roleId = 'AROASYNTHETICROLE12345';
const principalArn = `arn:aws:iam::${accountId}:role/authrim-dr/operator/test-operator`;
const region = 'ap-northeast-1';
const readonly = {
  formatVersion: 1,
  mode: 'read-only',
  fullRuntimeReady: false,
  passed: true,
  checks: [
    { name: 'connection-and-database', passed: true },
    { name: 'repeatable-read', passed: true },
  ],
  cleanup: 'not-needed',
};
const synthetic = {
  formatVersion: 1,
  mode: 'synthetic-native-identity',
  fullRuntimeReady: false,
  passed: true,
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
  ].map((name) => ({ name, passed: true })),
  cleanup: 'complete',
  restoredRows: { 'core.users_core': 1001, 'pii.users_pii': 1001, 'core.passkeys': 1001 },
  omittedDatasets: [
    'core.client_trust_policies',
    'core.consent_statements',
    'core.contact_points',
    'core.custom_claim_schemas',
    'core.flow_assignments',
    'core.flow_versions',
    'core.flows',
    'core.identity_accounts',
    'core.identity_providers',
    'core.identity_subjects',
    'core.oauth_clients',
    'core.profiles',
    'core.tenants',
    'core.web_origin_registry',
    'pii.identity_sensitive_values',
  ],
  chunks: 33,
  maxChunkRows: 100,
};
const configuration = {
  ...synthetic,
  mode: 'synthetic-native-configuration',
  schema: `authrim_dsql_configuration_${'b'.repeat(32)}`,
  checks: [
    ...synthetic.checks.slice(0, 8),
    ...[
      'native-foreign-key-enforced',
      'native-target-shape-enforced',
      'cross-tenant-reference-rejected',
      'missing-sp-reference-rejected',
      'unsupported-target-inventory-rejected',
      'invalid-configuration-json-rejected',
    ].map((name) => ({ name, passed: true })),
    ...synthetic.checks.slice(8),
  ],
  restoredRows: {
    'core.identity_providers': 101,
    'core.flows': 101,
    'core.flow_versions': 101,
    'core.flow_assignments': 102,
  },
  omittedDatasets: [...Object.keys(synthetic.restoredRows), ...synthetic.omittedDatasets].filter(
    (id) =>
      ![
        'core.identity_providers',
        'core.flows',
        'core.flow_versions',
        'core.flow_assignments',
      ].includes(id)
  ),
  chunks: 8,
};
let root;
let configPath;
let bundlePath;
let calls;
let awsCalls;
let dependencies;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'authrim-dsql-wrapper-'));
  configPath = join(root, 'connection.json');
  bundlePath = join(root, 'packages/ar-runtime-aws/dist/dsql-cli.mjs');
  await mkdir(join(root, 'packages/ar-runtime-aws/dist'), { recursive: true });
  await writeFile(bundlePath, '// synthetic bundled program\n');
  await writeFile(
    configPath,
    JSON.stringify({ hostname: `${'a'.repeat(26)}.dsql.${region}.on.aws`, region, user: 'admin' })
  );
  calls = [];
  awsCalls = [];
  dependencies = {
    aws: async (service, action, input) => {
      awsCalls.push({ service, action, input });
      if (service === 'sts')
        return {
          Account: accountId,
          Arn: `arn:aws:sts::${accountId}:assumed-role/test-operator/session`,
          UserId: `${roleId}:session`,
        };
      if (service === 'iam' && action === 'get-role')
        return { Role: { Arn: principalArn, RoleId: roleId } };
      throw new Error('unexpected service');
    },
    runProcess: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          args[1] === 'configuration-probe'
            ? configuration
            : args.includes('--write-probe')
              ? synthetic
              : readonly
        ),
      };
    },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const argumentsFor = (mode = 'check') => [
  mode,
  '--account-id',
  accountId,
  '--region',
  region,
  '--profile',
  'test-operator',
  '--config',
  configPath,
];
async function reviewedArgs() {
  const result = await runDsqlSetupCommand(argumentsFor(), root, dependencies);
  return [
    ...argumentsFor('verify'),
    '--config-sha256',
    result.configSha256,
    '--bundle-sha256',
    result.bundleSha256,
    '--principal-arn',
    result.principalArn,
    '--principal-id',
    result.principalId,
    '--write-probe',
  ];
}

test('read-only check verifies the selected account, stable role and actual DB connection', async () => {
  const result = await runDsqlSetupCommand(argumentsFor(), root, dependencies);
  assert.equal(result.status, 'checked');
  assert.equal(result.fullRuntimeReady, false);
  assert.equal(result.principalArn, principalArn);
  assert.equal(result.principalId, roleId);
  assert.match(result.configSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.bundleSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    awsCalls.map((x) => `${x.service}/${x.action}`),
    ['sts/get-caller-identity', 'iam/get-role']
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 'probe');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.AWS_PROFILE, 'test-operator');
  assert.ok(!calls[0].args.includes('--write-probe'));
  await assert.rejects(readFile(calls[0].args[0]), { code: 'ENOENT' });
});

test('requires review pins and explicit write flag; then rechecks read access before synthetic writes', async () => {
  const args = await reviewedArgs();
  calls = [];
  const result = await runDsqlSetupCommand(args, root, dependencies);
  assert.equal(result.status, 'verified');
  assert.equal(result.fullRuntimeReady, false);
  assert.equal(result.report.cleanup, 'complete');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args[1], 'configuration-probe');
  assert.equal(calls[2].args.at(-1), '101');
  assert.equal(result.configurationReport.passed, true);
  assert.deepEqual(result.configurationReport.restoredRows, configuration.restoredRows);
  assert.equal(calls[0].args[1], 'probe');
  assert.equal(calls[1].args[1], 'identity-probe');
  assert.equal(calls[1].args.at(-1), '1001');
  for (const remove of ['--write-probe', '--principal-id', '--bundle-sha256']) {
    const copy = [...args];
    const index = copy.indexOf(remove);
    copy.splice(index, remove === '--write-probe' ? 1 : 2);
    await assert.rejects(runDsqlSetupCommand(copy, root, dependencies), {
      code: 'aws_dsql_review_required',
    });
  }
});

test('rejects account or stable role identity mismatch before DB access', async () => {
  dependencies.aws = async () => ({
    Account: '999999999999',
    Arn: 'private-token',
    UserId: 'private-token',
  });
  await assert.rejects(runDsqlSetupCommand(argumentsFor(), root, dependencies), {
    code: 'aws_dsql_account_mismatch',
  });
  assert.equal(calls.length, 0);
});

test('rejects role replacement or different principal at execution time', async () => {
  const args = await reviewedArgs();
  calls = [];
  dependencies.aws = async (service) =>
    service === 'sts'
      ? {
          Account: accountId,
          Arn: `arn:aws:sts::${accountId}:assumed-role/test-operator/new-session`,
          UserId: 'AROAREPLACEDROLE12345:new-session',
        }
      : { Role: { Arn: principalArn, RoleId: 'AROAREPLACEDROLE12345' } };
  await assert.rejects(runDsqlSetupCommand(args, root, dependencies), {
    code: 'aws_dsql_principal_changed',
  });
  assert.equal(calls.length, 0);
});

test('rejects a changed config or program bundle without cloud calls', async () => {
  const args = await reviewedArgs();
  calls = [];
  awsCalls = [];
  const original = await readFile(configPath);
  await writeFile(configPath, `${original.toString()}\n`);
  await assert.rejects(runDsqlSetupCommand(args, root, dependencies), {
    code: 'aws_dsql_review_changed',
  });
  await writeFile(configPath, original);
  await writeFile(bundlePath, '// changed program');
  await assert.rejects(runDsqlSetupCommand(args, root, dependencies), {
    code: 'aws_dsql_review_changed',
  });
  assert.equal(calls.length, 0);
  assert.equal(awsCalls.length, 0);
});

test('runs exact checked bytes even if original files are changed after they were read', async () => {
  const args = await reviewedArgs();
  calls = [];
  const run = dependencies.runProcess;
  dependencies.runProcess = async (file, nativeArgs, options) => {
    await writeFile(configPath, '{"password":"must-not-be-used"}');
    await writeFile(bundlePath, 'throw new Error("must-not-run")');
    assert.match(await readFile(nativeArgs[0], 'utf8'), /synthetic bundled/);
    assert.match(
      await readFile(nativeArgs[nativeArgs.indexOf('--config') + 1], 'utf8'),
      /"user":"admin"/
    );
    return run(file, nativeArgs, options);
  };
  assert.equal((await runDsqlSetupCommand(args, root, dependencies)).status, 'verified');
});

test('rejects wrong-region, secret-bearing or arbitrary endpoint connection settings', async () => {
  for (const config of [
    { hostname: 'private.example.test', region, user: 'admin' },
    { hostname: `${'a'.repeat(26)}.dsql.us-east-1.on.aws`, region: 'us-east-1', user: 'admin' },
    {
      hostname: `${'a'.repeat(26)}.dsql.${region}.on.aws`,
      region,
      user: 'admin',
      password: 'secret',
    },
  ]) {
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(runDsqlSetupCommand(argumentsFor(), root, dependencies), {
      code: 'aws_dsql_config_invalid',
    });
  }
  assert.equal(awsCalls.length, 0);
  assert.equal(calls.length, 0);
});

test('never performs writes when the real read-only probe fails', async () => {
  const args = await reviewedArgs();
  calls = [];
  dependencies.runProcess = async (file, nativeArgs, options) => {
    calls.push({ file, args: nativeArgs, options });
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        ...readonly,
        passed: false,
        checks: [{ name: 'connection-and-database', passed: false }],
      }),
    };
  };
  assert.equal((await runDsqlSetupCommand(args, root, dependencies)).status, 'failed');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.includes('--write-probe'));
});

test('redacts malformed probe output and limits returned data to known public fields', async () => {
  dependencies.runProcess = async () => ({
    exitCode: 1,
    stdout: 'private credentials',
    stderr: 'secret-token',
  });
  await assert.rejects(runDsqlSetupCommand(argumentsFor(), root, dependencies), {
    code: 'aws_dsql_probe_failed',
  });
  dependencies.runProcess = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ ...readonly, password: 'secret-token' }),
  });
  assert.ok(
    !JSON.stringify(await runDsqlSetupCommand(argumentsFor(), root, dependencies)).includes(
      'secret-token'
    )
  );
});

test('clears inherited credentials and endpoint overrides from the native SDK environment', () => {
  const env = dsqlSetupEnvironment('reviewed', region, {
    AWS_ACCESS_KEY_ID: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'secret',
    AWS_ENDPOINT_URL: 'https://attacker.invalid',
    AWS_ENDPOINT_URL_STS: 'https://attacker.invalid',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'https://attacker.invalid',
    AWS_ROLE_ARN: 'secret',
    AWS_WEB_IDENTITY_TOKEN_FILE: 'secret',
    NODE_OPTIONS: '--import secret',
    PATH: '/bin',
  });
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.ok(!JSON.stringify(env).includes('attacker'));
  assert.equal(env.AWS_PROFILE, 'reviewed');
  assert.equal(env.PATH, '/bin');
});

test('keeps the dedicated evaluation identity explicit when a root profile is selected', async () => {
  dependencies.aws = async () => ({
    Account: accountId,
    Arn: `arn:aws:iam::${accountId}:root`,
    UserId: accountId,
  });
  const result = await runDsqlSetupCommand(argumentsFor(), root, dependencies);
  assert.equal(result.principalArn, `arn:aws:iam::${accountId}:root`);
  assert.equal(result.principalId, accountId);
  assert.equal(result.fullRuntimeReady, false);
});

test('does not accept duplicated successful checks or the wrong synthetic row count', async () => {
  dependencies.runProcess = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ ...readonly, checks: [readonly.checks[0], readonly.checks[0]] }),
  });
  await assert.rejects(runDsqlSetupCommand(argumentsFor(), root, dependencies), {
    code: 'aws_dsql_probe_result_invalid',
  });
  dependencies.runProcess = async (_file, args) => ({
    exitCode: 0,
    stdout: JSON.stringify(
      args[1] === 'configuration-probe'
        ? configuration
        : args.includes('--write-probe')
          ? synthetic
          : readonly
    ),
  });
  const review = await reviewedArgs();
  await assert.rejects(runDsqlSetupCommand([...review, '--users', '2'], root, dependencies), {
    code: 'aws_dsql_probe_result_invalid',
  });
});

test('retains safe cleanup evidence on failure and reports uncertain timeouts without false success', async () => {
  const args = await reviewedArgs();
  dependencies.runProcess = async (_file, nativeArgs) =>
    nativeArgs.includes('--write-probe')
      ? {
          exitCode: 1,
          stdout: JSON.stringify({
            formatVersion: 1,
            mode: 'synthetic-native-identity',
            fullRuntimeReady: false,
            passed: false,
            schema: synthetic.schema,
            checks: [{ name: 'native-schema-and-indexes', passed: false }],
            cleanup: 'creation-unconfirmed',
            secret: 'never-return',
          }),
        }
      : { exitCode: 0, stdout: JSON.stringify(readonly) };
  const failed = await runDsqlSetupCommand(args, root, dependencies);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.report.cleanup, 'creation-unconfirmed');
  assert.equal(failed.report.schema, synthetic.schema);
  assert.ok(!JSON.stringify(failed).includes('never-return'));
  dependencies.runProcess = async (_file, nativeArgs) =>
    nativeArgs.includes('--write-probe')
      ? { exitCode: 1, timedOut: true, stdout: 'secret' }
      : { exitCode: 0, stdout: JSON.stringify(readonly) };
  await assert.rejects(runDsqlSetupCommand(args, root, dependencies), {
    code: 'aws_dsql_probe_outcome_unknown',
  });
});

test('rejects invalid option names, profiles and row counts before accessing files or AWS', async () => {
  const base = argumentsFor();
  for (const args of [
    [...base, '--endpoint-url', 'private'],
    base.map((x) => (x === 'test-operator' ? 'bad;profile' : x)),
    [...base, '--write-probe'],
  ])
    await assert.rejects(runDsqlSetupCommand(args, root, dependencies), {
      code: 'aws_dsql_arguments_invalid',
    });
  const review = await reviewedArgs();
  calls = [];
  for (const count of ['0', '2001', '1e3', '2.5'])
    await assert.rejects(runDsqlSetupCommand([...review, '--users', count], root, dependencies), {
      code: 'aws_dsql_arguments_invalid',
    });
  assert.equal(calls.length, 0);
});

test('configuration failure preserves both reports and never reports the environment as verified', async () => {
  const args = await reviewedArgs();
  const original = dependencies.runProcess;
  dependencies.runProcess = async (file, nativeArgs, options) =>
    nativeArgs[1] === 'configuration-probe'
      ? {
          exitCode: 1,
          stdout: JSON.stringify({
            ...configuration,
            passed: false,
            cleanup: 'creation-unconfirmed',
            checks: [{ name: 'native-schema-and-indexes', passed: false, sqlState: '0A000' }],
            secret: 'NEVER_RETURN',
          }),
        }
      : original(file, nativeArgs, options);
  const result = await runDsqlSetupCommand(args, root, dependencies);
  assert.equal(result.status, 'failed');
  assert.equal(result.report.passed, true);
  assert.equal(result.configurationReport.passed, false);
  assert.equal(result.configurationReport.cleanup, 'creation-unconfirmed');
  assert.ok(!JSON.stringify(result).includes('NEVER_RETURN'));
});

test('rejects duplicate, missing, cross-mode checks and incorrect configuration counts or cleanup', async () => {
  const args = await reviewedArgs();
  const original = dependencies.runProcess;
  for (const changes of [
    { checks: configuration.checks.slice(1) },
    { checks: [...configuration.checks.slice(0, -1), configuration.checks[0]] },
    { checks: [...configuration.checks.slice(0, -1), { name: 'repeatable-read', passed: true }] },
    { restoredRows: { ...configuration.restoredRows, 'core.flow_assignments': 101 } },
    { schema: synthetic.schema },
    { cleanup: 'failed' },
    { chunks: 7 },
    { fullRuntimeReady: true },
  ]) {
    dependencies.runProcess = async (file, nativeArgs, options) =>
      nativeArgs[1] === 'configuration-probe'
        ? { exitCode: 0, stdout: JSON.stringify({ ...configuration, ...changes }) }
        : original(file, nativeArgs, options);
    await assert.rejects(runDsqlSetupCommand(args, root, dependencies), {
      code: 'aws_dsql_probe_result_invalid',
    });
  }
});

test('does not create configuration objects after the identity trial failed', async () => {
  const args = await reviewedArgs();
  calls = [];
  const original = dependencies.runProcess;
  dependencies.runProcess = async (file, nativeArgs, options) => {
    if (nativeArgs[1] === 'identity-probe') {
      calls.push({ file, args: nativeArgs, options });
      return {
        exitCode: 1,
        stdout: JSON.stringify({ ...synthetic, passed: false, cleanup: 'failed' }),
      };
    }
    return original(file, nativeArgs, options);
  };
  const result = await runDsqlSetupCommand(args, root, dependencies);
  assert.equal(result.status, 'failed');
  assert.equal(result.configurationReport, undefined);
  assert.ok(!calls.some((call) => call.args[1] === 'configuration-probe'));
});
