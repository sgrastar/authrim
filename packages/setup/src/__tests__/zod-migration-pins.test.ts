/**
 * zod 3 → zod 4 migration pins.
 *
 * The fixture holds what the setup CLI produced under zod 3: parsed values (defaults),
 * the raw issue objects that POST /config and /config/default return, the
 * `{ path, message }` lists of /config/validate, the lock-file error message and the
 * capability-manifest error strings. The zod 4 code must keep producing the same values.
 *
 * Regenerate (only for an intentional change): UPDATE_ZOD_PINS=1 npx vitest run zod-migration-pins
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthrimConfigSchema, createDefaultConfig } from '../core/config.js';
import {
  parseExtensionCapabilityManifest,
  parsePluginWorkerCapabilityManifest,
} from '../core/external-capabilities.js';
import { AuthrimLockSchema, loadLockFile } from '../core/lock.js';
import { ReleaseMigrationManifestSchema } from '../core/release-migrations.js';
import { parseWorkerCapabilityManifest } from '../core/worker-capabilities.js';
import { createApiRoutes, generateSessionToken } from '../web/api.js';
import {
  type LegacyZodIssueSource,
  toLegacyZodIssues,
} from '@authrim/ar-lib-core/utils/zod-legacy-errors';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '__fixtures__', 'zod-migration-pins.json');
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

type Pins = Record<string, unknown>;

function result(parse: () => unknown): unknown {
  try {
    return { ok: parse() };
  } catch (error) {
    if (error && typeof error === 'object' && 'issues' in error) {
      return { issues: (error as { issues: unknown }).issues };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Parse result with issues in the zod 3 shape (what POST /config returns). */
function safe(
  schema: { safeParse: (input: unknown, params: { reportInput: boolean }) => unknown },
  input: unknown
) {
  const parsed = schema.safeParse(input, { reportInput: true }) as
    | { success: true; data: unknown }
    | { success: false; error: { issues: LegacyZodIssueSource[] } };
  return parsed.success ? { ok: parsed.data } : { issues: toLegacyZodIssues(parsed.error.issues) };
}

type Draft = Record<string, unknown>;

/** Set a nested value on a structured clone used as test input. */
function patch(target: Draft, path: string[], value: unknown): void {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Draft;
  }
  cursor[path[path.length - 1]] = value;
}

function configCases(): Record<string, unknown> {
  const base = createDefaultConfig('prod');
  const clone = () => structuredClone(base) as unknown as Draft;

  const wrongTypes = clone();
  patch(wrongTypes, ['version'], 1);
  patch(wrongTypes, ['environment', 'prefix'], '');
  patch(wrongTypes, ['tenant', 'name'], 7);
  patch(wrongTypes, ['tenant', 'userIdFormat'], 'cuid');
  patch(wrongTypes, ['oidc', 'accessTokenTtl'], -5);
  patch(wrongTypes, ['oidc', 'refreshTokenTtl'], 1.5);

  const unknownKeys = clone();
  patch(unknownKeys, ['unexpected'], true);
  patch(unknownKeys, ['features', 'nope'], 1);

  const reservedTenant = clone();
  patch(reservedTenant, ['tenant', 'name'], 'platform');

  const badUrls = clone();
  patch(badUrls, ['urls'], { api: { custom: 'not a url', auto: 'also bad' } });

  const minimal = { environment: { prefix: 'prod' } };

  return {
    default: base,
    minimal,
    empty: {},
    null: null,
    wrongTypes,
    unknownKeys,
    reservedTenant,
    badUrls,
  };
}

function lockCases(): Record<string, unknown> {
  const base: Draft = {
    version: '1.0.0',
    productVersion: '0.4.0',
    env: 'prod',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    d1: { DB: { name: 'prod-authrim-core-db', id: 'core-id' } },
    kv: { SETTINGS: { name: 'prod-settings', id: 'kv-id', previewId: 'kv-preview' } },
    workers: { 'ar-router': { name: 'prod-ar-router' } },
  };
  const clone = () => structuredClone(base);
  const withSecondsless = clone();
  withSecondsless.createdAt = '2026-07-21T10:00Z';
  const withOffset = clone();
  withOffset.updatedAt = '2026-07-21T10:00:00+09:00';
  const nonRfcUuid = clone();
  nonRfcUuid.workers = {
    'ar-router': {
      name: 'prod-ar-router',
      deployedAt: '2026-07-21T00:00:00.000Z',
      cloudflareVersionId: '00000000-0000-0000-0000-00000000000a',
    },
  };
  const partialDns = clone();
  partialDns.dns = {
    api_base: {
      role: 'api_base',
      state: 'managed',
      action: 'adopted',
      operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      zoneId: 'zone',
      recordId: 'rec',
      name: 'api.example.com',
      target: 'example.workers.dev',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
  };
  const badDns = clone();
  badDns.dns = {
    tenant_wildcard: {
      role: 'tenant_wildcard',
      state: 'managed',
      action: 'created',
      operationId: 'not-a-uuid',
      zoneId: '',
      name: '*.example.com',
      target: 'x',
      previous: { id: 'p', type: 'A', name: 'n', content: 'c' },
      updatedAt: 'yesterday',
    },
    bogus: {},
  };
  const badShapes = clone();
  badShapes.d1 = { DB: { id: 1 } };
  badShapes.workerScriptOwnership = {
    'ar-router': { name: 'x', state: 'unknown' },
    'ar-auth': { name: '', state: 'pending_tag', updatedAt: '2026-07-21T00:00:00Z' },
  };
  badShapes.releaseUpdate = {
    targetVersion: '',
    phase: 'done',
    manifestChecksum: 'abc',
    startedAt: '2026-07-21',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
  const minimal = { createdAt: '2026-07-21T00:00:00.000Z', env: 'prod' };

  return {
    base,
    minimal,
    empty: {},
    withSecondsless,
    withOffset,
    nonRfcUuid,
    partialDns,
    badDns,
    badShapes,
  };
}

function manifestCases(): Record<string, unknown> {
  const workerManifest = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'packages', 'ar-management', 'authrim.worker-capabilities.json'),
      'utf8'
    )
  ) as Draft;
  return {
    workerValid: workerManifest,
    workerEmpty: {},
    workerNull: null,
    workerUnknownKey: { ...workerManifest, extra: true },
    workerWrongTypes: { ...workerManifest, worker: 1, packageName: '', bindings: 'x' },
  };
}

