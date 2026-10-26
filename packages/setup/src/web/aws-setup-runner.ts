/** Local-only bridge to the existing, pinned AWS setup executors. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseAwsConfigurationInput } from './aws-configuration.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/u;
const PROFILE = /^[A-Za-z0-9_+=,.@-]{1,128}$/u;
const DSQL_IDENTITY_CHECKS = [
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
const DSQL_CONFIGURATION_CHECKS = [
  ...DSQL_IDENTITY_CHECKS.slice(0, 8),
  'native-foreign-key-enforced',
  'native-target-shape-enforced',
  'cross-tenant-reference-rejected',
  'missing-sp-reference-rejected',
  'unsupported-target-inventory-rejected',
  'invalid-configuration-json-rejected',
  ...DSQL_IDENTITY_CHECKS.slice(8),
];
const DSQL_CONFIGURATION_DATASETS = [
  'core.identity_providers',
  'core.flows',
  'core.flow_versions',
  'core.flow_assignments',
];
const DSQL_DATASETS = ['core.users_core', 'pii.users_pii', 'core.passkeys'];
const STAGE_STATUSES = new Set([
  'pending',
  'preparing',
  'executing',
  'inProgress',
  'invoking',
  'complete',
  'requiresInspection',
  'failed',
]);
const STAGES = [
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
type RecordValue = Record<string, unknown>;
export type AwsWebStatus =
  | 'planning'
  | 'planned'
  | 'running'
  | 'inProgress'
  | 'complete'
  | 'blocked'
  | 'interrupted';
export class AwsWebError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface AwsWebTarget {
  accountId: string;
  region: string;
}
interface ReviewIdentity {
  profile: string;
  principalArn: string;
}
export interface AwsWebPlan {
  planSha256: string;
  target: AwsWebTarget;
  backend: 'aws';
  database: 'postgresql' | 'aurora-dsql';
  role?: 'primary' | 'secondary';
  mode: 'browser-rehearsal' | 'existing-issuer' | 'identity-evaluation';
  stages: string[];
  fullRuntimeReady?: false;
  scope?: 'existing-cluster-only';
  hostname?: string;
  stacks?: Array<{ stage: string; name: string; disposition: 'create' | 'reuse' }>;
  identities?: { bootstrap: ReviewIdentity; operator: ReviewIdentity };
  issuerHost?: string;
  profile?: string;
  principalArn?: string;
}
export interface AwsWebRun {
  runId: string;
  status: AwsWebStatus;
  plan?: AwsWebPlan;
  currentStage?: string;
  stages?: Record<string, string>;
  code?: string;
  origin?: string;
  testSpUrl?: string;
  browserLoginVerified: false;
  result?: RecordValue;
}
interface DsqlPins extends AwsWebTarget {
  configPath: string;
  profile: string;
  configSha256: string;
  bundleSha256: string;
  principalArn: string;
  principalId: string;
}
interface Metadata extends AwsWebRun {
  formatVersion: 1;
  kind: 'postgresql' | 'aurora-dsql';
  target: AwsWebTarget;
  dsql?: DsqlPins;
  dsqlUserCount?: number;
}
export interface AwsWebProcessInput {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}
export interface AwsWebProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface AwsWebRunnerOptions {
  rootDir?: string;
  runProcess?: (input: AwsWebProcessInput) => Promise<AwsWebProcessResult>;
  /** Bounded observation; work is resumable after this window, never a rollback. */
  observationMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface AwsWebPlanInput extends AwsWebTarget {
  configPath: string;
}
export interface AwsWebCheckInput extends AwsWebTarget {
  profile: string;
}

