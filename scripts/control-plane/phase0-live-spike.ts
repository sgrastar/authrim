#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import {
  buildPreservingWorkerSettingsPatch,
  CloudflareControlApiClient,
  CloudflareControlApiError,
  redactControlPlaneEvidence,
  verifyWorkerSettingsPreserved,
  type CloudflareControlTokens,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerBinding,
  type CloudflareWorkerSettings,
} from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import { getAccountId, getCloudflareApiToken } from '../../packages/setup/src/core/cloudflare.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SAFE_ENVIRONMENT = 'test';
const RESOURCE_PREFIX = 'authrim-cp-spike-test';
const DEFAULT_OUTPUT_DIR = resolve(
  REPO_ROOT,
  'private/docs/implementation/unified-control-plane/spike'
);
const SMOKE_ATTEMPTS = 24;
const SMOKE_RETRY_MS = 2_500;

export interface Phase0SpikeOptions {
  env: 'test';
  execute: boolean;
  outputDir: string;
  accountId?: string;
  credentialMode: 'split-token' | 'operator-oauth';
}

interface SpikeNames {
  suffix: string;
  calleeWorker: string;
  tailWorker: string;
  targetWorker: string;
  callerWorker: string;
  baselineDatabase: string;
  appendedDatabase: string;
  kvNamespace: string;
  r2Bucket: string;
}

interface CreatedResources {
  workers: Set<string>;
  databases: Array<{ id: string; name: string }>;
  kvNamespaces: Array<{ id: string; title: string }>;
  r2Buckets: string[];
}

interface SmokeResult {
  ok: boolean;
  rpc: boolean;
  jws: boolean;
  marker: boolean;
  secret: boolean;
  service: boolean;
  durableObject: boolean;
  baselineD1: boolean;
  appendedD1: boolean;
  kv: boolean | null;
  r2: boolean | null;
  workerLoader: boolean | null;
}

interface Evidence {
  schemaVersion: 1;
  startedAt: string;
  finishedAt?: string;
  targetEnvironment: 'test';
  resourcePrefix: string;
  mode: 'dry-run' | 'execute';
  executorMode: 'split-token' | 'operator-oauth';
  steps: Array<Record<string, unknown>>;
  observations: Record<string, unknown>;
  cleanup: Array<Record<string, unknown>>;
  conclusion: Record<string, unknown>;
  errorCode?: string;
}

function requiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

function safeOutputDirectory(value: string): string {
  const output = resolve(value);
  if (output === '/' || output === resolve(tmpdir())) {
    throw new Error('unsafe_output_directory');
  }
  return output;
}

export function parsePhase0SpikeArgs(argv: string[]): Phase0SpikeOptions {
  let env: string | undefined;
  let execute = false;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let accountId: string | undefined;
  let credentialMode: Phase0SpikeOptions['credentialMode'] = 'split-token';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') {
      env = argv[++index];
    } else if (argument === '--execute') {
      execute = true;
    } else if (argument === '--output-dir') {
      outputDir = requiredValue(argv[++index], 'output_dir');
    } else if (argument === '--account-id') {
      accountId = requiredValue(argv[++index], 'account_id');
    } else if (argument === '--operator-oauth') {
      credentialMode = 'operator-oauth';
    } else if (argument === '--help' || argument === '-h') {
      throw new Error('help_requested');
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }
  if (env !== SAFE_ENVIRONMENT) throw new Error('phase0_spike_test_environment_required');
  if (accountId !== undefined && !/^[a-f0-9]{32}$/u.test(accountId)) {
    throw new Error('invalid_cloudflare_account_id');
  }
  return {
    env: 'test',
    execute,
    outputDir: safeOutputDirectory(outputDir),
    accountId,
    credentialMode,
  };
}

export function buildPhase0SpikeNames(now = new Date(), nonce = randomUUID()): SpikeNames {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/gu, '')
    .slice(0, 14)
    .toLowerCase();
  const random = nonce
    .replace(/[^a-z0-9]/giu, '')
    .slice(0, 6)
    .toLowerCase();
  const suffix = `${timestamp}-${random}`;
  const base = `${RESOURCE_PREFIX}-${suffix}`;
  return {
    suffix,
    calleeWorker: `${base}-callee`,
    tailWorker: `${base}-tail`,
    targetWorker: `${base}-target`,
    callerWorker: `${base}-caller`,
    baselineDatabase: `${base}-baseline-db`,
    appendedDatabase: `${base}-appended-db`,
    kvNamespace: `${base}-kv`,
    r2Bucket: `${base}-r2`,
  };
}