async function computeHttpPins(): Promise<Pins> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-zod-pins-')));
  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    await mkdir(join(root, '.authrim'), { recursive: true });
    const token = generateSessionToken();
    const app = createApiRoutes();
    const post = (body: unknown) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(body),
    });
    const http: Pins = {};
    const cases = configCases();
    for (const name of ['empty', 'wrongTypes', 'unknownKeys', 'reservedTenant', 'badUrls']) {
      const validate = await app.request('/config/validate', post(cases[name]));
      http[`validate:${name}`] = { status: validate.status, body: await validate.json() };
      const save = await app.request('/config', post(cases[name]));
      http[`save:${name}`] = { status: save.status, body: await save.json() };
    }
    for (const [name, body] of Object.entries({
      empty: {},
      badEnv: { env: 'BAD ENV' },
      badTypes: { env: 'prod', apiDomain: 1, tenant: 'x', components: [] },
    })) {
      const response = await app.request('/config/default', post(body));
      http[`default:${name}`] = { status: response.status, body: await response.json() };
    }

    const lockDir = join(root, 'locks');
    await mkdir(lockDir, { recursive: true });
    for (const [name, lock] of Object.entries(lockCases())) {
      const path = join(lockDir, `${name}.json`);
      await writeFile(path, JSON.stringify(lock));
      http[`lockFile:${name}`] = await loadLockFile(path).then(
        (value) => ({ ok: value }),
        (error: Error) => ({ error: error.message })
      );
    }
    return http;
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function computePins(): Promise<Pins> {
  const config: Pins = {};
  for (const [name, input] of Object.entries(configCases())) {
    config[name] = safe(AuthrimConfigSchema, input);
  }
  const lock: Pins = {};
  for (const [name, input] of Object.entries(lockCases())) {
    lock[name] = safe(AuthrimLockSchema, input);
  }
  const manifests: Pins = {};
  for (const [name, input] of Object.entries(manifestCases())) {
    manifests[name] = result(() => parseWorkerCapabilityManifest(input));
  }
  for (const [name, input] of Object.entries({
    extensionEmpty: {},
    extensionWrong: { schemaVersion: 2, extensionId: '', requests: 'x', unknown: 1 },
  })) {
    manifests[name] = result(() => parseExtensionCapabilityManifest(input));
  }
  for (const [name, input] of Object.entries({
    pluginEmpty: {},
    pluginWrong: { schemaVersion: 1, pluginId: 'BAD', capabilities: [1], bindings: {} },
  })) {
    manifests[name] = result(() => parsePluginWorkerCapabilityManifest(input));
  }
  const releaseManifest: Pins = {
    empty: safe(ReleaseMigrationManifestSchema, {}),
    wrong: safe(ReleaseMigrationManifestSchema, {
      formatVersion: 3,
      productVersion: 1,
      streams: [{ id: '' }, { id: '' }],
    }),
  };
  return { config, lock, manifests, releaseManifest, http: await computeHttpPins() };
}

/** Stable key order so fixture diffs show only real changes. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

describe('zod migration pins (setup)', () => {
  let pins: Pins;
  let fixture: Pins;

  beforeAll(async () => {
    // createDefaultConfig() stamps createdAt/updatedAt with the current time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    pins = JSON.parse(JSON.stringify(await computePins())) as Pins;
    if (process.env.UPDATE_ZOD_PINS === '1') {
      await mkdir(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(sortKeys(pins), null, 2)}\n`);
    }
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Pins;
  });

  afterAll(() => {
    vi.useRealTimers();
    pins = {};
  });

  for (const section of ['config', 'lock', 'manifests', 'releaseManifest', 'http']) {
    it(`keeps ${section} validation results`, () => {
      expect(pins[section]).toEqual(fixture[section]);
    });
  }
});
