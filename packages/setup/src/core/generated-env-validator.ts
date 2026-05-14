import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  AUTHRIM_DIR,
  findAuthrimBaseDir,
  getEnvironmentPaths,
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
import {
  CORE_WORKER_COMPONENTS,
  D1_DATABASES,
  getEnabledComponents,
  type WorkerComponent,
} from './naming.js';

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

const BUILTIN_D1_BINDINGS: Set<string> = new Set(D1_DATABASES.map((db) => db.binding));

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
      'storage profile builtin:storage:external-postgres / users_core',
      {
        driver: 'postgres',
        connectionRef: 'core-primary',
      }
    );
    inspectStorageProfileTarget(
      config,
      check,
      'storage profile builtin:storage:external-postgres / users_pii',
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
    buildResourceIdsFromLock(lock),
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
      for (const binding of BUILTIN_D1_BINDINGS) {
        if (!parsed.d1[binding]) {
          pushDetail(
            check,
            'fail',
            `${component}: ${binding} binding is missing from wrangler.toml`
          );
        }
      }
    }

    const expectedImportArtifacts = lock.r2?.IMPORT_ARTIFACTS?.name;
    if (component === 'ar-management' && expectedImportArtifacts) {
      if (parsed.r2.IMPORT_ARTIFACTS !== expectedImportArtifacts) {
        pushDetail(
          check,
          'fail',
          `${component}: IMPORT_ARTIFACTS expected=${expectedImportArtifacts} actual=${parsed.r2.IMPORT_ARTIFACTS ?? '(missing)'}`
        );
      }
    }

    const expectedExportArtifacts = lock.r2?.EXPORT_ARTIFACTS?.name;
    if (component === 'ar-management' && expectedExportArtifacts) {
      if (parsed.r2.EXPORT_ARTIFACTS !== expectedExportArtifacts) {
        pushDetail(
          check,
          'fail',
          `${component}: EXPORT_ARTIFACTS expected=${expectedExportArtifacts} actual=${parsed.r2.EXPORT_ARTIFACTS ?? '(missing)'}`
        );
      }
    }

    const expectedSensitiveDetails = lock.r2?.SENSITIVE_DETAILS?.name;
    if (component === 'ar-management' && expectedSensitiveDetails) {
      if (parsed.r2.SENSITIVE_DETAILS !== expectedSensitiveDetails) {
        pushDetail(
          check,
          'fail',
          `${component}: SENSITIVE_DETAILS expected=${expectedSensitiveDetails} actual=${parsed.r2.SENSITIVE_DETAILS ?? '(missing)'}`
        );
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

    const expectedHyperdrive = Object.values(config.profiles.references?.hyperdrive ?? {});
    if (component !== 'ar-router' && expectedHyperdrive.length > 0) {
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
    validateDefaultProfileReferences(config),
    validateActiveProfileCompatibility(config),
    inspectNonDefaultProfiles(config),
    await validateDeployWranglers(baseDir, options.env, config, lock, packagesDir),
    await validateMasterWranglers(baseDir, options.env, envPaths, packagesDir),
  ];

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