function fail(code: string): never {
  throw new AwsWebError(`aws_web_${code}`);
}
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('response_invalid');
  return value as RecordValue;
}
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)])
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function target(input: AwsWebTarget): void {
  if (!/^\d{12}$/u.test(input.accountId) || !REGION.test(input.region)) fail('target_invalid');
}
function configInput(input: AwsWebPlanInput): void {
  target(input);
  if (
    typeof input.configPath !== 'string' ||
    !isAbsolute(input.configPath) ||
    input.configPath.length > 4096 ||
    input.configPath.includes('\0')
  )
    fail('config_path_invalid');
}
function parseJson(text: string): RecordValue {
  try {
    return object(JSON.parse(text));
  } catch {
    return fail('response_invalid');
  }
}
function safeCode(error: unknown): string {
  return error instanceof AwsWebError ? error.code : 'aws_web_operation_failed';
}
function childCode(result: AwsWebProcessResult): string {
  try {
    const parsed = parseJson(result.stderr.trim());
    if (typeof parsed.code === 'string' && /^aws_(?:setup|dsql)_[a-z_]{1,100}$/u.test(parsed.code))
      return parsed.code;
  } catch {
    /* Untrusted output is deliberately discarded. */
  }
  return 'aws_web_process_failed';
}

function dsqlReport(
  value: unknown,
  kind: 'identity' | 'configuration',
  userCount: number
): RecordValue {
  const report = object(value);
  const readonly = kind === 'identity' && report.mode === 'read-only' && report.passed === false;
  const configuration = kind === 'configuration';
  const expectedChecks = readonly
    ? ['connection-and-database', 'repeatable-read']
    : configuration
      ? DSQL_CONFIGURATION_CHECKS
      : DSQL_IDENTITY_CHECKS;
  const allowedChecks = new Set([
    ...expectedChecks,
    ...(readonly ? [] : ['local-fixture-cleanup']),
  ]);
  const datasets = configuration ? DSQL_CONFIGURATION_DATASETS : DSQL_DATASETS;
  const expectedCount = (id: string) =>
    configuration ? 101 + (id === 'core.flow_assignments' ? 1 : 0) : userCount;
  if (
    report.formatVersion !== 1 ||
    (!readonly &&
      report.mode !==
        (configuration ? 'synthetic-native-configuration' : 'synthetic-native-identity')) ||
    report.fullRuntimeReady !== false ||
    typeof report.passed !== 'boolean' ||
    !['not-needed', 'complete', 'failed', 'creation-unconfirmed'].includes(
      String(report.cleanup)
    ) ||
    !Array.isArray(report.checks) ||
    report.checks.length > 20
  )
    fail('dsql_report_invalid');
  const checks = report.checks.map((item: unknown) => {
    const check = object(item);
    if (
      typeof check.name !== 'string' ||
      !allowedChecks.has(check.name) ||
      typeof check.passed !== 'boolean'
    )
      fail('dsql_report_invalid');
    return { name: check.name, passed: check.passed };
  });
  const result: RecordValue = {
    formatVersion: 1,
    mode: report.mode,
    fullRuntimeReady: false,
    passed: report.passed,
    cleanup: report.cleanup,
    checks,
  };
  if (report.schema !== undefined) {
    if (
      typeof report.schema !== 'string' ||
      readonly ||
      !(
        configuration
          ? /^authrim_dsql_configuration_[a-f0-9]{32}$/u
          : /^authrim_dsql_identity_[a-f0-9]{32}$/u
      ).test(report.schema)
    )
      fail('dsql_report_invalid');
    result.schema = report.schema;
  }
  if (report.restoredRows !== undefined) {
    const rows = object(report.restoredRows);
    if (
      Object.keys(rows).sort().join() !== [...datasets].sort().join() ||
      Object.values(rows).some(
        (count) =>
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > (configuration ? 2001 : 2000)
      )
    )
      fail('dsql_report_invalid');
    result.restoredRows = Object.fromEntries(datasets.map((key) => [key, rows[key]]));
    for (const key of ['chunks', 'maxChunkRows']) {
      if (
        typeof report[key] !== 'number' ||
        !Number.isSafeInteger(report[key]) ||
        report[key] < 1 ||
        report[key] > (key === 'chunks' ? 1000 : 100)
      )
        fail('dsql_report_invalid');
      result[key] = report[key];
    }
  }
  if (
    report.passed &&
    (checks.length !== expectedChecks.length ||
      new Set(checks.map((check) => check.name)).size !== expectedChecks.length ||
      checks.some((check) => !check.passed || !expectedChecks.includes(check.name)) ||
      result.cleanup !== 'complete' ||
      !result.schema ||
      !result.restoredRows ||
      datasets.some((id) => object(result.restoredRows)[id] !== expectedCount(id)) ||
      Number(result.chunks) <
        datasets.reduce((sum, id) => sum + Math.ceil(expectedCount(id) / 100), 0))
  )
    fail('dsql_report_invalid');
  return result;
}