export function loadPhase0SpikeTokens(environment: NodeJS.ProcessEnv): CloudflareControlTokens {
  const d1 = requiredValue(environment.CLOUDFLARE_D1_API_TOKEN, 'cloudflare_d1_api_token');
  const workers = requiredValue(
    environment.CLOUDFLARE_WORKERS_API_TOKEN,
    'cloudflare_workers_api_token'
  );
  if (d1 === workers) throw new Error('phase0_spike_split_d1_workers_tokens_required');
  return {
    d1,
    workers,
    kv: environment.CLOUDFLARE_KV_API_TOKEN,
    r2: environment.CLOUDFLARE_R2_API_TOKEN,
  };
}

export function buildPhase0OperatorTokens(oauthToken: string): CloudflareControlTokens {
  const token = requiredValue(oauthToken, 'wrangler_oauth_token');
  return { d1: token, workers: token, kv: token, r2: token };
}

async function loadPhase0SpikeCredentials(
  options: Phase0SpikeOptions,
  environment: NodeJS.ProcessEnv
): Promise<{ accountId: string; tokens: CloudflareControlTokens }> {
  if (options.credentialMode === 'split-token') {
    const accountId = requiredValue(
      options.accountId ?? environment.CLOUDFLARE_ACCOUNT_ID,
      'cloudflare_account_id'
    );
    return { accountId, tokens: loadPhase0SpikeTokens(environment) };
  }

  const [accountId, credential] = await Promise.all([getAccountId(), getCloudflareApiToken()]);
  const resolvedAccountId = requiredValue(accountId ?? undefined, 'cloudflare_account_id');
  if (options.accountId && options.accountId !== resolvedAccountId) {
    throw new Error('phase0_spike_operator_account_mismatch');
  }
  if (!credential?.token || credential.source !== 'oauth') {
    throw new Error('phase0_spike_wrangler_oauth_required');
  }
  return {
    accountId: resolvedAccountId,
    tokens: buildPhase0OperatorTokens(credential.token),
  };
}

export function buildPhase0TargetSource(): string {
  return `
import { WorkerEntrypoint } from 'cloudflare:workers';

export class SpikeDurableObject {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() { return Response.json({ ok: true }); }
}

const encoder = new TextEncoder();

function base64url(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}

async function bindingSmoke(env) {
  const service = await env.SPIKE_SERVICE.fetch('https://service.internal/');
  const durable = await env.SPIKE_DO.get(env.SPIKE_DO.idFromName('phase0')).fetch('https://do.internal/');
  const baseline = await env.SPIKE_BASELINE_DB.prepare("SELECT value FROM spike_state WHERE key = 'migration'").first();
  const appended = env.SPIKE_APPENDED_DB
    ? await env.SPIKE_APPENDED_DB.prepare("SELECT value FROM spike_state WHERE key = 'migration'").first()
    : null;
  const kv = env.SPIKE_KV ? (await env.SPIKE_KV.get('missing')) === null : null;
  const r2 = env.SPIKE_R2 ? (await env.SPIKE_R2.head('missing')) === null : null;
  return {
    ok: true,
    marker: env.SPIKE_MARKER === 'initial',
    secret: typeof env.SPIKE_SECRET === 'string' && env.SPIKE_SECRET.length > 0,
    service: service.ok && (await service.json()).ok === true,
    durableObject: durable.ok && (await durable.json()).ok === true,
    baselineD1: baseline?.value === 'applied',
    appendedD1: appended?.value === 'applied',
    kv,
    r2,
    workerLoader: env.SPIKE_LOADER ? true : null,
  };
}

async function jwsSmoke() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({
    alg: 'EdDSA',
    typ: 'authrim-phase0-smoke+jws',
    kid: 'phase0-ephemeral',
  }));
  const claims = {
    iss: 'urn:authrim:control:phase0-test',
    aud: 'urn:authrim:runtime:phase0-test',
    iat: now,
    exp: now + 30,
    jti: crypto.randomUUID(),
  };
  const payload = base64url(JSON.stringify(claims));
  const signingInput = encoder.encode(header + '.' + payload);
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, signingInput);
  const compact = header + '.' + payload + '.' + base64url(signature);
  const verified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    keyPair.publicKey,
    signature,
    signingInput
  );
  return verified && compact.split('.').length === 3 && claims.exp - claims.iat === 30 &&
    claims.aud === 'urn:authrim:runtime:phase0-test';
}

export class Phase0ControlRpc extends WorkerEntrypoint {
  async phase0Smoke() {
    return { ...(await bindingSmoke(this.env)), rpc: true, jws: await jwsSmoke() };
  }
}

export default {
  async fetch(_request, env) {
    return Response.json({ ...(await bindingSmoke(env)), rpc: false, jws: false });
  }
};
`;
}

