import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  AUTHRIM_DIR,
  findAuthrimBaseDir,
  findKeysDirectory,
  getEnvironmentPaths,
  getExternalKeysDir,
  type EnvironmentPaths,
} from './paths.js';
import { loadLockFileAuto, type AuthrimLock } from './lock.js';
import { parseConfig, type AuthrimConfig } from './config.js';
import {
  buildResourceIdsFromLock,
  parseWranglerToml,
  validateWranglerConfigs,
} from './wrangler.js';
import { checkWranglerStatus } from './wrangler-sync.js';
import { D1_DATABASES, getEnabledComponents, type WorkerComponent } from './naming.js';
import { listD1Databases, listKVNamespaces, listR2Buckets, queryD1Rows } from './cloudflare.js';

type ValidationStatus = 'pass' | 'warn' | 'fail';

export interface ValidationCheck {
  id: string;
  title: string;
  status: ValidationStatus;
  details: string[];
}

export interface GeneratedEnvValidationResult {
  ok: boolean;
  env: string;
  baseDir: string;
  configPath: string;
  lockPath: string;
  lockType: 'new' | 'legacy';
  enabledComponents: WorkerComponent[];
  checks: ValidationCheck[];
}

export interface GeneratedEnvValidationOptions {
  baseDir: string;
  env: string;
  configPath?: string;
  packagesDir?: string;
  keysBaseDir?: string;
  liveCloudflare?: boolean;
}

interface ParsedTarget {
  baseDir: string;
  env: string;
  configPath: string;
}

const PROFILE_AWARE_COMPONENTS: WorkerComponent[] = [
  'ar-auth',
  'ar-management',
  'ar-token',
  'ar-userinfo',
  'ar-discovery',
  'ar-saml',
  'ar-bridge',
];

const TENANT_RUNTIME_REGISTRY_COMPONENTS: WorkerComponent[] = [
  'ar-auth',
  'ar-management',
  'ar-agent-access',
  'ar-token',
  'ar-userinfo',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
];

const BUILTIN_D1_BINDINGS: Set<string> = new Set(D1_DATABASES.map((db) => db.binding));

function requiredBuiltinD1Bindings(component: WorkerComponent): ReadonlySet<string> {
  return component === 'ar-agent-access' ? new Set(['DB', 'DB_ADMIN']) : BUILTIN_D1_BINDINGS;
}

const LOGGING_R2_BINDINGS = [
  'DIAGNOSTIC_LOGS',
  'AUDIT_ARCHIVE',
  'EXPORT_ARTIFACTS',
  'SENSITIVE_DETAILS',
] as const;

const MANAGEMENT_R2_BINDINGS = [
  'IMPORT_ARTIFACTS',
  'EXPORT_ARTIFACTS',
  'SENSITIVE_DETAILS',
] as const;

const LOGGING_QUEUE_BINDINGS = [
  'AUDIT_QUEUE',
  'LOGGING_DELIVERY_CRITICAL_QUEUE',
  'LOGGING_DELIVERY_QUEUE',
  'LOGGING_DELIVERY_BULK_QUEUE',
] as const;

const AUDIT_QUEUE_PRODUCER_COMPONENTS: WorkerComponent[] = ['ar-auth', 'ar-token'];

const LOGGING_DELIVERY_PRODUCER_COMPONENTS: WorkerComponent[] = [
  'ar-auth',
  'ar-management',
  'ar-token',
  'ar-userinfo',
  'ar-async',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
];

const LIVE_RUNTIME_D1_SCHEMA_REQUIREMENTS: Array<{
  binding: 'DB' | 'DB_PII' | 'DB_ADMIN';
  label: string;
  tables: string[];
}> = [
  {
    binding: 'DB',
    label: 'core runtime schema',
    tables: [
      'users_core',
      'identity_subjects',
      'identity_accounts',
      'profiles',
      'contact_points',
      'custom_claim_schemas',
      'user_custom_fields',
      'event_log',
    ],
  },
  {
    binding: 'DB_PII',
    label: 'PII runtime schema',
    tables: ['identity_sensitive_values', 'users_pii', 'users_pii_tombstone'],
  },
  {
    binding: 'DB_ADMIN',
    label: 'admin runtime schema',
    tables: ['admin_users', 'admin_machine_principals', 'field_mapping_sets'],
  },
];

const DIAGNOSTIC_R2_COMPONENTS: WorkerComponent[] = [
  'ar-auth',
  'ar-token',
  'ar-async',
  'ar-saml',
  'ar-vc',
  'ar-management',
];

function normalizeHyperdriveRefCandidates(ref: string): string[] {
  const normalized = ref
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
  return [...new Set([ref.trim(), normalized, `HYPERDRIVE_${normalized}`])];
}

function resolveConfiguredHyperdriveReference(
  config: AuthrimConfig,
  ref: string | undefined,
  driver: 'postgres' | 'mysql'
) {
  if (!ref) {
    return null;
  }

  const configured = config.profiles.references?.hyperdrive ?? {};
  for (const candidate of normalizeHyperdriveRefCandidates(ref)) {
    const direct = configured[candidate];
    if (direct && direct.driver === driver) {
      return direct;
    }
  }

  return (
    Object.values(configured).find(
      (entry) =>
        entry.driver === driver && normalizeHyperdriveRefCandidates(ref).includes(entry.binding)
    ) ?? null
  );
}