function reviewIdentity(value: unknown, accountId: string, dsql = false): ReviewIdentity {
  const identity = object(value);
  if (
    typeof identity.profile !== 'string' ||
    !PROFILE.test(identity.profile) ||
    typeof identity.principalArn !== 'string' ||
    !new RegExp(
      `^arn:aws:iam::${accountId}:(?:${dsql ? 'root|' : ''}(?:role|user)/[A-Za-z0-9/+=,.@_-]+)$`,
      'u'
    ).test(identity.principalArn)
  )
    fail('plan_invalid');
  return { profile: identity.profile, principalArn: identity.principalArn };
}
function postgresScope(
  config: RecordValue,
  expected: AwsWebTarget
): Pick<AwsWebPlan, 'stacks' | 'identities' | 'issuerHost'> {
  const identities = object(config.identities);
  const stacks = object(config.stacks);
  const scope: Pick<AwsWebPlan, 'stacks' | 'identities' | 'issuerHost'> = {
    identities: {
      bootstrap: reviewIdentity(identities.bootstrap, expected.accountId),
      operator: reviewIdentity(identities.operator, expected.accountId),
    },
    stacks: [
      'bootstrap',
      'foundation',
      ...(config.mode === 'browser-rehearsal' ? ['access'] : []),
      'database',
      'workload',
    ].map((stage) => {
      const stack = object(stacks[stage]);
      if (
        typeof stack.name !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9-]{0,44}$/u.test(stack.name) ||
        !['create', 'reuse'].includes(String(stack.disposition))
      )
        fail('plan_invalid');
      return { stage, name: stack.name, disposition: stack.disposition as 'create' | 'reuse' };
    }),
  };
  if (config.mode === 'existing-issuer') {
    const host = object(config.issuer).host;
    if (
      typeof host !== 'string' ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(host)
    )
      fail('plan_invalid');
    scope.issuerHost = host;
  }
  return scope;
}

function reviewPlan(value: AwsWebPlan, expected: AwsWebTarget): AwsWebPlan {
  if (
    !HASH.test(value.planSha256) ||
    value.backend !== 'aws' ||
    canonical(value.target) !== canonical(expected)
  )
    fail('state_invalid');
  const shared = { planSha256: value.planSha256, target: { ...expected }, backend: 'aws' as const };
  if (
    value.database === 'postgresql' &&
    ['primary', 'secondary'].includes(String(value.role)) &&
    ['browser-rehearsal', 'existing-issuer'].includes(value.mode) &&
    Array.isArray(value.stages) &&
    value.stages.join() === STAGES.join()
  )
    return {
      ...shared,
      database: 'postgresql',
      role: value.role,
      mode: value.mode,
      stages: [...STAGES],
      ...postgresScope(
        {
          mode: value.mode,
          identities: value.identities,
          stacks: Object.fromEntries((value.stacks ?? []).map((stack) => [stack.stage, stack])),
          ...(value.issuerHost ? { issuer: { host: value.issuerHost } } : {}),
        },
        expected
      ),
    };
  if (
    value.database === 'aurora-dsql' &&
    value.mode === 'identity-evaluation' &&
    value.fullRuntimeReady === false &&
    value.scope === 'existing-cluster-only' &&
    typeof value.hostname === 'string' &&
    /^[a-z0-9]{26}\.dsql\.[a-z0-9-]+\.on\.aws$/u.test(value.hostname)
  )
    return {
      ...shared,
      database: 'aurora-dsql',
      mode: 'identity-evaluation',
      fullRuntimeReady: false,
      scope: 'existing-cluster-only',
      hostname: value.hostname,
      stages: ['identity-probe'],
      ...reviewIdentity(
        { profile: value.profile, principalArn: value.principalArn },
        expected.accountId,
        true
      ),
    };
  return fail('state_invalid');
}