function serviceSource(): string {
  return `export default { fetch() { return Response.json({ ok: true }); } };\n`;
}

function tailSource(): string {
  return `export default { tail() {} };\n`;
}

export function buildPhase0CallerSource(): string {
  return `export default {
  async fetch(_request, env) {
    return Response.json(await env.TARGET.phase0Smoke());
  },
};\n`;
}

function baseConfig(name: string, accountId: string, main: string, workersDev: boolean) {
  return {
    $schema: resolve(REPO_ROOT, 'node_modules/wrangler/config-schema.json'),
    name,
    account_id: accountId,
    main,
    compatibility_date: '2026-07-29',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: workersDev,
    observability: { enabled: true, head_sampling_rate: 0.25 },
  };
}

async function writeFixture(
  directory: string,
  names: SpikeNames,
  accountId: string,
  resources: {
    baselineDatabaseId: string;
    kvNamespaceId?: string;
    r2BucketName?: string;
    workerLoaderEnabled: boolean;
  }
): Promise<Record<'callee' | 'tail' | 'target' | 'caller', string>> {
  const sourcePaths = {
    callee: resolve(directory, 'callee.ts'),
    tail: resolve(directory, 'tail.ts'),
    target: resolve(directory, 'target.ts'),
    caller: resolve(directory, 'caller.ts'),
  };
  await Promise.all([
    writeFile(sourcePaths.callee, serviceSource(), { mode: 0o600 }),
    writeFile(sourcePaths.tail, tailSource(), { mode: 0o600 }),
    writeFile(sourcePaths.target, buildPhase0TargetSource(), { mode: 0o600 }),
    writeFile(sourcePaths.caller, buildPhase0CallerSource(), { mode: 0o600 }),
  ]);
  const configs = {
    callee: { ...baseConfig(names.calleeWorker, accountId, sourcePaths.callee, false) },
    tail: { ...baseConfig(names.tailWorker, accountId, sourcePaths.tail, false) },
    target: {
      ...baseConfig(names.targetWorker, accountId, sourcePaths.target, false),
      vars: { SPIKE_MARKER: 'initial' },
      d1_databases: [
        {
          binding: 'SPIKE_BASELINE_DB',
          database_name: names.baselineDatabase,
          database_id: resources.baselineDatabaseId,
        },
      ],
      services: [{ binding: 'SPIKE_SERVICE', service: names.calleeWorker }],
      durable_objects: {
        bindings: [{ name: 'SPIKE_DO', class_name: 'SpikeDurableObject' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['SpikeDurableObject'] }],
      tail_consumers: [{ service: names.tailWorker }],
      placement: { mode: 'smart' },
      ...(resources.kvNamespaceId
        ? { kv_namespaces: [{ binding: 'SPIKE_KV', id: resources.kvNamespaceId }] }
        : {}),
      ...(resources.r2BucketName
        ? { r2_buckets: [{ binding: 'SPIKE_R2', bucket_name: resources.r2BucketName }] }
        : {}),
      ...(resources.workerLoaderEnabled ? { worker_loaders: [{ binding: 'SPIKE_LOADER' }] } : {}),
    },
    caller: {
      ...baseConfig(names.callerWorker, accountId, sourcePaths.caller, true),
      services: [
        { binding: 'TARGET', service: names.targetWorker, entrypoint: 'Phase0ControlRpc' },
      ],
    },
  };
  const paths = {} as Record<keyof typeof configs, string>;
  for (const [key, config] of Object.entries(configs)) {
    const path = resolve(directory, `${key}.wrangler.json`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    paths[key as keyof typeof configs] = path;
  }
  return paths;
}

async function deployFixture(configPath: string): Promise<string | undefined> {
  const result = await execa('pnpm', ['exec', 'wrangler', 'deploy', '--config', configPath], {
    cwd: REPO_ROOT,
    env: { WRANGLER_LOG: 'warn' },
    reject: true,
  });
  return extractWorkersDevUrl(`${result.stdout}\n${result.stderr}`);
}

export function extractWorkersDevUrl(output: string): string | undefined {
  return output
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .match(/https:\/\/[a-z0-9.-]+\.workers\.dev/iu)?.[0];
}

export function buildWorkersDevUrl(scriptName: string, subdomain: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(scriptName)) {
    throw new Error('invalid_workers_dev_script_name');
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
    throw new Error('invalid_workers_dev_subdomain');
  }
  return `https://${scriptName}.${subdomain}.workers.dev`;
}

async function setSecret(configPath: string, value: string): Promise<void> {
  await execa(
    'pnpm',
    ['exec', 'wrangler', 'secret', 'put', 'SPIKE_SECRET', '--config', configPath],
    {
      cwd: REPO_ROOT,
      env: { WRANGLER_LOG: 'warn' },
      input: value,
      reject: true,
    }
  );
}

async function smoke(url: string): Promise<SmokeResult> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`phase0_smoke_http_${response.status}`);
  const result = (await response.json()) as SmokeResult;
  if (!result || result.ok !== true) throw new Error('phase0_smoke_invalid_response');
  return result;
}

function smokeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'phase0_smoke_unknown_error';
  if (/^phase0_[a-z0-9_]+$/u.test(error.message)) return error.message;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'phase0_smoke_timeout';
  if (error instanceof TypeError) {
    const cause = error.cause as { code?: unknown } | undefined;
    const causeCode = typeof cause?.code === 'string' ? cause.code.toLowerCase() : undefined;
    return causeCode && /^[a-z0-9_]+$/u.test(causeCode)
      ? `phase0_smoke_network_error:${causeCode}`
      : 'phase0_smoke_network_error';
  }
  return 'phase0_smoke_unexpected_error';
}

async function waitForExpectedSmoke(
  url: string,
  expected: {
    appendedD1: boolean;
    kv: boolean;
    r2: boolean;
    workerLoader: boolean;
  },
  failureCode: string
): Promise<SmokeResult> {
  let last: SmokeResult | undefined;
  let lastFailure = 'phase0_smoke_not_attempted';
  for (let attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt += 1) {
    try {
      last = await smoke(url);
      assertPhase0SmokeResult(last, expected);
      return last;
    } catch (error) {
      lastFailure = smokeFailureCode(error);
      // Edge deployment propagation is expected to be temporarily inconsistent.
    }
    if (attempt < SMOKE_ATTEMPTS) {
      await new Promise((resolveWait) => setTimeout(resolveWait, SMOKE_RETRY_MS));
    }
  }
  throw new Error(`${failureCode}:${last?.appendedD1 ?? 'unavailable'}:${lastFailure}`);
}

export function assertPhase0SmokeResult(
  result: SmokeResult,
  expected: {
    appendedD1: boolean;
    kv: boolean;
    r2: boolean;
    workerLoader: boolean;
  }
): void {
  const required = [
    result.ok,
    result.rpc,
    result.jws,
    result.marker,
    result.secret,
    result.service,
    result.durableObject,
    result.baselineD1,
    result.appendedD1 === expected.appendedD1,
    result.kv === (expected.kv ? true : null),
    result.r2 === (expected.r2 ? true : null),
    result.workerLoader === (expected.workerLoader ? true : null),
  ];
  if (required.some((value) => value !== true)) {
    throw new Error('phase0_runtime_smoke_invariant_failed');
  }
}

function activeVersionId(
  deployments: Awaited<ReturnType<CloudflareControlApiClient['listWorkerDeployments']>>
): string {
  const deployment = [...deployments].sort(
    (left, right) => Date.parse(right.created_on) - Date.parse(left.created_on)
  )[0];
  const active = deployment?.versions.find((version) => version.percentage === 100);
  return requiredValue(active?.version_id, 'active_worker_version_id');
}

function deploymentsNewestFirst(
  deployments: readonly CloudflareWorkerDeployment[]
): CloudflareWorkerDeployment[] {
  return [...deployments].sort(
    (left, right) => Date.parse(right.created_on) - Date.parse(left.created_on)
  );
}

export function assertPhase0ResponseLossAdoption(input: {
  deploymentsBefore: readonly CloudflareWorkerDeployment[];
  deploymentsAfter: readonly CloudflareWorkerDeployment[];
  sourceVersionId: string;
  beforeSettings: CloudflareWorkerSettings;
  reflectedSettings: CloudflareWorkerSettings;
  desiredBinding: CloudflareWorkerBinding;
}): { deploymentId: string; versionId: string } {
  const beforeIds = new Set(input.deploymentsBefore.map((deployment) => deployment.id));
  const after = deploymentsNewestFirst(input.deploymentsAfter);
  const active = after[0];
  const activeVersion = active?.versions.find((version) => version.percentage === 100);
  const sourceDeployment = after[1];
  const newDeployments = after.filter((deployment) => !beforeIds.has(deployment.id));
  if (
    !active ||
    !activeVersion?.version_id ||
    activeVersion.version_id === input.sourceVersionId ||
    newDeployments.length !== 1 ||
    newDeployments[0]?.id !== active.id ||
    sourceDeployment?.id !== deploymentsNewestFirst(input.deploymentsBefore)[0]?.id ||
    active.versions.length !== 1
  ) {
    throw new Error('phase0_response_loss_adoption_deployment_mismatch');
  }
  const issues = verifyWorkerSettingsPreserved({
    before: input.beforeSettings,
    after: input.reflectedSettings,
    desiredBindings: [input.desiredBinding],
  });
  if (issues.length > 0) {
    throw new Error('phase0_response_loss_adoption_settings_mismatch');
  }
  return { deploymentId: active.id, versionId: activeVersion.version_id };
}