function inferTargetFromConfigPath(configPath: string): ParsedTarget {
  const resolvedPath = resolve(configPath);
  const pathParts = resolvedPath.split(sep);
  const authrimIndex = pathParts.lastIndexOf(AUTHRIM_DIR);

  if (authrimIndex !== -1 && authrimIndex + 1 < pathParts.length) {
    const baseDirParts = pathParts.slice(0, authrimIndex);
    const baseDir = baseDirParts.length > 0 ? baseDirParts.join(sep) || sep : sep;
    const env = pathParts[authrimIndex + 1];
    return {
      baseDir,
      env,
      configPath: resolvedPath,
    };
  }

  const parsed = parseConfig(JSON.parse(readFileSync(resolvedPath, 'utf-8')));
  return {
    baseDir: findAuthrimBaseDir(dirname(resolvedPath)),
    env: parsed.environment.prefix,
    configPath: resolvedPath,
  };
}

export function resolveGeneratedEnvValidationTarget(options: {
  baseDir?: string;
  env?: string;
  configPath?: string;
}): ParsedTarget {
  if (options.configPath) {
    return inferTargetFromConfigPath(options.configPath);
  }

  const baseDir = options.baseDir ? resolve(options.baseDir) : findAuthrimBaseDir(process.cwd());
  if (!options.env) {
    throw new Error('env_or_config_path_is_required');
  }

  const envPaths = getEnvironmentPaths({ baseDir, env: options.env });
  return {
    baseDir,
    env: options.env,
    configPath: envPaths.config,
  };
}

function makeCheck(id: string, title: string): ValidationCheck {
  return { id, title, status: 'pass', details: [] };
}

function pushDetail(check: ValidationCheck, status: ValidationStatus, detail: string): void {
  check.details.push(detail);
  if (status === 'fail') {
    check.status = 'fail';
    return;
  }
  if (status === 'warn' && check.status === 'pass') {
    check.status = 'warn';
  }
}

function finishCheck(check: ValidationCheck, fallbackDetail: string): ValidationCheck {
  if (check.details.length === 0) {
    check.details.push(fallbackDetail);
  }
  return check;
}

function isTenantD1SlotBinding(binding: string): boolean {
  return /^TDB_SLOT_[0-9]{4}_(CORE|PII)$/.test(binding);
}

function countValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveKeysDirectory(
  baseDir: string,
  env: string,
  envPaths: EnvironmentPaths,
  config: AuthrimConfig,
  keysBaseDir?: string
): string {
  const configuredPath = config.keys?.secretsPath?.trim();
  if (config.keys?.storageType === 'external') {
    const externalBaseDir = keysBaseDir ?? baseDir;
    const found = findKeysDirectory({
      env,
      sourceDir: baseDir,
      keysBaseDir: externalBaseDir,
    });
    if (found?.location === 'external') {
      return found.path;
    }
    if (configuredPath && isAbsolute(configuredPath) && existsSync(configuredPath)) {
      return configuredPath;
    }
    return getExternalKeysDir(env, externalBaseDir);
  }

  if (configuredPath) {
    return isAbsolute(configuredPath) ? configuredPath : resolve(envPaths.root, configuredPath);
  }

  const found = findKeysDirectory({ env, sourceDir: baseDir, keysBaseDir });
  return found?.path ?? envPaths.keys;
}

async function inspectSecretFile(
  check: ValidationCheck,
  path: string,
  label: string,
  validate: (value: string) => boolean
): Promise<void> {
  if (!existsSync(path)) {
    pushDetail(check, 'fail', `${label}: ${path} is missing`);
    return;
  }

  const value = (await readFile(path, 'utf-8')).trim();
  if (!validate(value)) {
    pushDetail(check, 'fail', `${label}: ${path} has an invalid format`);
    return;
  }

  pushDetail(check, 'pass', `${label}: present`);
}

function isHexRootKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isBase64UrlSecret(value: string): boolean {
  return value.length >= 32 && /^[A-Za-z0-9_-]+$/.test(value);
}

function parseWranglerVars(content: string, env: string): Record<string, string> {
  const lines = content.split('\n');
  const header = `[env.${env}.vars]`;
  const startIndex = lines.findIndex((line) => line.trim() === header);
  if (startIndex === -1) {
    return {};
  }

  const vars: Record<string, string> = {};
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('[')) {
      break;
    }
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

function isSeededProfile(
  config: AuthrimConfig,
  kind: 'storage' | 'audit' | 'residency',
  id: string
): boolean {
  return (config.profiles.seed[kind] ?? []).some((profile) => profile.id === id);
}

function resolveSeededStorageProfile(config: AuthrimConfig, id: string) {
  return (config.profiles.seed.storage ?? []).find((profile) => profile.id === id) ?? null;
}

function resolveSeededAuditProfile(config: AuthrimConfig, id: string) {
  return (config.profiles.seed.audit ?? []).find((profile) => profile.id === id) ?? null;
}

function inspectStorageProfileTarget(
  config: AuthrimConfig,
  check: ValidationCheck,
  scope: string,
  target: { driver: string; bindingRef?: string; connectionRef?: string }
): void {
  if (target.driver === 'postgres' || target.driver === 'mysql') {
    const reference = resolveConfiguredHyperdriveReference(
      config,
      target.connectionRef ?? target.bindingRef,
      target.driver
    );
    if (reference) {
      pushDetail(
        check,
        'pass',
        `${scope}: ${target.driver} -> ${reference.binding} (${reference.id})`
      );
      return;
    }
    pushDetail(
      check,
      'fail',
      `${scope}: ${target.driver} target requires a configured Hyperdrive reference for ${target.connectionRef ?? target.bindingRef ?? '(missing)'}`
    );
    return;
  }
  if (target.driver !== 'd1') {
    pushDetail(
      check,
      'fail',
      `${scope}: driver=${target.driver} cannot be used as an active default with only setup-generated primary bindings`
    );
    return;
  }
  if (!target.bindingRef || !BUILTIN_D1_BINDINGS.has(target.bindingRef)) {
    pushDetail(
      check,
      'fail',
      `${scope}: bindingRef=${target.bindingRef ?? '(missing)'} is not a built-in D1 binding`
    );
  }
}