/** Fixed commands only; callers never receive arbitrary command output or credentials. */
export function runAwsWebProcess(input: AwsWebProcessInput): Promise<AwsWebProcessResult> {
  return new Promise((resolveResult, reject) => {
    const env = {
      ...process.env,
      AWS_PAGER: '',
      AWS_CLI_AUTO_PROMPT: 'off',
      AWS_MAX_ATTEMPTS: '1',
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    };
    for (const key of Object.keys(env))
      if (key.startsWith('AWS_ENDPOINT_URL')) delete env[key as keyof typeof env];
    const child = spawn(input.file, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (exceeded) return;
      exceeded = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(stop, input.timeoutMs);
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      if (exceeded) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > 1024 * 1024) {
        stop();
        return;
      }
      if (kind === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(new AwsWebError('aws_web_process_unavailable'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (exceeded) reject(new AwsWebError('aws_web_process_limit'));
      else resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export class AwsSetupWebRunner {
  private readonly root: string;
  private readonly execute: NonNullable<AwsWebRunnerOptions['runProcess']>;
  private readonly active = new Set<string>();
  private readonly observationMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  constructor(options: AwsWebRunnerOptions = {}) {
    this.root = resolve(options.rootDir ?? process.cwd());
    this.execute = options.runProcess ?? runAwsWebProcess;
    this.observationMs = options.observationMs ?? 20 * 60 * 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }
  private async base(): Promise<string> {
    const root = await realpath(this.root);
    const authrim = join(root, '.authrim');
    await mkdir(authrim, { recursive: true, mode: 0o700 });
    const parent = await lstat(authrim);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('directory_invalid');
    const base = join(authrim, 'aws-web');
    await mkdir(base, { mode: 0o700, recursive: true });
    const stat = await lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      fail('directory_invalid');
    return base;
  }
  private async directory(runId: string): Promise<string> {
    if (!UUID.test(runId)) fail('run_id_invalid');
    const directory = join(await this.base(), runId);
    const stat = await lstat(directory).catch(() => fail('run_not_found'));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      fail('directory_invalid');
    return directory;
  }
  private async read(path: string): Promise<RecordValue> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
      fail('file_unavailable')
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > 4 * 1024 * 1024 || (Number(before.mode) & 0o077) !== 0)
        fail('file_invalid');
      const contents = await file.readFile('utf8');
      const after = await file.stat({ bigint: true });
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        fail('file_changed');
      return parseJson(contents);
    } finally {
      await file.close();
    }
  }
  private async write(directory: string, metadata: Metadata): Promise<void> {
    const path = join(directory, 'web.json');
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(metadata)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  private async metadata(runId: string): Promise<{ directory: string; value: Metadata }> {
    const directory = await this.directory(runId);
    const value = await this.read(join(directory, 'web.json'));
    if (
      value.formatVersion !== 1 ||
      value.runId !== runId ||
      !['postgresql', 'aurora-dsql'].includes(String(value.kind))
    )
      fail('state_invalid');
    const parsed = value as unknown as Metadata;
    target(parsed.target);
    if (
      ![
        'planning',
        'planned',
        'running',
        'inProgress',
        'complete',
        'blocked',
        'interrupted',
      ].includes(parsed.status)
    )
      fail('state_invalid');
    if (parsed.plan) parsed.plan = reviewPlan(parsed.plan, parsed.target);
    return { directory, value: parsed };
  }
  private async script(
    name: 'setup-execute.mjs' | 'setup-dsql.mjs',
    args: string[],
    timeoutMs = 20 * 60 * 1000,
    acceptDsqlFailureReport = false
  ): Promise<RecordValue> {
    const script = join(this.root, 'packages/ar-runtime-aws/scripts', name);
    const stat = await lstat(script).catch(() => fail('source_missing'));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('source_invalid');
    let result: AwsWebProcessResult;
    try {
      result = await this.execute({
        file: process.execPath,
        args: [script, ...args],
        cwd: this.root,
        timeoutMs,
      });
    } catch (error) {
      if (
        acceptDsqlFailureReport &&
        error instanceof AwsWebError &&
        error.code === 'aws_web_process_limit'
      )
        throw new AwsWebError('aws_dsql_probe_outcome_unknown');
      throw error;
    }
    if (result.exitCode !== 0) {
      if (acceptDsqlFailureReport && name === 'setup-dsql.mjs') {
        try {
          const failed = parseJson(result.stdout.trim());
          if (
            failed.status === 'failed' &&
            failed.database === 'aurora-dsql' &&
            failed.fullRuntimeReady === false
          )
            return failed;
        } catch {
          /* Only structured, validated probe results are retained. */
        }
      }
      throw new AwsWebError(childCode(result));
    }
    return parseJson(result.stdout.trim());
  }
  private background(
    metadata: Metadata,
    directory: string,
    job: () => Promise<void>,
    reserved = false,
    release?: () => Promise<void>
  ): void {
    if (!reserved && this.active.has(metadata.runId)) fail('operation_running');
    this.active.add(metadata.runId);
    void job()
      .catch(async (error: unknown) => {
        metadata.status = 'blocked';
        metadata.code = safeCode(error);
        await this.write(directory, metadata);
      })
      .catch(() => undefined)
      .finally(async () => {
        try {
          await release?.();
        } finally {
          this.active.delete(metadata.runId);
        }
      })
      .catch(() => undefined);
  }

  private async claim(directory: string): Promise<() => Promise<void>> {
    const path = join(directory, 'web.lock');
    const token = randomUUID();
    const file = await open(path, 'wx', 0o600).catch(() => fail('operation_lock_requires_review'));
    try {
      await file.writeFile(JSON.stringify({ token, pid: process.pid }));
      await file.sync();
    } finally {
      await file.close();
    }
    return async () => {
      const saved = await this.read(path);
      if (saved.token !== token) fail('operation_lock_changed');
      await unlink(path);
    };
  }
  private async newRun(kind: Metadata['kind'], expected: AwsWebTarget) {
    const runId = randomUUID();
    const directory = join(await this.base(), runId);
    await mkdir(directory, { mode: 0o700 });
    const metadata: Metadata = {
      formatVersion: 1,
      kind,
      target: { accountId: expected.accountId, region: expected.region },
      runId,
      status: 'planning',
      browserLoginVerified: false,
    };
    await this.write(directory, metadata);
    return { directory, metadata };
  }
  async configure(raw: unknown) {
    let input;
    try {
      input = parseAwsConfigurationInput(raw);
    } catch {
      return fail('configuration_invalid');
    }
    const directory = join(await this.base(), `config-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const inputPath = join(directory, 'input.json');
    const configPath = join(directory, 'config.json');
    const file = await open(inputPath, 'wx', 0o600);
    try {
      await file.writeFile(canonical(input));
      await file.sync();
    } finally {
      await file.close();
    }
    const result = await this.script('setup-execute.mjs', [
      'configure',
      '--input',
      inputPath,
      '--out',
      configPath,
    ]);
    const config = await this.read(configPath);
    if (result.status !== 'configured' || result.configSha256 !== digest(config))
      fail('configuration_invalid');
    return {
      status: 'configured',
      database: input.database,
      configPath,
      configSha256: result.configSha256,
    };
  }
  async check(input: AwsWebCheckInput) {
    target(input);
    if (!PROFILE.test(input.profile)) fail('profile_invalid');
    const checks: Array<{ id: string; status: string; code: string }> = [];
    const version = await this.execute({
      file: 'aws',
      args: ['--version'],
      cwd: this.root,
      timeoutMs: 20_000,
    });
    if (version.exitCode !== 0 || !/aws-cli\/2\./u.test(version.stdout + version.stderr))
      return {
        status: 'blocked',
        checks: [{ id: 'cli', status: 'fail', code: 'aws_cli_v2_required' }],
        permissionsVerified: false,
        writeAuthorization: 'not_proven',
      };
    checks.push({ id: 'cli', status: 'pass', code: 'aws_cli_v2_available' });
    const response = await this.execute({
      file: 'aws',
      args: [
        'sts',
        'get-caller-identity',
        '--profile',
        input.profile,
        '--region',
        input.region,
        '--output',
        'json',
        '--no-cli-pager',
        '--no-cli-auto-prompt',
      ],
      cwd: this.root,
      timeoutMs: 30_000,
    });
    if (response.exitCode !== 0)
      return {
        status: 'blocked',
        checks: [
          ...checks,
          { id: 'identity', status: 'fail', code: 'aws_login_or_connection_required' },
        ],
        permissionsVerified: false,
        writeAuthorization: 'not_proven',
      };
    const identity = parseJson(response.stdout);
    if (
      identity.Account !== input.accountId ||
      typeof identity.Arn !== 'string' ||
      !identity.Arn.startsWith(`arn:aws:`)
    )
      fail('account_mismatch');
    checks.push({ id: 'identity', status: 'pass', code: 'aws_account_confirmed' });
    return {
      status: 'passed',
      checks,
      permissionsVerified: false,
      writeAuthorization: 'not_proven',
    };
  }
  async plan(input: AwsWebPlanInput): Promise<AwsWebRun> {
    configInput(input);
    const { directory, metadata } = await this.newRun('postgresql', input);
    this.background(metadata, directory, async () => {
      const result = await this.script(
        'setup-execute.mjs',
        [
          'plan',
          '--config',
          input.configPath,
          '--out',
          join(directory, 'plan.json'),
          '--account-id',
          input.accountId,
          '--region',
          input.region,
        ],
        5 * 60 * 1000
      );
      const plan = await this.read(join(directory, 'plan.json'));
      const config = object(plan.config);
      const configTarget = object(config.target);
      if (
        plan.formatVersion !== 2 ||
        result.status !== 'planned' ||
        result.planSha256 !== digest(plan) ||
        config.backend !== 'aws' ||
        configTarget.accountId !== input.accountId ||
        configTarget.region !== input.region ||
        !['primary', 'secondary'].includes(String(config.role)) ||
        !['browser-rehearsal', 'existing-issuer'].includes(String(config.mode)) ||
        !Array.isArray(plan.stages) ||
        plan.stages.join() !== STAGES.join()
      )
        fail('plan_invalid');
      metadata.plan = {
        planSha256: String(result.planSha256),
        target: metadata.target,
        backend: 'aws',
        database: 'postgresql',
        role: config.role as 'primary' | 'secondary',
        mode: config.mode as 'browser-rehearsal' | 'existing-issuer',
        stages: [...STAGES],
        ...postgresScope(config, metadata.target),
      };
      metadata.status = 'planned';
      await this.write(directory, metadata);
    });
    return { runId: metadata.runId, status: 'planning', browserLoginVerified: false };
  }
  async dsqlCheck(input: AwsWebPlanInput & { profile: string }): Promise<AwsWebRun> {
    configInput(input);
    if (!PROFILE.test(input.profile)) fail('profile_invalid');
    const { directory, metadata } = await this.newRun('aurora-dsql', input);
    this.background(metadata, directory, async () => {
      const result = await this.script(
        'setup-dsql.mjs',
        [
          'check',
          '--account-id',
          input.accountId,
          '--region',
          input.region,
          '--profile',
          input.profile,
          '--config',
          input.configPath,
        ],
        2 * 60 * 1000
      );
      const actualTarget = object(result.target);
      if (
        result.status !== 'checked' ||
        result.fullRuntimeReady !== false ||
        result.database !== 'aurora-dsql' ||
        actualTarget.accountId !== input.accountId ||
        actualTarget.region !== input.region ||
        typeof actualTarget.hostname !== 'string' ||
        !/^[a-z0-9]{26}\.dsql\.[a-z0-9-]+\.on\.aws$/u.test(actualTarget.hostname) ||
        !HASH.test(String(result.configSha256)) ||
        !HASH.test(String(result.bundleSha256)) ||
        typeof result.principalArn !== 'string' ||
        !/^arn:aws:(?:iam|sts)::\d{12}:[A-Za-z0-9/+=,.@_:-]{1,256}$/u.test(result.principalArn) ||
        typeof result.principalId !== 'string' ||
        !/^[A-Za-z0-9+=,.@_:/-]{1,256}$/u.test(result.principalId)
      )
        fail('dsql_check_invalid');
      metadata.dsql = {
        ...input,
        configSha256: String(result.configSha256),
        bundleSha256: String(result.bundleSha256),
        principalArn: result.principalArn,
        principalId: result.principalId,
      };
      metadata.plan = {
        planSha256: digest(metadata.dsql),
        target: metadata.target,
        backend: 'aws',
        database: 'aurora-dsql',
        mode: 'identity-evaluation',
        stages: ['identity-probe', 'configuration-probe'],
        fullRuntimeReady: false,
        scope: 'existing-cluster-only',
        hostname: actualTarget.hostname,
        ...reviewIdentity(
          { profile: input.profile, principalArn: result.principalArn },
          metadata.target.accountId,
          true
        ),
      };
      metadata.status = 'planned';
      await this.write(directory, metadata);
    });
    return { runId: metadata.runId, status: 'planning', browserLoginVerified: false };
  }
  async start(
    runId: string,
    mode: 'apply' | 'resume' | 'verify',
    planSha256: string,
    userCount = 1001
  ): Promise<AwsWebRun> {
    if (this.active.has(runId)) fail('operation_running');
    this.active.add(runId);
    let loaded: { directory: string; value: Metadata };
    let release: (() => Promise<void>) | undefined;
    try {
      loaded = await this.metadata(runId);
      release = await this.claim(loaded.directory);
      // Another setup server may have finished between the initial read and claim.
      loaded = await this.metadata(runId);
      const { directory, value } = loaded;
      if (!HASH.test(planSha256) || value.plan?.planSha256 !== planSha256)
        fail('plan_digest_mismatch');
      if (mode === 'verify') {
        if (
          value.kind !== 'aurora-dsql' ||
          !value.dsql ||
          value.status !== 'planned' ||
          !Number.isSafeInteger(userCount) ||
          userCount < 1 ||
          userCount > 2000
        )
          fail('verification_invalid');
        value.dsqlUserCount = userCount;
      } else if (
        value.kind !== 'postgresql' ||
        (mode === 'apply'
          ? value.status !== 'planned'
          : value.status === 'planning' ||
            value.status === 'planned' ||
            value.status === 'complete')
      )
        fail('execution_mode_invalid');
      value.status = 'running';
      delete value.code;
      await this.write(directory, value);
    } catch (error) {
      try {
        await release?.();
      } finally {
        this.active.delete(runId);
      }
      throw error;
    }
    const { directory, value } = loaded;
    this.background(
      value,
      directory,
      async () => {
        if (mode === 'verify') {
          const pin = value.dsql;
          if (!pin) fail('verification_invalid');
          if (digest(pin) !== planSha256) fail('plan_digest_mismatch');
          const result = await this.script(
            'setup-dsql.mjs',
            [
              'verify',
              '--account-id',
              pin.accountId,
              '--region',
              pin.region,
              '--profile',
              pin.profile,
              '--config',
              pin.configPath,
              '--config-sha256',
              pin.configSha256,
              '--bundle-sha256',
              pin.bundleSha256,
              '--principal-arn',
              pin.principalArn,
              '--principal-id',
              pin.principalId,
              '--write-probe',
              '--users',
              String(userCount),
            ],
            95 * 60 * 1000,
            true
          );
          const report = dsqlReport(result.report, 'identity', userCount);
          const configurationReport =
            result.configurationReport === undefined
              ? undefined
              : dsqlReport(result.configurationReport, 'configuration', userCount);
          value.result = { ...report, ...(configurationReport ? { configurationReport } : {}) };
          if (
            result.status !== 'verified' ||
            result.database !== 'aurora-dsql' ||
            result.fullRuntimeReady !== false ||
            report.passed !== true ||
            report.cleanup !== 'complete' ||
            configurationReport?.passed !== true ||
            configurationReport.cleanup !== 'complete'
          )
            fail('dsql_verification_failed');
          value.status = 'complete';
          await this.write(directory, value);
          return;
        }
        const began = Date.now();
        let action: 'apply' | 'resume' = mode;
        for (;;) {
          const result = await this.script('setup-execute.mjs', [
            action,
            '--plan',
            join(directory, 'plan.json'),
            '--plan-sha256',
            planSha256,
            '--state',
            join(directory, 'state.json'),
          ]);
          if (result.status === 'complete') {
            value.status = 'complete';
            if (typeof result.origin === 'string' && /^https:\/\/[a-z0-9.-]+$/u.test(result.origin))
              value.origin = result.origin;
            if (value.origin && result.testSpUrl === `${value.origin}/test-sp/start`)
              value.testSpUrl = result.testSpUrl;
            await this.write(directory, value);
            return;
          }
          if (result.status !== 'inProgress') fail('execution_response_invalid');
          if (Date.now() - began >= this.observationMs) {
            value.status = 'inProgress';
            await this.write(directory, value);
            return;
          }
          action = 'resume';
          await this.sleep(3000);
        }
      },
      true,
      release
    );
    return { runId, status: 'running', browserLoginVerified: false };
  }
  async status(runId: string): Promise<AwsWebRun> {
    const { directory, value } = await this.metadata(runId);
    const status =
      !this.active.has(runId) && ['planning', 'running'].includes(value.status)
        ? 'interrupted'
        : value.status;
    const result: AwsWebRun = {
      runId,
      status,
      browserLoginVerified: false,
      ...(value.plan ? { plan: value.plan } : {}),
      ...(value.code && /^aws_(?:web|setup|dsql)_[a-z_]{1,100}$/u.test(value.code)
        ? { code: value.code }
        : {}),
      ...(value.result
        ? {
            result: {
              ...dsqlReport(value.result, 'identity', value.dsqlUserCount ?? 1001),
              ...(value.result.configurationReport
                ? {
                    configurationReport: dsqlReport(
                      value.result.configurationReport,
                      'configuration',
                      value.dsqlUserCount ?? 1001
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(typeof value.origin === 'string' && /^https:\/\/[a-z0-9.-]+$/u.test(value.origin)
        ? { origin: value.origin }
        : {}),
    };
    if (result.origin && value.testSpUrl === `${result.origin}/test-sp/start`)
      result.testSpUrl = value.testSpUrl;
    if (value.kind === 'postgresql' && value.plan) {
      try {
        const state = await this.read(join(directory, 'state.json'));
        if (
          state.planSha256 !== value.plan.planSha256 ||
          canonical(state.target) !== canonical(value.target)
        )
          fail('state_plan_mismatch');
        if (typeof state.currentStage === 'string' && STAGES.includes(state.currentStage))
          result.currentStage = state.currentStage;
        result.stages = Object.fromEntries(
          Object.entries(object(state.stages))
            .filter(
              ([key, item]) =>
                STAGES.includes(key) && STAGE_STATUSES.has(String(object(item).status))
            )
            .map(([key, item]) => [key, String(object(item).status)])
        );
      } catch (error) {
        if (!(error instanceof AwsWebError) || error.code !== 'aws_web_file_unavailable')
          throw error;
      }
    }
    return result;
  }
}