export function assertPhase0RollbackReflected(input: {
  deploymentsBeforeRollback: readonly CloudflareWorkerDeployment[];
  deploymentsAfterRollback: readonly CloudflareWorkerDeployment[];
  sourceVersionId: string;
  mode: 'settings-patch';
  beforeSettings: CloudflareWorkerSettings;
  reflectedSettings: CloudflareWorkerSettings;
}): { deploymentId: string; versionId: string } {
  const beforeIds = new Set(input.deploymentsBeforeRollback.map((deployment) => deployment.id));
  const after = deploymentsNewestFirst(input.deploymentsAfterRollback);
  const active = after[0];
  const activeVersion = active?.versions.find((version) => version.percentage === 100);
  const newDeployments = after.filter((deployment) => !beforeIds.has(deployment.id));
  if (
    !active ||
    active.versions.length !== 1 ||
    !activeVersion?.version_id ||
    activeVersion.version_id === input.sourceVersionId ||
    newDeployments.length !== 1 ||
    newDeployments[0]?.id !== active.id
  ) {
    throw new Error('phase0_rollback_deployment_mismatch');
  }
  const issues = verifyWorkerSettingsPreserved({
    before: input.beforeSettings,
    after: input.reflectedSettings,
    desiredBindings: [],
  });
  if (issues.length > 0) {
    throw new Error('phase0_rollback_settings_mismatch');
  }
  return { deploymentId: active.id, versionId: activeVersion.version_id };
}

function bindingSummary(settings: CloudflareWorkerSettings): Array<{ name: string; type: string }> {
  return (settings.bindings ?? []).map((binding) => ({ name: binding.name, type: binding.type }));
}

function errorCode(error: unknown): string {
  if (error instanceof CloudflareControlApiError) {
    const codes = error.providerCodes.length > 0 ? `:${error.providerCodes.join('.')}` : '';
    return `cloudflare_api_error:${error.operation}:${error.status}${codes}`;
  }
  if (!(error instanceof Error)) return 'unknown_error';
  if (/^[a-zA-Z0-9_.:-]{1,200}$/u.test(error.message)) return error.message;
  return 'phase0_unexpected_error';
}

function safeSubprocessDiagnostic(error: unknown): string {
  if (!error || typeof error !== 'object') return 'subprocess_failed_without_diagnostic';
  const record = error as Record<string, unknown>;
  const values = [
    error instanceof Error ? error.message : undefined,
    record.shortMessage,
    record.stderr,
    record.stdout,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  if (!values) return 'subprocess_failed_without_diagnostic';
  return values
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/[a-f0-9]{32}/gu, '<account>')
    .replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
    .replaceAll(REPO_ROOT, '<repo>')
    .replace(/\/Users\/[^\s:]+/gu, '<home>')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12)
    .join(' | ')
    .slice(0, 1_500);
}

async function cleanupResources(
  client: CloudflareControlApiClient,
  resources: CreatedResources,
  evidence: Evidence
): Promise<void> {
  const cleanup = async (kind: string, name: string, operation: () => Promise<void>) => {
    try {
      await operation();
      evidence.cleanup.push({ kind, name, status: 'deleted' });
    } catch (error) {
      evidence.cleanup.push({ kind, name, status: 'delete_failed', errorCode: errorCode(error) });
    }
  };
  for (const worker of [...resources.workers].reverse()) {
    await cleanup('worker', worker, () => client.deleteWorkerScript(worker));
  }
  for (const database of resources.databases.reverse()) {
    await cleanup('d1', database.name, () => client.deleteD1Database(database.id));
  }
  for (const namespace of resources.kvNamespaces.reverse()) {
    await cleanup('kv_namespace', namespace.title, () => client.deleteKvNamespace(namespace.id));
  }
  for (const bucket of resources.r2Buckets.reverse()) {
    await cleanup('r2_bucket', bucket, () => client.deleteR2Bucket(bucket));
  }
}