function inspectAuditDatabaseTarget(
  config: AuthrimConfig,
  check: ValidationCheck,
  scope: string,
  target: { type: string; bindingRef?: string; connectionRef?: string } | null | undefined
): void {
  if (!target) {
    return;
  }
  if (target.type === 'postgres' || target.type === 'mysql') {
    const reference = resolveConfiguredHyperdriveReference(
      config,
      target.connectionRef ?? target.bindingRef,
      target.type
    );
    if (reference) {
      pushDetail(
        check,
        'pass',
        `${scope}: ${target.type} -> ${reference.binding} (${reference.id})`
      );
      return;
    }
    pushDetail(
      check,
      'fail',
      `${scope}: ${target.type} target requires a configured Hyperdrive reference for ${target.connectionRef ?? target.bindingRef ?? '(missing)'}`
    );
    return;
  }
  if (target.type !== 'd1') {
    pushDetail(
      check,
      'fail',
      `${scope}: type=${target.type} cannot be used as an active default with only setup-generated D1 bindings`
    );
    return;
  }
  if (!target.bindingRef || !BUILTIN_D1_BINDINGS.has(target.bindingRef)) {
    pushDetail(
      check,
      'fail',
      `${scope}: bindingRef=${target.bindingRef ?? '(missing)'} is not a built-in D1 binding`
    );
  }
}

function inspectNonDefaultProfiles(config: AuthrimConfig): ValidationCheck {
  const check = makeCheck(
    'seeded-profile-portability',
    'Non-default seed profiles are storable, but setup-only references are reported as warnings'
  );
  const activeStorageId = config.profiles.defaults.storage;
  const activeAuditId = config.profiles.defaults.audit;

  for (const profile of config.profiles.seed.storage ?? []) {
    if (profile.id === activeStorageId) {
      continue;
    }
    for (const [slice, target] of Object.entries(profile.slices)) {
      if (!target) {
        continue;
      }
      if (target.connectionRef) {
        const reference = resolveConfiguredHyperdriveReference(
          config,
          target.connectionRef,
          target.driver === 'mysql' ? 'mysql' : 'postgres'
        );
        pushDetail(
          check,
          reference ? 'pass' : 'warn',
          reference
            ? `storage profile ${profile.id} / ${slice}: ${target.connectionRef} -> ${reference.binding}`
            : `storage profile ${profile.id} / ${slice}: connectionRef=${target.connectionRef}`
        );
        continue;
      }
      if (target.driver !== 'd1') {
        const reference = resolveConfiguredHyperdriveReference(
          config,
          target.bindingRef,
          target.driver === 'mysql' ? 'mysql' : 'postgres'
        );
        pushDetail(
          check,
          reference ? 'pass' : 'warn',
          reference
            ? `storage profile ${profile.id} / ${slice}: ${target.bindingRef} -> ${reference.id}`
            : `storage profile ${profile.id} / ${slice}: driver=${target.driver}`
        );
        continue;
      }
      if (!target.bindingRef || !BUILTIN_D1_BINDINGS.has(target.bindingRef)) {
        pushDetail(
          check,
          'warn',
          `storage profile ${profile.id} / ${slice}: bindingRef=${target.bindingRef ?? '(missing)'}`
        );
      }
    }
  }

  for (const profile of config.profiles.seed.audit ?? []) {
    if (profile.id === activeAuditId) {
      continue;
    }
    const targets = [
      ['primary', profile.primary],
      ['archive', profile.archive],
    ] as const;

    for (const [label, target] of targets) {
      if (!target || target.type === 'r2') {
        continue;
      }
      if ('connectionRef' in target && target.connectionRef) {
        const reference = resolveConfiguredHyperdriveReference(
          config,
          target.connectionRef,
          target.type === 'mysql' ? 'mysql' : 'postgres'
        );
        pushDetail(
          check,
          reference ? 'pass' : 'warn',
          reference
            ? `audit profile ${profile.id} / ${label}: ${target.connectionRef} -> ${reference.binding}`
            : `audit profile ${profile.id} / ${label}: connectionRef=${target.connectionRef}`
        );
        continue;
      }
      if (target.type !== 'd1') {
        const reference = resolveConfiguredHyperdriveReference(
          config,
          target.bindingRef,
          target.type === 'mysql' ? 'mysql' : 'postgres'
        );
        pushDetail(
          check,
          reference ? 'pass' : 'warn',
          reference
            ? `audit profile ${profile.id} / ${label}: ${target.bindingRef} -> ${reference.id}`
            : `audit profile ${profile.id} / ${label}: type=${target.type}`
        );
        continue;
      }
      if (!target.bindingRef || !BUILTIN_D1_BINDINGS.has(target.bindingRef)) {
        pushDetail(
          check,
          'warn',
          `audit profile ${profile.id} / ${label}: bindingRef=${target.bindingRef ?? '(missing)'}`
        );
      }
    }
  }

  return finishCheck(check, 'Non-default seed profiles have no unresolved setup backends');
}

