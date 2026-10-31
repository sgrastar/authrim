/** Existing-cluster DSQL evaluation only. Never deploys or activates a SAML runtime. */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AwsSetupError, createAwsSetupCli } from './setup-aws-cli.mjs';
import { readSetupFile, setupDigest } from './setup-execution-state.mjs';

const execute = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/u;
/** Literal text for a RegExp: the account ID comes from a command-line argument or the caller identity. */
const escapeRegExp = (value) => String(value).replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
const IDENTITY_CHECKS = [
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
];
const CONFIGURATION_CHECKS = [
  ...IDENTITY_CHECKS.slice(0, 8),
  'native-foreign-key-enforced',
  'native-target-shape-enforced',
  'cross-tenant-reference-rejected',
  'missing-sp-reference-rejected',
  'unsupported-target-inventory-rejected',
  'invalid-configuration-json-rejected',
  ...IDENTITY_CHECKS.slice(8),
];
const CONFIGURATION_DATASETS = [
  'core.identity_providers',
  'core.flows',
  'core.flow_versions',
  'core.flow_assignments',
];
// Fixed bounded settings trial; this is independent of the identity fixture size.
const CONFIGURATION_SP_COUNT = 101;
const DATASETS = ['core.users_core', 'pii.users_pii', 'core.passkeys'];
const OMITTED = new Set([
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
]);
const fail = (code) => {
  throw new AwsSetupError(`aws_dsql_${code}`);
};

function argumentsFor(args) {
  const [mode, ...rest] = args;
  if (!['check', 'verify'].includes(mode)) fail('arguments_invalid');
  const allowed = new Set(['account-id', 'region', 'profile', 'config']);
  if (mode === 'verify')
    for (const key of [
      'config-sha256',
      'bundle-sha256',
      'principal-arn',
      'principal-id',
      'users',
      'write-probe',
    ])
      allowed.add(key);
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const key = arg?.slice(2);
    if (!arg?.startsWith('--') || !allowed.has(key) || options[key] !== undefined)
      fail('arguments_invalid');
    if (key === 'write-probe') options[key] = true;
    else {
      const value = rest[++index];
      if (typeof value !== 'string' || !value || value.startsWith('--')) fail('arguments_invalid');
      options[key] = value;
    }
  }
  if (
    !/^\d{12}$/u.test(options['account-id'] ?? '') ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(options.region ?? '') ||
    !/^[A-Za-z0-9_+=,.@-]{1,128}$/u.test(options.profile ?? '') ||
    typeof options.config !== 'string' ||
    options.config.includes('\0')
  )
    fail('arguments_invalid');
  if (
    mode === 'verify' &&
    (options['write-probe'] !== true ||
      !HASH.test(options['config-sha256'] ?? '') ||
      !HASH.test(options['bundle-sha256'] ?? '') ||
      !new RegExp(
        `^arn:aws:iam::${escapeRegExp(options['account-id'])}:(?:root|(?:user|role)/[A-Za-z0-9/+=,.@_-]+)$`,
        'u'
      ).test(options['principal-arn'] ?? '') ||
      !/^[A-Za-z0-9]{12,128}$/u.test(options['principal-id'] ?? ''))
  )
    fail('review_required');
  const users = mode === 'verify' ? (options.users ?? '1001') : undefined;
  if (users !== undefined && (!/^[1-9]\d{0,3}$/u.test(users) || Number(users) > 2000))
    fail('arguments_invalid');
  return { mode, options, users };
}

function connectionConfig(bytes, region) {
  let config;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('config_invalid');
  }
  const allowed = [
    'hostname',
    'region',
    'user',
    'maxConnections',
    'connectionTimeoutMs',
    'queryTimeoutMs',
  ];
  if (
    !config ||
    Object.getPrototypeOf(config) !== Object.prototype ||
    Object.keys(config).some((key) => !allowed.includes(key)) ||
    config.region !== region ||
    typeof config.hostname !== 'string' ||
    !/^[a-z0-9]{26}\.dsql\.[a-z0-9-]+\.on\.aws$/u.test(config.hostname) ||
    !config.hostname.endsWith(`.dsql.${region}.on.aws`) ||
    typeof config.user !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(config.user)
  )
    fail('config_invalid');
  for (const [value, maximum] of [
    [config.maxConnections ?? 4, 16],
    [config.connectionTimeoutMs ?? 5000, 30000],
    [config.queryTimeoutMs ?? 10000, 60000],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('config_invalid');
  return config;
}

/** SDK and CLI must resolve the same named profile, not inherited static/environment credentials. */
export function dsqlSetupEnvironment(profile, region, source = process.env) {
  const env = {
    ...source,
    AWS_PROFILE: profile,
    AWS_DEFAULT_PROFILE: profile,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_SDK_LOAD_CONFIG: '1',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_PAGER: '',
    AWS_CLI_AUTO_PROMPT: 'off',
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('AWS_ENDPOINT_URL') ||
      key.startsWith('AWS_CONTAINER_') ||
      [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_SECURITY_TOKEN',
        'AWS_ROLE_ARN',
        'AWS_ROLE_SESSION_NAME',
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'NODE_OPTIONS',
        'NODE_PATH',
      ].includes(key)
    )
      delete env[key];
  }
  return env;
}