async function writeEvidence(options: Phase0SpikeOptions, names: SpikeNames, evidence: Evidence) {
  await mkdir(options.outputDir, { recursive: true });
  const path = resolve(options.outputDir, `phase0-live-api-matrix-${names.suffix}.json`);
  const redacted = redactControlPlaneEvidence(evidence);
  await writeFile(path, `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function runPhase0Spike(
  options: Phase0SpikeOptions,
  environment: NodeJS.ProcessEnv = process.env
): Promise<{ evidencePath: string; evidence: Evidence }> {
  const names = buildPhase0SpikeNames();
  const evidence: Evidence = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetEnvironment: 'test',
    resourcePrefix: RESOURCE_PREFIX,
    mode: options.execute ? 'execute' : 'dry-run',
    executorMode: options.credentialMode,
    steps: [],
    observations: {},
    cleanup: [],
    conclusion: {},
  };
  if (!options.execute) {
    evidence.steps.push({ step: 'dry_run', resourceNames: names });
    evidence.conclusion = { executed: false, cleanupRequired: false };
    evidence.finishedAt = new Date().toISOString();
    return { evidencePath: await writeEvidence(options, names, evidence), evidence };
  }

  const credentials = await loadPhase0SpikeCredentials(options, environment);
  const accountId = credentials.accountId;
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error('invalid_cloudflare_account_id');
  const tokens = credentials.tokens;
  const client = new CloudflareControlApiClient({ accountId, tokens });
  const created: CreatedResources = {
    workers: new Set(),
    databases: [],
    kvNamespaces: [],
    r2Buckets: [],
  };
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'authrim-phase0-spike-'));
  let failed: unknown;
  try {
    const baseline = await client.createD1Database({ name: names.baselineDatabase });
    created.databases.push({ id: baseline.uuid, name: names.baselineDatabase });
    await client.queryD1(
      baseline.uuid,
      "CREATE TABLE spike_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO spike_state VALUES ('migration', 'applied');"
    );
    const raw = await client.rawD1(
      baseline.uuid,
      "SELECT value FROM spike_state WHERE key = 'migration'"
    );
    evidence.steps.push({ step: 'baseline_d1_ready', query: true, raw: raw.length > 0 });

    let kvNamespaceId: string | undefined;
    if (tokens.kv) {
      const kv = await client.createKvNamespace(names.kvNamespace);
      kvNamespaceId = kv.id;
      created.kvNamespaces.push({ id: kv.id, title: names.kvNamespace });
    } else {
      await client.createKvNamespace(names.kvNamespace).catch((error) => {
        evidence.observations.kvCapabilityFailClosed = errorCode(error);
      });
    }

    let r2BucketName: string | undefined;
    if (tokens.r2) {
      const r2 = await client.createR2Bucket(names.r2Bucket);
      r2BucketName = r2.name;
      created.r2Buckets.push(r2.name);
    } else {
      await client.createR2Bucket(names.r2Bucket).catch((error) => {
        evidence.observations.r2CapabilityFailClosed = errorCode(error);
      });
    }

    const workerLoaderEnabled = environment.AUTHRIM_PHASE0_WORKER_LOADER === 'true';

    const fixture = await writeFixture(fixtureDirectory, names, accountId, {
      baselineDatabaseId: baseline.uuid,
      kvNamespaceId,
      r2BucketName,
      workerLoaderEnabled,
    });
    for (const component of ['callee', 'tail', 'target'] as const) {
      created.workers.add(names[`${component}Worker`]);
      try {
        await deployFixture(fixture[component]);
      } catch (error) {
        evidence.observations.failureDiagnostic = safeSubprocessDiagnostic(error);
        throw new Error(`phase0_${component}_worker_deploy_failed`);
      }
      evidence.steps.push({ step: 'worker_deployed', component });
    }
    try {
      await setSecret(fixture.target, randomBytes(32).toString('base64url'));
    } catch (error) {
      evidence.observations.failureDiagnostic = safeSubprocessDiagnostic(error);
      throw new Error('phase0_target_secret_registration_failed');
    }
    evidence.steps.push({ step: 'target_secret_registered' });
    created.workers.add(names.callerWorker);
    let callerUrl: string;
    try {
      const deployedUrl = await deployFixture(fixture.caller);
      if (deployedUrl) {
        callerUrl = deployedUrl;
      } else {
        const [accountSubdomain, scriptSubdomain] = await Promise.all([
          client.getWorkersSubdomain(),
          client.getWorkerSubdomain(names.callerWorker),
        ]);
        if (!scriptSubdomain.enabled) throw new Error('caller_worker_subdomain_disabled');
        callerUrl = buildWorkersDevUrl(names.callerWorker, accountSubdomain.subdomain);
      }
    } catch (error) {
      evidence.observations.failureDiagnostic = safeSubprocessDiagnostic(error);
      throw new Error('phase0_caller_worker_deploy_failed');
    }
    evidence.steps.push({ step: 'worker_deployed', component: 'caller' });
    const optionalExpectations = {
      kv: kvNamespaceId !== undefined,
      r2: r2BucketName !== undefined,
      workerLoader: workerLoaderEnabled,
    };
    const beforeSmoke = await waitForExpectedSmoke(
      callerUrl,
      { appendedD1: false, ...optionalExpectations },
      'phase0_baseline_smoke_failed'
    );
    evidence.steps.push({ step: 'baseline_smoke_complete' });

    const beforeSettings = await client.getWorkerSettings(names.targetWorker);
    const deploymentsBefore = await client.listWorkerDeployments(names.targetWorker);
    const sourceVersionId = activeVersionId(deploymentsBefore);
    evidence.steps.push({ step: 'settings_preflight_complete', sourceVersionId });
    const appended = await client.createD1Database({ name: names.appendedDatabase });
    created.databases.push({ id: appended.uuid, name: names.appendedDatabase });
    await client.queryD1(
      appended.uuid,
      "CREATE TABLE spike_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO spike_state VALUES ('migration', 'applied');"
    );
    evidence.steps.push({ step: 'appended_d1_ready' });
    const desiredBinding = { name: 'SPIKE_APPENDED_DB', type: 'd1', id: appended.uuid };
    const restorePatch = buildPreservingWorkerSettingsPatch({
      currentSettings: beforeSettings,
      sourceVersionId,
      desiredBindings: [],
    });
    const patch = buildPreservingWorkerSettingsPatch({
      currentSettings: beforeSettings,
      sourceVersionId,
      desiredBindings: [desiredBinding],
    });
    try {
      // The live response is intentionally discarded. Recovery must rely only on reflected provider
      // state, matching the Control state machine after a committed PATCH loses its response.
      await client.patchWorkerSettings(names.targetWorker, patch);
    } catch (error) {
      evidence.observations.failureDiagnostic = safeSubprocessDiagnostic(error);
      throw new Error(`phase0_settings_patch_failed:${errorCode(error)}`);
    }
    evidence.steps.push({
      step: 'settings_patch_accepted',
      inheritanceSource: 'latest-alias-with-immutable-deployment-fence',
    });
    const afterSmoke = await waitForExpectedSmoke(
      callerUrl,
      { appendedD1: true, ...optionalExpectations },
      'phase0_appended_database_smoke_failed'
    );
    const afterSettings = await client.getWorkerSettings(names.targetWorker);
    const deploymentsAfter = await client.listWorkerDeployments(names.targetWorker);
    const adoptedPatch = assertPhase0ResponseLossAdoption({
      deploymentsBefore,
      deploymentsAfter,
      sourceVersionId,
      beforeSettings,
      reflectedSettings: afterSettings,
      desiredBinding,
    });
    const preservationIssues = verifyWorkerSettingsPreserved({
      before: beforeSettings,
      after: afterSettings,
      desiredBindings: [desiredBinding],
    });
    const deploymentIdsBefore = new Set(deploymentsBefore.map((deployment) => deployment.id));
    const newDeployments = deploymentsAfter.filter(
      (deployment) => !deploymentIdsBefore.has(deployment.id)
    );
    const activeVersionAfter = activeVersionId(deploymentsAfter);
    const patchDeploymentIsActive =
      newDeployments.length === 1 &&
      newDeployments[0]?.versions.some(
        (version) => version.percentage === 100 && version.version_id === activeVersionAfter
      ) === true;
    evidence.steps.push({ step: 'settings_patch_complete', sourceVersionId });
    evidence.observations = {
      ...evidence.observations,
      optionalBindings: {
        kv: kvNamespaceId !== undefined,
        r2: r2BucketName !== undefined,
        workerLoader: workerLoaderEnabled,
      },
      beforeBindings: bindingSummary(beforeSettings),
      afterBindings: bindingSummary(afterSettings),
      preservedSettingsFields: Object.keys(beforeSettings).filter((key) => key !== 'bindings'),
      preservationIssues,
      beforeSmoke,
      afterSmoke,
      deploymentCountBefore: deploymentsBefore.length,
      deploymentCountAfter: deploymentsAfter.length,
      settingsPatchCreatedExactlyOneActiveDeployment: patchDeploymentIsActive,
    };
    if (preservationIssues.length > 0) {
      throw new Error('phase0_settings_preservation_failed');
    }
    if (!patchDeploymentIsActive) {
      throw new Error('phase0_concurrent_deployment_detected');
    }
    evidence.steps.push({
      step: 'settings_patch_response_loss_adopted',
      deploymentId: adoptedPatch.deploymentId,
      versionId: adoptedPatch.versionId,
    });

    await client.patchWorkerSettings(names.targetWorker, restorePatch);
    const rollbackSmoke = await waitForExpectedSmoke(
      callerUrl,
      { appendedD1: false, ...optionalExpectations },
      'phase0_rollback_smoke_failed'
    );
    const rollbackSettings = await client.getWorkerSettings(names.targetWorker);
    const deploymentsAfterRollback = await client.listWorkerDeployments(names.targetWorker);
    evidence.observations.rollback = {
      mode: 'settings-patch',
      finalActiveVersionId: activeVersionId(deploymentsAfterRollback),
      bindingSummary: bindingSummary(rollbackSettings),
      finalPreservationIssues: verifyWorkerSettingsPreserved({
        before: beforeSettings,
        after: rollbackSettings,
        desiredBindings: [],
      }),
      settingsFields: Object.keys(rollbackSettings).filter((key) => key !== 'bindings'),
    };
    const reflectedRollback = assertPhase0RollbackReflected({
      deploymentsBeforeRollback: deploymentsAfter,
      deploymentsAfterRollback,
      sourceVersionId,
      mode: 'settings-patch',
      beforeSettings,
      reflectedSettings: rollbackSettings,
    });
    evidence.steps.push({
      step: 'saved_worker_settings_rollback_complete',
      deploymentId: reflectedRollback.deploymentId,
      versionId: reflectedRollback.versionId,
    });
    evidence.conclusion = {
      executed: true,
      targetWorkerPublic: false,
      serviceBindingSmoke: beforeSmoke.service && afterSmoke.service,
      serviceBindingRpcSmoke: beforeSmoke.rpc && afterSmoke.rpc,
      ed25519JwsRuntimeSmoke: beforeSmoke.jws && afterSmoke.jws,
      deploymentFencedLatestBindingsPreserved: true,
      appendedD1Reachable: afterSmoke.appendedD1,
      settingsPatchImmediatelyActive: afterSmoke.appendedD1,
      responseLossAdoptionProven: true,
      rollbackMode: 'settings-patch',
      rollbackProven: rollbackSmoke.appendedD1 === false,
      leastPrivilegeSeparationProven: options.credentialMode === 'split-token',
      completeOptionalMatrix:
        kvNamespaceId !== undefined && r2BucketName !== undefined && workerLoaderEnabled,
    };
  } catch (error) {
    failed = error;
    evidence.errorCode = errorCode(error);
    evidence.conclusion = { executed: true, succeeded: false };
  } finally {
    await cleanupResources(client, created, evidence);
    await rm(fixtureDirectory, { recursive: true, force: true });
    evidence.cleanup.push({ kind: 'fixture_directory', status: 'deleted' });
    evidence.finishedAt = new Date().toISOString();
  }
  const evidencePath = await writeEvidence(options, names, evidence);
  if (failed) throw new Error(`phase0_live_spike_failed:${errorCode(failed)}:${evidencePath}`);
  return { evidencePath, evidence };
}

function printUsage(): void {
  process.stdout.write(`Unified D1 Control Plane Phase 0 live spike\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  pnpm control-plane:phase0-spike --env test\n`);
  process.stdout.write(`  pnpm control-plane:phase0-spike --env test --execute\n\n`);
  process.stdout.write(
    `Add --operator-oauth to execute the setup operator path with the current Wrangler OAuth session.\n`
  );
  process.stdout.write(`Split-token execution requires CLOUDFLARE_ACCOUNT_ID plus distinct `);
  process.stdout.write(`CLOUDFLARE_D1_API_TOKEN and CLOUDFLARE_WORKERS_API_TOKEN.\n`);
  process.stdout.write(
    `In split-token mode, CLOUDFLARE_KV_API_TOKEN and CLOUDFLARE_R2_API_TOKEN enable their rows.\n`
  );
  process.stdout.write(
    `AUTHRIM_PHASE0_WORKER_LOADER=true enables the Paid-plan Worker Loader matrix row.\n`
  );
}

async function main(): Promise<void> {
  let options: Phase0SpikeOptions;
  try {
    options = parsePhase0SpikeArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    if (error instanceof Error && error.message === 'help_requested') return;
    throw error;
  }
  const result = await runPhase0Spike(options);
  process.stdout.write(`Phase 0 evidence: ${result.evidencePath}\n`);
  if (!options.execute)
    process.stdout.write('Dry run only; no Cloudflare resources were created.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