function expectedProfileVars(config: AuthrimConfig): Record<string, string> {
  return {
    PROFILE_REGISTRY_BACKEND: config.profiles.registry.backend,
    DEFAULT_STORAGE_PROFILE_ID: config.profiles.defaults.storage,
    DEFAULT_AUDIT_PROFILE_ID: config.profiles.defaults.audit,
    DEFAULT_RESIDENCY_PROFILE_ID: config.profiles.defaults.residency,
  };
}

async function readConfig(configPath: string): Promise<AuthrimConfig> {
  const raw = JSON.parse(await readFile(configPath, 'utf-8'));
  return parseConfig(raw);
}

function validateDefaultProfileReferences(config: AuthrimConfig): ValidationCheck {
  const check = makeCheck('default-profiles', 'default profile references are defined');
  const defaults = [
    ['storage', config.profiles.defaults.storage],
    ['audit', config.profiles.defaults.audit],
    ['residency', config.profiles.defaults.residency],
  ] as const;

  for (const [kind, id] of defaults) {
    if (id.startsWith('builtin:') || isSeededProfile(config, kind, id)) {
      pushDetail(check, 'pass', `${kind}: ${id}`);
      continue;
    }
    pushDetail(check, 'fail', `${kind}: ${id} is neither built-in nor a seeded profile`);
  }

  return finishCheck(check, 'All default profile references can be resolved');
}

function validateActiveProfileCompatibility(config: AuthrimConfig): ValidationCheck {
  const check = makeCheck(
    'active-profile-compatibility',
    'Active default profiles can be activated using only setup output'
  );

  if (config.profiles.defaults.storage === 'builtin:storage:external-postgres') {
    inspectStorageProfileTarget(
      config,
      check,
      'storage profile builtin:storage:external-postgres / identity core',
      {
        driver: 'postgres',
        connectionRef: 'core-primary',
      }
    );
    inspectStorageProfileTarget(
      config,
      check,
      'storage profile builtin:storage:external-postgres / identity PII',
      {
        driver: 'postgres',
        connectionRef: 'pii-primary',
      }
    );
  }

  const seededStorage = resolveSeededStorageProfile(config, config.profiles.defaults.storage);
  if (seededStorage) {
    for (const [slice, target] of Object.entries(seededStorage.slices)) {
      if (!target) {
        continue;
      }
      inspectStorageProfileTarget(
        config,
        check,
        `storage profile ${seededStorage.id} / ${slice}`,
        target
      );
    }
  }

  const seededAudit = resolveSeededAuditProfile(config, config.profiles.defaults.audit);
  if (seededAudit) {
    inspectAuditDatabaseTarget(
      config,
      check,
      `audit profile ${seededAudit.id} / primary`,
      seededAudit.primary
    );
    inspectAuditDatabaseTarget(
      config,
      check,
      `audit profile ${seededAudit.id} / archive`,
      seededAudit.archive
    );
  }

  return finishCheck(check, 'Active default profiles can be activated using only setup output');
}

function validateRequiredD1Bindings(lock: AuthrimLock): ValidationCheck {
  const check = makeCheck('lock-d1-bindings', 'lock.json has all required D1 bindings');
  for (const binding of BUILTIN_D1_BINDINGS) {
    if (lock.d1[binding]?.id) {
      pushDetail(check, 'pass', `${binding}: ${lock.d1[binding].id}`);
    } else {
      pushDetail(check, 'fail', `${binding} is missing from lock.json`);
    }
  }
  return finishCheck(check, 'All required D1 bindings are present in lock.json');
}

function validateLoggingR2Bindings(config: AuthrimConfig, lock: AuthrimLock): ValidationCheck {
  const check = makeCheck(
    'logging-r2-bindings',
    'lock.json has R2 buckets required by generated logging defaults'
  );

  if (config.features.r2?.enabled === false) {
    pushDetail(
      check,
      'warn',
      'features.r2.enabled=false; generated logging defaults cannot use R2 chunk/archive buckets'
    );
    return finishCheck(check, 'R2 is disabled');
  }

  for (const binding of LOGGING_R2_BINDINGS) {
    const bucket = lock.r2?.[binding];
    if (bucket?.name) {
      pushDetail(check, 'pass', `${binding}: ${bucket.name}`);
      continue;
    }
    pushDetail(check, 'fail', `${binding} is missing from lock.json`);
  }

  return finishCheck(check, 'All logging R2 buckets are present in lock.json');
}

function validateLoggingQueueBindings(config: AuthrimConfig, lock: AuthrimLock): ValidationCheck {
  const check = makeCheck(
    'logging-queue-bindings',
    'lock.json has queues required by generated logging delivery'
  );

  if (config.features.queue?.enabled !== true) {
    pushDetail(
      check,
      'warn',
      'features.queue.enabled is not true; generated logging delivery retry/DLQ queues are disabled'
    );
    return finishCheck(check, 'Cloudflare Queues are disabled');
  }

  for (const binding of LOGGING_QUEUE_BINDINGS) {
    const queue = lock.queues?.[binding];
    if (queue?.name) {
      pushDetail(check, 'pass', `${binding}: ${queue.name}`);
      continue;
    }
    pushDetail(check, 'fail', `${binding} is missing from lock.json`);
  }

  return finishCheck(check, 'All logging queue bindings are present in lock.json');
}

function expectedLockQueueName(
  lock: AuthrimLock,
  binding: (typeof LOGGING_QUEUE_BINDINGS)[number]
) {
  return lock.queues?.[binding]?.name ?? null;
}

