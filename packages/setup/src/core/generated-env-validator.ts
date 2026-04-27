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
import { buildResourceIdsFromLock, parseWranglerToml, validateWranglerConfigs } from './wrangler.js';
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

function isSeededProfile(config: AuthrimConfig, kind: 'storage' | 'audit' | 'residency', id: string): boolean {
  return (config.profiles.seed[kind] ?? []).some((profile) => profile.id === id);
}

function resolveSeededStorageProfile(config: AuthrimConfig, id: string) {
  return (config.profiles.seed.storage ?? []).find((profile) => profile.id === id) ?? null;
}

function resolveSeededAuditProfile(config: AuthrimConfig, id: string) {
  return (config.profiles.seed.audit ?? []).find((profile) => profile.id === id) ?? null;
}

function inspectStorageProfileTarget(
  check: ValidationCheck,
  scope: string,
  target: { driver: string; bindingRef?: string; connectionRef?: string }
): void {
  if (target.connectionRef) {
    pushDetail(
      check,
      'fail',
      `${scope}: connectionRef=${target.connectionRef} は setup 出力だけでは解決されません`
    );
    return;
  }
  if (target.driver !== 'd1') {
    pushDetail(
      check,
      'fail',
      `${scope}: driver=${target.driver} は setup 生成の primary binding だけでは実行できません`
    );
    return;
  }
  if (!target.bindingRef || !BUILTIN_D1_BINDINGS.has(target.bindingRef)) {
    pushDetail(
      check,
      'fail',
      `${scope}: bindingRef=${target.bindingRef ?? '(missing)'} は built-in D1 binding ではありません`
    );
  }
}

function inspectAuditDatabaseTarget(
  check: ValidationCheck,
  scope: string,
  target: { type: string; bindingRef?: string; connectionRef?: string } | null | undefined
): void {
  if (!target) {
    return;
  }
  if (target.connectionRef) {
    pushDetail(
      check,
      'fail',
      `${scope}: connectionRef=${target.connectionRef} は setup 出力だけでは解決されません`
    );
    return;
  }
  if (target.type !== 'd1') {
    pushDetail(
      check,
      'fail',
      `${scope}: type=${target.type} は setup 生成の D1 binding だけでは実行できません`
    );
    return;
  }
  if (!target.bindingRef || !BUILTIN_D1_BINDINGS.has(target.bindingRef)) {
    pushDetail(
      check,
      'fail',
      `${scope}: bindingRef=${target.bindingRef ?? '(missing)'} は built-in D1 binding ではありません`
    );
  }
}

function inspectNonDefaultProfiles(config: AuthrimConfig): ValidationCheck {
  const check = makeCheck(
    'seeded-profile-portability',
    '非デフォルトの seed profile に未解決 backend 依存が残っていない'
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
        pushDetail(
          check,
          'warn',
          `storage profile ${profile.id} / ${slice}: connectionRef=${target.connectionRef}`
        );
        continue;
      }
      if (target.driver !== 'd1') {
        pushDetail(check, 'warn', `storage profile ${profile.id} / ${slice}: driver=${target.driver}`);
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
        pushDetail(
          check,
          'warn',
          `audit profile ${profile.id} / ${label}: connectionRef=${target.connectionRef}`
        );
        continue;
      }
      if (target.type !== 'd1') {
        pushDetail(check, 'warn', `audit profile ${profile.id} / ${label}: type=${target.type}`);
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

  return finishCheck(check, '非デフォルトの seed profile に setup 未解決 backend はありません');
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
  const check = makeCheck('default-profiles', 'default profile 参照が定義済み');
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
    pushDetail(check, 'fail', `${kind}: ${id} は builtin でも seeded profile でもありません`);
  }

  return finishCheck(check, 'default profile 参照はすべて解決できます');
}

function validateActiveProfileCompatibility(config: AuthrimConfig): ValidationCheck {
  const check = makeCheck(
    'active-profile-compatibility',
    'active default profile が setup 出力だけで実行可能'
  );

  if (config.profiles.defaults.storage === 'builtin:storage:external-postgres') {
    pushDetail(
      check,
      'fail',
      'storage default が builtin:storage:external-postgres です。setup は external primary binding を生成しません'
    );
  }

  const seededStorage = resolveSeededStorageProfile(config, config.profiles.defaults.storage);
  if (seededStorage) {
    for (const [slice, target] of Object.entries(seededStorage.slices)) {
      if (!target) {
        continue;
      }
      inspectStorageProfileTarget(check, `storage profile ${seededStorage.id} / ${slice}`, target);
    }
  }

  const seededAudit = resolveSeededAuditProfile(config, config.profiles.defaults.audit);
  if (seededAudit) {
    inspectAuditDatabaseTarget(check, `audit profile ${seededAudit.id} / primary`, seededAudit.primary);
    inspectAuditDatabaseTarget(check, `audit profile ${seededAudit.id} / archive`, seededAudit.archive);
  }

  return finishCheck(check, 'active default profile は setup 出力だけで実行できます');
}