async function runProcess(file, args, options) {
  try {
    return { exitCode: 0, ...(await execute(file, args, options)) };
  } catch (error) {
    return { exitCode: 1, timedOut: error.killed === true, stdout: error.stdout ?? '' };
  }
}

async function identityFor(aws, accountId) {
  const identity = await aws('sts', 'get-caller-identity');
  if (
    identity.Account !== accountId ||
    typeof identity.Arn !== 'string' ||
    typeof identity.UserId !== 'string'
  )
    fail('account_mismatch');
  const role = new RegExp(
    `^arn:aws:sts::${escapeRegExp(accountId)}:assumed-role/([A-Za-z0-9+=,.@_-]+)/[^/]+$`,
    'u'
  ).exec(identity.Arn);
  if (role) {
    const value = await aws('iam', 'get-role', { RoleName: role[1] });
    if (
      typeof value.Role?.Arn !== 'string' ||
      typeof value.Role?.RoleId !== 'string' ||
      !/^[A-Za-z0-9]{12,128}$/u.test(value.Role.RoleId) ||
      !new RegExp(`^arn:aws:iam::${escapeRegExp(accountId)}:role/[A-Za-z0-9/+=,.@_-]+$`, 'u').test(
        value.Role.Arn
      ) ||
      value.Role.Arn.split('/').at(-1) !== role[1] ||
      identity.UserId.split(':')[0] !== value.Role.RoleId
    )
      fail('principal_invalid');
    return { principalArn: value.Role.Arn, principalId: value.Role.RoleId };
  }
  if (
    !new RegExp(
      `^arn:aws:iam::${escapeRegExp(accountId)}:(?:root|user/[A-Za-z0-9/+=,.@_-]+)$`,
      'u'
    ).test(identity.Arn) ||
    !/^[A-Za-z0-9]{12,128}$/u.test(identity.UserId)
  )
    fail('principal_invalid');
  return { principalArn: identity.Arn, principalId: identity.UserId };
}

/** Allow-listed machine result only; raw child stdout/stderr never enters an error or result. */
function probeReport(output, nativeMode, users) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    fail('probe_failed');
  }
  if (
    !value ||
    value.formatVersion !== 1 ||
    value.mode !== nativeMode ||
    value.fullRuntimeReady !== false ||
    typeof value.passed !== 'boolean' ||
    !Array.isArray(value.checks) ||
    value.checks.length > 20 ||
    !['not-needed', 'complete', 'failed', 'creation-unconfirmed'].includes(value.cleanup)
  )
    fail('probe_result_invalid');
  const expectedChecks =
    nativeMode === 'read-only'
      ? ['connection-and-database', 'repeatable-read']
      : nativeMode === 'synthetic-native-configuration'
        ? CONFIGURATION_CHECKS
        : IDENTITY_CHECKS;
  const allowedChecks = new Set([
    ...expectedChecks,
    ...(nativeMode === 'read-only' ? [] : ['local-fixture-cleanup']),
  ]);
  const checks = value.checks.map((check) => {
    if (
      !allowedChecks.has(check?.name) ||
      typeof check.passed !== 'boolean' ||
      (check.sqlState !== undefined && !/^[A-Z0-9]{5}$/u.test(check.sqlState))
    )
      fail('probe_result_invalid');
    return {
      name: check.name,
      passed: check.passed,
      ...(check.sqlState ? { sqlState: check.sqlState } : {}),
    };
  });
  const report = {
    formatVersion: 1,
    mode: nativeMode,
    fullRuntimeReady: false,
    passed: value.passed,
    checks,
    cleanup: value.cleanup,
  };
  const configuration = nativeMode === 'synthetic-native-configuration';
  const datasets = configuration ? CONFIGURATION_DATASETS : DATASETS;
  const omitted = configuration
    ? new Set([...DATASETS, ...OMITTED].filter((id) => !datasets.includes(id)))
    : OMITTED;
  const countFor = (id) =>
    configuration
      ? CONFIGURATION_SP_COUNT + (id === 'core.flow_assignments' ? 1 : 0)
      : Number(users);
  if (value.schema !== undefined) {
    const pattern = configuration
      ? /^authrim_dsql_configuration_[a-f0-9]{32}$/u
      : /^authrim_dsql_identity_[a-f0-9]{32}$/u;
    if (nativeMode === 'read-only' || !pattern.test(value.schema)) fail('probe_result_invalid');
    report.schema = value.schema;
  }
  if (nativeMode !== 'read-only' && value.restoredRows !== undefined) {
    if (
      !value.restoredRows ||
      Object.keys(value.restoredRows).sort().join(',') !== [...datasets].sort().join(',') ||
      Object.values(value.restoredRows).some(
        (count) =>
          !Number.isSafeInteger(count) || count < 0 || count > (configuration ? 2001 : 2000)
      )
    )
      fail('probe_result_invalid');
    report.restoredRows = Object.fromEntries(datasets.map((id) => [id, value.restoredRows[id]]));
    if (
      !Array.isArray(value.omittedDatasets) ||
      value.omittedDatasets.length !== omitted.size ||
      new Set(value.omittedDatasets).size !== omitted.size ||
      value.omittedDatasets.some((id) => !omitted.has(id))
    )
      fail('probe_result_invalid');
    report.omittedDatasets = [...value.omittedDatasets];
    if (
      !Number.isSafeInteger(value.chunks) ||
      value.chunks < 1 ||
      value.chunks > 1000 ||
      !Number.isSafeInteger(value.maxChunkRows) ||
      value.maxChunkRows < 1 ||
      value.maxChunkRows > 100
    )
      fail('probe_result_invalid');
    report.chunks = value.chunks;
    report.maxChunkRows = value.maxChunkRows;
  }
  if (
    report.passed &&
    (checks.length !== expectedChecks.length ||
      new Set(checks.map((check) => check.name)).size !== expectedChecks.length ||
      checks.some((check) => !expectedChecks.includes(check.name) || !check.passed) ||
      report.cleanup !== (nativeMode === 'read-only' ? 'not-needed' : 'complete') ||
      (nativeMode !== 'read-only' &&
        (!report.schema ||
          !report.restoredRows ||
          datasets.some((id) => report.restoredRows[id] !== countFor(id)) ||
          report.chunks < datasets.reduce((sum, id) => sum + Math.ceil(countFor(id) / 100), 0))))
  )
    fail('probe_result_invalid');
  return report;
}