async function validateLoggingSecretMaterial(
  baseDir: string,
  env: string,
  envPaths: EnvironmentPaths,
  config: AuthrimConfig,
  keysBaseDir?: string
): Promise<ValidationCheck> {
  const check = makeCheck(
    'logging-secret-material',
    'generated keys include logging, OTP, VC, and encryption secrets'
  );
  const keysDir = resolveKeysDirectory(baseDir, env, envPaths, config, keysBaseDir);

  if (!existsSync(keysDir)) {
    pushDetail(check, 'fail', `keys directory is missing: ${keysDir}`);
    return finishCheck(check, 'generated keys include logging, OTP, VC, and encryption secrets');
  }

  await inspectSecretFile(
    check,
    join(keysDir, 'logging_cursor_hmac_secret.txt'),
    'LOGGING_CURSOR_HMAC_SECRET',
    isBase64UrlSecret
  );
  await inspectSecretFile(
    check,
    join(keysDir, 'object_encryption_root_key.txt'),
    'OBJECT_ENCRYPTION_ROOT_KEY',
    isHexRootKey
  );
  await inspectSecretFile(
    check,
    join(keysDir, 'pii_encryption_key.txt'),
    'PII_ENCRYPTION_KEY',
    isHexRootKey
  );
  await inspectSecretFile(
    check,
    join(keysDir, 'otp_hmac_secret.txt'),
    'OTP_HMAC_SECRET',
    isBase64UrlSecret
  );
  await inspectSecretFile(
    check,
    join(keysDir, 'vc_transaction_code_hmac_secret.txt'),
    'VC_TRANSACTION_CODE_HMAC_SECRET',
    isBase64UrlSecret
  );
  await inspectSecretFile(
    check,
    join(keysDir, 'vc_evidence_hmac_secret.txt'),
    'VC_EVIDENCE_HMAC_SECRET',
    isBase64UrlSecret
  );
  await inspectSecretFile(
    check,
    join(keysDir, 'vc_profile_contract_hmac_secret.txt'),
    'VC_PROFILE_CONTRACT_HMAC_SECRET',
    isBase64UrlSecret
  );
  return finishCheck(check, 'generated keys include logging, OTP, VC, and encryption secrets');
}