function validateRequiredD1Bindings(lock: AuthrimLock): ValidationCheck {
  const check = makeCheck('lock-d1-bindings', 'lock.json に required D1 binding が揃っている');
  for (const binding of BUILTIN_D1_BINDINGS) {
    if (lock.d1[binding]?.id) {
      pushDetail(check, 'pass', `${binding}: ${lock.d1[binding].id}`);
    } else {
      pushDetail(check, 'fail', `${binding} が lock.json にありません`);
    }
  }
  return finishCheck(check, 'required D1 binding はすべて lock.json にあります');
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
    'deploy wrangler.toml が lock resource と active profile vars に一致する'
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
      pushDetail(check, 'fail', `${component}: packages/${component}/wrangler.toml がありません`);
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
          pushDetail(check, 'fail', `${component}: ${binding} binding が wrangler.toml にありません`);
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
  }

  if (config.profiles.registry.backend === 'kv' && !lock.kv.AUTHRIM_CONFIG?.id) {
    pushDetail(
      check,
      'fail',
      'PROFILE_REGISTRY_BACKEND=kv ですが AUTHRIM_CONFIG namespace が lock.json にありません'
    );
  }

  return finishCheck(check, 'deploy wrangler.toml は lock と active profile vars に一致しています');
}

async function validateMasterWranglers(
  baseDir: string,
  env: string,
  envPaths: EnvironmentPaths,
  packagesDir: string
): Promise<ValidationCheck> {
  const check = makeCheck(
    'master-wranglers',
    '.authrim/{env}/wrangler の master config が package deploy copy と同期している'
  );
  if (!existsSync(envPaths.wrangler)) {
    pushDetail(check, 'fail', `${envPaths.wrangler} がありません`);
    return finishCheck(check, 'master wrangler config は同期しています');
  }

  const statuses = await checkWranglerStatus({ baseDir, env, packagesDir });
  for (const status of statuses) {
    if (!status.masterExists) {
      pushDetail(check, 'fail', `${status.component}: master config がありません`);
      continue;
    }
    if (!status.deployExists) {
      pushDetail(check, 'fail', `${status.component}: deploy copy がありません`);
      continue;
    }
    if (!status.inSync) {
      pushDetail(check, 'fail', `${status.component}: master と deploy copy がズレています`);
      continue;
    }
    pushDetail(check, 'pass', `${status.component}: in sync`);
  }

  return finishCheck(check, 'master wrangler config は package deploy copy と同期しています');
}

export async function validateGeneratedEnvironment(
  options: GeneratedEnvValidationOptions
): Promise<GeneratedEnvValidationResult> {
  const baseDir = resolve(options.baseDir);
  const envPaths = getEnvironmentPaths({ baseDir, env: options.env });
  const configPath = options.configPath ? resolve(options.configPath) : envPaths.config;
  const packagesDir = options.packagesDir ? resolve(options.packagesDir) : join(baseDir, 'packages');

  const configCheck = makeCheck('config', 'config.json を読める');
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
      checks: [finishCheck(configCheck, 'config.json を読めません')],
    };
  }

  const lockCheck = makeCheck('lock', 'lock.json を読める');
  const loadedLock = await loadLockFileAuto(baseDir, options.env);
  if (!loadedLock.lock) {
    pushDetail(lockCheck, 'fail', `${loadedLock.path} がありません`);
    return {
      ok: false,
      env: options.env,
      baseDir,
      configPath,
      lockPath: loadedLock.path,
      lockType: loadedLock.type,
      enabledComponents: [],
      checks: [finishCheck(configCheck, 'config.json を読めます'), finishCheck(lockCheck, 'lock.json を読めません')],
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
    finishCheck(configCheck, 'config.json を読めます'),
    finishCheck(lockCheck, 'lock.json を読めます'),
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