export async function runDsqlSetupCommand(args, root = process.cwd(), dependencies = {}) {
  const { mode, options, users } = argumentsFor(args);
  const configBytes = await readSetupFile(resolve(options.config), { maxBytes: 16 * 1024 });
  const config = connectionConfig(configBytes, options.region);
  const bundle = await readSetupFile(
    join(resolve(root), 'packages/ar-runtime-aws/dist/dsql-cli.mjs'),
    { maxBytes: 64 * 1024 * 1024 }
  );
  const pins = { configSha256: setupDigest(configBytes), bundleSha256: setupDigest(bundle) };
  if (
    mode === 'verify' &&
    (pins.configSha256 !== options['config-sha256'] ||
      pins.bundleSha256 !== options['bundle-sha256'])
  )
    fail('review_changed');
  const aws =
    dependencies.aws ??
    createAwsSetupCli(
      { region: options.region, profile: options.profile },
      {
        ...(dependencies.runAwsProcess ? { runProcess: dependencies.runAwsProcess } : {}),
      }
    );
  const principal = await identityFor(aws, options['account-id']);
  if (
    mode === 'verify' &&
    (principal.principalArn !== options['principal-arn'] ||
      principal.principalId !== options['principal-id'])
  )
    fail('principal_changed');
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-dsql-setup-'));
  try {
    const configPath = join(directory, 'connection.json');
    const bundlePath = join(directory, 'dsql-cli.mjs');
    await writeFile(configPath, configBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o600 });
    const run = dependencies.runProcess ?? runProcess;
    const invoke = async (kind) => {
      const write = kind !== 'read-only';
      const configuration = kind === 'synthetic-native-configuration';
      const result = await run(
        process.execPath,
        [
          bundlePath,
          ...(write
            ? [
                configuration ? 'configuration-probe' : 'identity-probe',
                '--config',
                configPath,
                '--write-probe',
                configuration ? '--sps' : '--users',
                configuration ? String(CONFIGURATION_SP_COUNT) : users,
              ]
            : ['probe', '--config', configPath]),
        ],
        {
          cwd: resolve(root),
          shell: false,
          encoding: 'utf8',
          maxBuffer: 256 * 1024,
          timeout: write ? 45 * 60 * 1000 : 90 * 1000,
          env: dsqlSetupEnvironment(options.profile, options.region),
        }
      );
      if (result.timedOut) fail(write ? 'probe_outcome_unknown' : 'probe_failed');
      const report = probeReport(result.stdout, kind, users);
      if (result.exitCode !== 0 && report.passed) fail('probe_result_invalid');
      return report;
    };
    const readonly = await invoke('read-only');
    const report =
      mode === 'verify' && readonly.passed ? await invoke('synthetic-native-identity') : readonly;
    const configurationReport =
      mode === 'verify' && report.mode === 'synthetic-native-identity' && report.passed
        ? await invoke('synthetic-native-configuration')
        : undefined;
    return {
      status:
        report.passed && (mode === 'check' || configurationReport?.passed)
          ? mode === 'check'
            ? 'checked'
            : 'verified'
          : 'failed',
      database: 'aurora-dsql',
      fullRuntimeReady: false,
      target: {
        accountId: options['account-id'],
        region: options.region,
        hostname: config.hostname,
      },
      profile: options.profile,
      ...principal,
      ...pins,
      report,
      ...(configurationReport ? { configurationReport } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDsqlSetupCommand(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === 'failed') process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ status: 'blocked', code: error instanceof AwsSetupError ? error.code : 'aws_dsql_setup_failed' })}\n`
      );
      process.exitCode = 2;
    });
}