async function validateDeployWranglers(
  baseDir: string,
  env: string,
  config: AuthrimConfig,
  lock: AuthrimLock,
  packagesDir: string
): Promise<ValidationCheck> {
  const check = makeCheck(
    'deploy-wranglers',
    'deploy wrangler.toml matches lock resources and active profile vars'
  );
  const enabledComponents = Array.from(
    getEnabledComponents({
      saml: config.components.saml,
      async: config.components.async,
      vc: config.components.vc,
      bridge: config.components.bridge,
      policy: config.components.policy,
    })
  );

  for (const component of enabledComponents) {
    const deployPath = join(packagesDir, component, 'wrangler.toml');
    if (!existsSync(deployPath)) {
      pushDetail(check, 'fail', `${component}: packages/${component}/wrangler.toml is missing`);
    }
  }

  const validation = await validateWranglerConfigs(
    baseDir,
    env,
    buildResourceIdsFromLock(lock, config),
    enabledComponents
  );

  for (const mismatch of validation.mismatches) {
    pushDetail(
      check,
      'fail',
      `${mismatch.component}: ${mismatch.type} ${mismatch.binding} expected=${mismatch.expected} actual=${mismatch.actual}`
    );
  }

  for (const component of enabledComponents) {
    const deployPath = join(packagesDir, component, 'wrangler.toml');
    if (!existsSync(deployPath)) {
      continue;
    }

    const content = await readFile(deployPath, 'utf-8');
    const parsed = parseWranglerToml(content, env);
    if (component !== 'ar-router' && component !== 'ar-async') {
      for (const binding of requiredBuiltinD1Bindings(component)) {
        if (!parsed.d1[binding]) {
          pushDetail(
            check,
            'fail',
            `${component}: ${binding} binding is missing from wrangler.toml`
          );
        }
      }
    }

    const expectedDiagnosticLogs = lock.r2?.DIAGNOSTIC_LOGS?.name;
    if (expectedDiagnosticLogs && DIAGNOSTIC_R2_COMPONENTS.includes(component)) {
      if (parsed.r2.DIAGNOSTIC_LOGS !== expectedDiagnosticLogs) {
        pushDetail(
          check,
          'fail',
          `${component}: DIAGNOSTIC_LOGS expected=${expectedDiagnosticLogs} actual=${parsed.r2.DIAGNOSTIC_LOGS ?? '(missing)'}`
        );
      }
    }

    const expectedAuditArchive = lock.r2?.AUDIT_ARCHIVE?.name;
    if (expectedAuditArchive && DIAGNOSTIC_R2_COMPONENTS.includes(component)) {
      if (parsed.r2.AUDIT_ARCHIVE !== expectedAuditArchive) {
        pushDetail(
          check,
          'fail',
          `${component}: AUDIT_ARCHIVE expected=${expectedAuditArchive} actual=${parsed.r2.AUDIT_ARCHIVE ?? '(missing)'}`
        );
      }
    }

    if (component === 'ar-management') {
      for (const binding of MANAGEMENT_R2_BINDINGS) {
        const expectedBucket = lock.r2?.[binding]?.name;
        if (expectedBucket && parsed.r2[binding] !== expectedBucket) {
          pushDetail(
            check,
            'fail',
            `${component}: ${binding} expected=${expectedBucket} actual=${parsed.r2[binding] ?? '(missing)'}`
          );
        }
      }
    }

    if (config.features.queue?.enabled === true) {
      if (AUDIT_QUEUE_PRODUCER_COMPONENTS.includes(component)) {
        const expectedQueue = expectedLockQueueName(lock, 'AUDIT_QUEUE');
        if (expectedQueue && parsed.queueProducers.AUDIT_QUEUE !== expectedQueue) {
          pushDetail(
            check,
            'fail',
            `${component}: AUDIT_QUEUE producer expected=${expectedQueue} actual=${parsed.queueProducers.AUDIT_QUEUE ?? '(missing)'}`
          );
        }
      }

      if (LOGGING_DELIVERY_PRODUCER_COMPONENTS.includes(component)) {
        for (const binding of LOGGING_QUEUE_BINDINGS.filter(
          (candidate) => candidate !== 'AUDIT_QUEUE'
        )) {
          const expectedQueue = expectedLockQueueName(lock, binding);
          if (expectedQueue && parsed.queueProducers[binding] !== expectedQueue) {
            pushDetail(
              check,
              'fail',
              `${component}: ${binding} producer expected=${expectedQueue} actual=${parsed.queueProducers[binding] ?? '(missing)'}`
            );
          }
        }
      }

      if (component === 'ar-management') {
        for (const binding of LOGGING_QUEUE_BINDINGS) {
          const expectedQueue = expectedLockQueueName(lock, binding);
          if (expectedQueue && !parsed.queueConsumers.includes(expectedQueue)) {
            pushDetail(
              check,
              'fail',
              `${component}: ${binding} consumer expected=${expectedQueue} actual=(missing)`
            );
          }
        }
        const vars = parseWranglerVars(content, env);
        const expectedDeliveryQueueNames = LOGGING_QUEUE_BINDINGS.filter(
          (binding) => binding !== 'AUDIT_QUEUE'
        )
          .map((binding) => expectedLockQueueName(lock, binding))
          .filter((value): value is string => !!value)
          .join(',');
        if (
          expectedDeliveryQueueNames &&
          vars.LOGGING_DELIVERY_QUEUE_NAMES !== expectedDeliveryQueueNames
        ) {
          pushDetail(
            check,
            'fail',
            `${component}: LOGGING_DELIVERY_QUEUE_NAMES expected=${expectedDeliveryQueueNames} actual=${vars.LOGGING_DELIVERY_QUEUE_NAMES ?? '(missing)'}`
          );
        }
      }
    }

    if (PROFILE_AWARE_COMPONENTS.includes(component)) {
      const vars = parseWranglerVars(content, env);
      for (const [key, value] of Object.entries(expectedProfileVars(config))) {
        if (vars[key] !== value) {
          pushDetail(
            check,
            'fail',
            `${component}: ${key} expected=${value} actual=${vars[key] ?? '(missing)'}`
          );
        }
      }
    }

    if (
      config.profiles.defaults.storage === 'builtin:storage:tenant-d1' &&
      TENANT_RUNTIME_REGISTRY_COMPONENTS.includes(component) &&
      !parsed.kv.TENANT_RUNTIME_REGISTRY
    ) {
      pushDetail(
        check,
        'fail',
        `${component}: TENANT_RUNTIME_REGISTRY binding is required for tenant-d1 runtime registry snapshots`
      );
    }

    const expectedHyperdrive = Object.values(config.profiles.references?.hyperdrive ?? {});
    if (
      component !== 'ar-router' &&
      component !== 'ar-agent-access' &&
      expectedHyperdrive.length > 0
    ) {
      for (const binding of expectedHyperdrive) {
        if (parsed.hyperdrive[binding.binding] !== binding.id) {
          pushDetail(
            check,
            'fail',
            `${component}: hyperdrive ${binding.binding} expected=${binding.id} actual=${parsed.hyperdrive[binding.binding] ?? '(missing)'}`
          );
        }
      }
    }
  }

  if (config.profiles.registry.backend === 'kv' && !lock.kv.AUTHRIM_CONFIG?.id) {
    pushDetail(
      check,
      'fail',
      'PROFILE_REGISTRY_BACKEND=kv but AUTHRIM_CONFIG namespace is missing from lock.json'
    );
  }

  return finishCheck(check, 'deploy wrangler.toml matches lock resources and active profile vars');
}

async function validateMasterWranglers(
  baseDir: string,
  env: string,
  envPaths: EnvironmentPaths,
  packagesDir: string
): Promise<ValidationCheck> {
  const check = makeCheck(
    'master-wranglers',
    '.authrim/{env}/wrangler master config is synchronized with package deploy copies'
  );
  if (!existsSync(envPaths.wrangler)) {
    pushDetail(check, 'fail', `${envPaths.wrangler} is missing`);
    return finishCheck(check, 'master wrangler config is synchronized');
  }

  const statuses = await checkWranglerStatus({ baseDir, env, packagesDir });
  for (const status of statuses) {
    if (!status.masterExists) {
      pushDetail(check, 'fail', `${status.component}: master config is missing`);
      continue;
    }
    if (!status.deployExists) {
      pushDetail(check, 'fail', `${status.component}: deploy copy is missing`);
      continue;
    }
    if (!status.inSync) {
      pushDetail(check, 'fail', `${status.component}: master and deploy copy are out of sync`);
      continue;
    }
    pushDetail(check, 'pass', `${status.component}: in sync`);
  }

  return finishCheck(check, 'master wrangler config is synchronized with package deploy copies');
}

async function validateLiveCloudflareD1(lock: AuthrimLock): Promise<ValidationCheck> {
  const check = makeCheck('live-cloudflare-d1', 'Cloudflare D1 databases in lock.json exist');

  try {
    const cloudflareDatabases = await listD1Databases();
    const byName = new Map(cloudflareDatabases.map((database) => [database.name, database.uuid]));

    for (const [binding, database] of Object.entries(lock.d1)) {
      const cloudflareId = byName.get(database.name);
      if (!cloudflareId) {
        pushDetail(check, 'fail', `${binding}: ${database.name} is missing in Cloudflare D1`);
        continue;
      }
      if (cloudflareId !== database.id) {
        pushDetail(
          check,
          'fail',
          `${binding}: ${database.name} id mismatch lock=${database.id} cloudflare=${cloudflareId}`
        );
        continue;
      }
      pushDetail(check, 'pass', `${binding}: ${database.name} (${database.id})`);
    }
  } catch (error) {
    pushDetail(
      check,
      'fail',
      `Cloudflare D1 list failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return finishCheck(check, 'All lock.json D1 databases exist in Cloudflare');
}

async function validateLiveCloudflareKV(lock: AuthrimLock): Promise<ValidationCheck> {
  const check = makeCheck('live-cloudflare-kv', 'Cloudflare KV namespaces in lock.json exist');

  try {
    const cloudflareNamespaces = await listKVNamespaces();
    const byTitle = new Map(
      cloudflareNamespaces.map((namespace) => [namespace.title, namespace.id])
    );

    for (const [binding, namespace] of Object.entries(lock.kv)) {
      const cloudflareId = byTitle.get(namespace.name);
      if (!cloudflareId) {
        pushDetail(check, 'fail', `${binding}: ${namespace.name} is missing in Cloudflare KV`);
        continue;
      }
      if (cloudflareId !== namespace.id) {
        pushDetail(
          check,
          'fail',
          `${binding}: ${namespace.name} id mismatch lock=${namespace.id} cloudflare=${cloudflareId}`
        );
        continue;
      }
      pushDetail(check, 'pass', `${binding}: ${namespace.name} (${namespace.id})`);
    }
  } catch (error) {
    pushDetail(
      check,
      'fail',
      `Cloudflare KV list failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return finishCheck(check, 'All lock.json KV namespaces exist in Cloudflare');
}

async function validateLiveCloudflareR2(lock: AuthrimLock): Promise<ValidationCheck> {
  const check = makeCheck('live-cloudflare-r2', 'Cloudflare R2 buckets in lock.json exist');
  const recordedBuckets = Object.entries(lock.r2 ?? {});

  if (recordedBuckets.length === 0) {
    pushDetail(check, 'pass', 'No R2 buckets are recorded in lock.json');
    return finishCheck(check, 'No R2 buckets are recorded in lock.json');
  }

  try {
    const cloudflareBuckets = await listR2Buckets({ throwOnError: true });
    const names = new Set(cloudflareBuckets.map((bucket) => bucket.name));

    for (const [binding, bucket] of recordedBuckets) {
      if (!names.has(bucket.name)) {
        pushDetail(check, 'fail', `${binding}: ${bucket.name} is missing in Cloudflare R2`);
        continue;
      }
      pushDetail(check, 'pass', `${binding}: ${bucket.name}`);
    }
  } catch (error) {
    pushDetail(
      check,
      'fail',
      `Cloudflare R2 list failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return finishCheck(check, 'All lock.json R2 buckets exist in Cloudflare');
}

async function validateLiveTenantD1Slots(
  config: AuthrimConfig,
  lock: AuthrimLock
): Promise<ValidationCheck> {
  const check = makeCheck(
    'live-tenant-d1-slots',
    'Tenant D1 preallocated slots are present in generated resources and DB_ADMIN'
  );

  if (config.profiles.defaults.storage !== 'builtin:storage:tenant-d1') {
    pushDetail(check, 'pass', 'Tenant D1 storage profile is not active');
    return finishCheck(check, 'Tenant D1 storage profile is not active');
  }

  const expectedSlots = config.tenantD1?.preallocatedSlots ?? 3;
  const tenantD1Bindings = Object.keys(lock.d1).filter(isTenantD1SlotBinding);
  const expectedBindings = expectedSlots * 2;
  if (tenantD1Bindings.length !== expectedBindings) {
    pushDetail(
      check,
      'fail',
      `tenant D1 binding count expected=${expectedBindings} actual=${tenantD1Bindings.length}`
    );
  } else {
    pushDetail(check, 'pass', `tenant D1 bindings: ${tenantD1Bindings.length}/${expectedBindings}`);
  }

  const adminDb = lock.d1.DB_ADMIN;
  if (!adminDb?.name) {
    pushDetail(check, 'fail', 'DB_ADMIN is missing from lock.json');
    return finishCheck(check, 'DB_ADMIN is required for tenant D1 slot validation');
  }

  try {
    const rows = await queryD1Rows<{ count: number | string }>(
      adminDb.name,
      'SELECT COUNT(*) AS count FROM tenant_database_slots;'
    );
    const actualSlots = countValue(rows[0]?.count);
    if (actualSlots !== expectedSlots) {
      pushDetail(
        check,
        'fail',
        `tenant_database_slots count expected=${expectedSlots} actual=${actualSlots}`
      );
    } else {
      pushDetail(check, 'pass', `tenant_database_slots count: ${actualSlots}/${expectedSlots}`);
    }
  } catch (error) {
    pushDetail(
      check,
      'fail',
      `tenant_database_slots query failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return finishCheck(check, 'Tenant D1 slot resources and DB_ADMIN metadata are consistent');
}

async function validateLiveRuntimeD1Schema(lock: AuthrimLock): Promise<ValidationCheck> {
  const check = makeCheck(
    'live-runtime-d1-schema',
    'Live D1 databases contain runtime schema tables required by current workers'
  );

  for (const requirement of LIVE_RUNTIME_D1_SCHEMA_REQUIREMENTS) {
    const database = lock.d1[requirement.binding];
    if (!database?.name) {
      pushDetail(check, 'fail', `${requirement.binding}: missing from lock.json`);
      continue;
    }

    try {
      const tableList = requirement.tables.map(sqlString).join(', ');
      const rows = await queryD1Rows<{ name: string }>(
        database.name,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableList}) ORDER BY name;`
      );
      const existingTables = new Set(
        rows.map((row) => row.name).filter((name): name is string => typeof name === 'string')
      );
      const missingTables = requirement.tables.filter((table) => !existingTables.has(table));

      if (missingTables.length > 0) {
        pushDetail(
          check,
          'fail',
          `${requirement.binding} (${database.name}) missing ${requirement.label} table(s): ${missingTables.join(', ')}`
        );
      } else {
        pushDetail(
          check,
          'pass',
          `${requirement.binding} (${database.name}) has ${requirement.label} tables`
        );
      }
    } catch (error) {
      pushDetail(
        check,
        'fail',
        `${requirement.binding} (${database.name}) schema query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const coreDatabase = lock.d1.DB;
  if (coreDatabase?.name) {
    try {
      const foreignKeys = await queryD1Rows<{ table?: string; from?: string; to?: string }>(
        coreDatabase.name,
        'PRAGMA foreign_key_list(user_custom_fields);'
      );
      const legacyUsersCoreReferences = foreignKeys.filter(
        (row) => row.table === 'users_core' && row.from === 'user_id'
      );
      if (legacyUsersCoreReferences.length > 0) {
        pushDetail(
          check,
          'fail',
          `DB (${coreDatabase.name}) user_custom_fields still references legacy users_core(id)`
        );
      } else {
        pushDetail(
          check,
          'pass',
          `DB (${coreDatabase.name}) user_custom_fields has no legacy users_core FK`
        );
      }
    } catch (error) {
      pushDetail(
        check,
        'fail',
        `DB (${coreDatabase.name}) user_custom_fields FK query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return finishCheck(check, 'Live D1 runtime schema tables are present');
}

export async function validateGeneratedEnvironment(
  options: GeneratedEnvValidationOptions
): Promise<GeneratedEnvValidationResult> {
  const baseDir = resolve(options.baseDir);
  const envPaths = getEnvironmentPaths({ baseDir, env: options.env });
  const configPath = options.configPath ? resolve(options.configPath) : envPaths.config;
  const packagesDir = options.packagesDir
    ? resolve(options.packagesDir)
    : join(baseDir, 'packages');

  const configCheck = makeCheck('config', 'config.json is readable');
  let config: AuthrimConfig;
  try {
    config = await readConfig(configPath);
    pushDetail(configCheck, 'pass', configPath);
  } catch (error) {
    pushDetail(
      configCheck,
      'fail',
      `${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return {
      ok: false,
      env: options.env,
      baseDir,
      configPath,
      lockPath: envPaths.lock,
      lockType: 'new',
      enabledComponents: [],
      checks: [finishCheck(configCheck, 'config.json is not readable')],
    };
  }

  const lockCheck = makeCheck('lock', 'lock.json is readable');
  const loadedLock = await loadLockFileAuto(baseDir, options.env);
  if (!loadedLock.lock) {
    pushDetail(lockCheck, 'fail', `${loadedLock.path} is missing`);
    return {
      ok: false,
      env: options.env,
      baseDir,
      configPath,
      lockPath: loadedLock.path,
      lockType: loadedLock.type,
      enabledComponents: [],
      checks: [
        finishCheck(configCheck, 'config.json is readable'),
        finishCheck(lockCheck, 'lock.json is not readable'),
      ],
    };
  }
  pushDetail(lockCheck, 'pass', `${loadedLock.path} (${loadedLock.type})`);
  const lock = loadedLock.lock;

  const enabledComponents = Array.from(
    getEnabledComponents({
      saml: config.components.saml,
      async: config.components.async,
      vc: config.components.vc,
      bridge: config.components.bridge,
      policy: config.components.policy,
    })
  );

  const checks = [
    finishCheck(configCheck, 'config.json is readable'),
    finishCheck(lockCheck, 'lock.json is readable'),
    validateRequiredD1Bindings(lock),
    validateLoggingR2Bindings(config, lock),
    validateLoggingQueueBindings(config, lock),
    validateDefaultProfileReferences(config),
    validateActiveProfileCompatibility(config),
    inspectNonDefaultProfiles(config),
    await validateLoggingSecretMaterial(
      baseDir,
      options.env,
      envPaths,
      config,
      options.keysBaseDir
    ),
    await validateDeployWranglers(baseDir, options.env, config, lock, packagesDir),
    await validateMasterWranglers(baseDir, options.env, envPaths, packagesDir),
  ];

  if (options.liveCloudflare) {
    checks.push(
      await validateLiveCloudflareD1(lock),
      await validateLiveCloudflareKV(lock),
      await validateLiveCloudflareR2(lock),
      await validateLiveRuntimeD1Schema(lock),
      await validateLiveTenantD1Slots(config, lock)
    );
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    env: options.env,
    baseDir,
    configPath,
    lockPath: loadedLock.path,
    lockType: loadedLock.type,
    enabledComponents,
    checks,
  };
}
