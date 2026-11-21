/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- fakes and deliberately malformed inputs are intentionally untyped */
import { SAML_DR_RUNTIME_STATE_DATASET } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import { generateVersion } from '@authrim/ar-lib-core';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';

const ctl = vi.hoisted(() => ({
  lstatHook: null as null | ((path: string, count: number, stat: unknown) => unknown),
  lstatCounts: new Map<string, number>(),
  pinnedHook: null as null | ((path: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string, options: never) => {
      const stat = await actual.lstat(path, options);
      const count = (ctl.lstatCounts.get(path) ?? 0) + 1;
      ctl.lstatCounts.set(path, count);
      return ctl.lstatHook ? ctl.lstatHook(path, count, stat) : stat;
    },
  };
});
vi.mock('./restore-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./restore-evidence')>();
  return {
    ...actual,
    readPinnedRestoreFile: async (path: string, sha: string, max: number) => {
      if (ctl.pinnedHook) await ctl.pinnedHook(path);
      return actual.readPinnedRestoreFile(path, sha, max);
    },
  };
});

import { canonicalRestoreJson } from './restore-evidence';
import {
  buildAwsSamlSupplementFromFrozenCapture,
  collectAwsSamlSupplementFromBackup,
  collectAwsSamlSupplementFromPinnedCapture,
  readEmbeddedSamlDrCapture,
  type AwsSamlFrozenSourceCapture,
} from './supplement-collector';

const INVALID = 'aws_supplement_collector_invalid';

const TENANT = 'tenant-a';
const ORIGIN = 'https://tenant-a.example.test';
const NOW = 1_700_000_000_000;
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: TENANT, issuer: ORIGIN, productVersion: '0.4.2' },
  snapshotId: 'snapshot-a',
  boundaryUnixMs: NOW,
  inventoryDigestSha256: 'b'.repeat(64),
  selection: {
    settings: true,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 },
  },
  datasets: [
    {
      id: 'core.users_core',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
    {
      id: 'core.identity_accounts',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
    {
      id: 'core.passkeys',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
  ],
};

const textCell = (value: string): ['text', string] => ['text', value];
const integerCell = (value: number): ['integer', string] => ['integer', String(value)];
const nullCell = (): ['null', null] => ['null', null];

const sourceRows: Record<string, PortableSqliteRow[]> = {
  'core.users_core': [{ tenant_id: textCell(TENANT), id: textCell('user-1') }],
  'core.identity_accounts': [
    {
      tenant_id: textCell(TENANT),
      id: textCell('account:user-1'),
      account_type: textCell('user'),
      legacy_user_id: textCell('user-1'),
      lifecycle_state: textCell('active'),
      directory_publication_state: textCell('active'),
      account_route_generation: integerCell(1),
    },
  ],
  'core.passkeys': [
    {
      tenant_id: textCell(TENANT),
      id: textCell('passkey-1'),
      user_id: textCell('user-1'),
      credential_id: textCell('credential-1'),
      counter: integerCell(5),
    },
  ],
};

function backup(): VerifiedTenantBackupV2 {
  return {
    manifest,
    dataset(id) {
      const rows = sourceRows[id];
      if (!rows) throw new Error('unknown_dataset');
      return {
        id,
        rows: rows.length,
        bytes: 0,
        readNextRow: async (cursor) => {
          const index = cursor === null ? 0 : Number(cursor);
          return index < rows.length
            ? { rowJson: JSON.stringify(rows[index]), nextCursor: String(index + 1) }
            : null;
        },
      };
    },
    close: async () => undefined,
  };
}

function capture(): AwsSamlFrozenSourceCapture {
  return {
    formatVersion: 1,
    source: {
      source: { ...manifest.source },
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      boundaryUnixMs: manifest.boundaryUnixMs,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
    },
    completeness: {
      accountAuthStates: true,
      passkeyCounters: true,
      persistentNameIds: true,
      sourceLoginUi: true,
      platformDestinationProfiles: true,
      accountRoutes: true,
      platformSettings: true,
      sourceRuntimeSettings: true,
    },
    payload: {
      sourceLoginUi: {
        client: {
          tenant_id: textCell(TENANT),
          client_id: textCell('login-ui'),
          application_type: textCell('web'),
          client_secret_hash: nullCell(),
          logout_webhook_secret_encrypted: nullCell(),
          allowed_channels: textCell('["browser"]'),
        },
        origins: [
          {
            tenant_id: textCell(TENANT),
            client_id: textCell('login-ui'),
            origin: textCell(ORIGIN),
            handoff_allowed: integerCell(1),
            is_active: integerCell(1),
          },
        ],
      },
      platformDestinationProfiles: { profiles: [], versions: [] },
      state: {
        accountAuthStates: [
          {
            tenantId: TENANT,
            userId: 'user-1',
            accountId: 'account:user-1',
            lifecycle: 'active',
            lifecycleVersionMs: NOW - 2000,
            lifecycleOperationId: null,
            revokedAfterMs: null,
            lastLoginAtMs: NOW - 1000,
          },
        ],
        passkeyCounters: [
          {
            tenantId: TENANT,
            passkeyId: 'passkey-1',
            userId: 'user-1',
            credentialId: 'credential-1',
            counter: '5',
            updatedAtMs: NOW - 1000,
          },
        ],
        persistentNameIdsComplete: true,
        persistentNameIds: [],
      },
      accountRoutes: {
        'account:user-1': {
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: 'default',
          targets: [
            {
              dataRole: 'tenant_core/users',
              residencyPartition: 'global',
              shardId: 'core-1',
              bindingRef: 'TEST_CORE',
              requiredBindingRouteGeneration: 1,
            },
            {
              dataRole: 'tenant_pii',
              residencyPartition: 'global',
              shardId: 'pii-1',
              bindingRef: 'TEST_PII',
              requiredBindingRouteGeneration: 1,
            },
          ],
        },
      },
      platformSettings: {},
      sourceFlowRuntimeEnabled: true,
      consentIpSalt: 'synthetic-salt-long-enough-for-collector-test',
    },
  };
}

function embeddedBackup(
  value: AwsSamlFrozenSourceCapture = capture(),
  tenantId = TENANT,
  raw?: string
): VerifiedTenantBackupV2 {
  const source = backup();
  const row = canonicalRestoreJson({
    tenant_id: textCell(tenantId),
    capture_json: textCell(raw ?? canonicalRestoreJson(value)),
  });
  return {
    ...source,
    manifest: { ...manifest, datasets: [...manifest.datasets, SAML_DR_RUNTIME_STATE_DATASET] },
    dataset(id) {
      if (id !== SAML_DR_RUNTIME_STATE_DATASET.id) return source.dataset(id);
      return {
        id,
        rows: 1,
        bytes: new TextEncoder().encode(row).byteLength,
        readNextRow: async (cursor) => (cursor === null ? { rowJson: row, nextCursor: '1' } : null),
      };
    },
  };
}

const directories: string[] = [];
beforeEach(() => {
  ctl.lstatHook = null;
  ctl.lstatCounts.clear();
  ctl.pinnedHook = null;
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'authrim-collector-mut-')));
  directories.push(directory);
  return directory;
}

type Mutator = (c: any) => void;
async function build(mutate: Mutator, b: VerifiedTenantBackupV2 = backup()) {
  const c = capture();
  mutate(c);
  return buildAwsSamlSupplementFromFrozenCapture({ backup: b, capture: c });
}
const ui = (c: any) => c.payload.sourceLoginUi;

describe('capture identity', () => {
  it('accepts the baseline capture', async () => {
    await expect(build(() => undefined)).resolves.toMatchObject({ formatVersion: 1 });
  });
  it.each<[string, Mutator]>([
    ['extra top key', (c) => (c.extra = 1)],
    ['missing payload', (c) => delete c.payload],
    ['extra source key', (c) => (c.source.extra = 1)],
    ['extra source.source key', (c) => (c.source.source.extra = 1)],
    ['extra completeness key', (c) => (c.completeness.extra = true)],
    ['formatVersion 2', (c) => (c.formatVersion = 2)],
    ['bundleId', (c) => (c.source.bundleId = 'c'.repeat(32))],
    ['snapshotId', (c) => (c.source.snapshotId = 'x')],
    ['boundaryUnixMs', (c) => (c.source.boundaryUnixMs += 1)],
    ['inventoryDigest', (c) => (c.source.inventoryDigestSha256 = 'c'.repeat(64))],
    ['tenantId', (c) => (c.source.source.tenantId = 'tenant-b')],
    ['issuer', (c) => (c.source.source.issuer = 'https://other.example.test')],
    ['productVersion', (c) => (c.source.source.productVersion = '9.9.9')],
    ['completeness false', (c) => (c.completeness.accountRoutes = false)],
    ['completeness truthy non-true', (c) => (c.completeness.platformSettings = 1)],
  ])('rejects %s', async (_n, mutate) => {
    await expect(build(mutate)).rejects.toThrow(new Error(INVALID));
  });
  it('rejects a selection without settings or users', async () => {
    for (const key of ['settings', 'users'] as const) {
      const b = backup();
      const m = { ...manifest, selection: { ...manifest.selection, [key]: false } };
      await expect(build(() => undefined, { ...b, manifest: m })).rejects.toThrow(INVALID);
    }
  });
});

describe('payload validation', () => {
  it.each<[string, Mutator]>([
    ['extra payload key', (c) => (c.payload.extra = 1)],
    ['missing consentIpSalt', (c) => delete c.payload.consentIpSalt],
    ['extra destination key', (c) => (c.payload.platformDestinationProfiles.extra = 1)],
    ['extra state key', (c) => (c.payload.state.extra = 1)],
    ['flow enabled not boolean', (c) => (c.payload.sourceFlowRuntimeEnabled = 'yes')],
    ['profiles not array', (c) => (c.payload.platformDestinationProfiles.profiles = {})],
    ['versions not array', (c) => (c.payload.platformDestinationProfiles.versions = {})],
    ['salt not string', (c) => (c.payload.consentIpSalt = 5)],
    ['salt 31 chars', (c) => (c.payload.consentIpSalt = 's'.repeat(31))],
    ['pairwise secret not string', (c) => (c.payload.sourcePairwiseFallbackSecret = 5)],
    ['pairwise secret 31 chars', (c) => (c.payload.sourcePairwiseFallbackSecret = 's'.repeat(31))],
  ])('rejects %s', async (_n, mutate) => {
    await expect(build(mutate)).rejects.toThrow(new Error(INVALID));
  });
  it('accepts the minimum salt and pairwise secret length and keeps them in the payload', async () => {
    const result = await build((c) => {
      c.payload.consentIpSalt = 's'.repeat(32);
      c.payload.sourcePairwiseFallbackSecret = 'p'.repeat(32);
    });
    expect(result.payload.consentIpSalt).toBe('s'.repeat(32));
    expect(result.payload.sourcePairwiseFallbackSecret).toBe('p'.repeat(32));
    expect(result.payload.sourceFlowRuntimeEnabled).toBe(true);
  });
  it('fills the receipt from the manifest and a payload digest', async () => {
    const result = await build(() => undefined);
    expect(result.receipt).toEqual({
      tenantId: TENANT,
      issuer: ORIGIN,
      productVersion: '0.4.2',
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.payload.state.receipt).toMatchObject({
      tenantId: TENANT,
      issuer: ORIGIN,
      productVersion: '0.4.2',
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
    });
    expect(result.payload.state.receipt.supplementSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.payload.state.receipt.supplementSha256).not.toBe(result.receipt.supplementSha256);
  });
});

describe('source login UI', () => {
  it.each<[string, Mutator]>([
    ['null ui', (c) => (c.payload.sourceLoginUi = null)],
    ['mode with extra key', (c) => (c.payload.sourceLoginUi = { mode: 'disabled', x: 1 })],
    ['mode enabled', (c) => (c.payload.sourceLoginUi = { mode: 'enabled' })],
    ['ui extra key', (c) => (ui(c).extra = 1)],
    ['origins not array', (c) => (ui(c).origins = {})],
    ['no origins', (c) => (ui(c).origins = [])],
    ['two origins', (c) => (ui(c).origins = [ui(c).origins[0], ui(c).origins[0]])],
    ['client tenant', (c) => (ui(c).client.tenant_id = ['text', 'other'])],
    ['client id invalid char', (c) => (ui(c).client.client_id = ['text', 'a b'])],
    ['client id empty', (c) => (ui(c).client.client_id = ['text', ''])],
    ['client id leading junk', (c) => (ui(c).client.client_id = ['text', '/a'])],
    ['client id too long', (c) => (ui(c).client.client_id = ['text', 'a'.repeat(129)])],
    ['application type', (c) => (ui(c).client.application_type = ['text', 'native'])],
    ['client secret hash set', (c) => (ui(c).client.client_secret_hash = ['text', 'h'])],
    ['logout secret set', (c) => (ui(c).client.logout_webhook_secret_encrypted = ['text', 'h'])],
    ['origin tenant', (c) => (ui(c).origins[0].tenant_id = ['text', 'other'])],
    ['origin client id', (c) => (ui(c).origins[0].client_id = ['text', 'another'])],
    ['origin http', (c) => (ui(c).origins[0].origin = ['text', 'http://tenant-a.example.test'])],
    ['origin with path', (c) => (ui(c).origins[0].origin = ['text', `${ORIGIN}/x`])],
    ['handoff disabled', (c) => (ui(c).origins[0].handoff_allowed = ['integer', '0'])],
    ['inactive origin', (c) => (ui(c).origins[0].is_active = ['integer', '0'])],
    ['channels not array', (c) => (ui(c).client.allowed_channels = ['text', '{"browser":1}'])],
    ['channels without browser', (c) => (ui(c).client.allowed_channels = ['text', '["api"]'])],
    ['channels invalid json', (c) => (ui(c).client.allowed_channels = ['text', '['])],
  ])('rejects %s', async (_n, mutate) => {
    await expect(build(mutate)).rejects.toThrow(new Error(INVALID));
  });
  it('accepts a 128-char client id with allowed punctuation and multiple channels', async () => {
    const id = 'a.b:c_d-' + 'x'.repeat(120);
    await expect(
      build((c) => {
        ui(c).client.client_id = ['text', id];
        ui(c).origins[0].client_id = ['text', id];
        ui(c).client.allowed_channels = ['text', '["api","browser"]'];
      })
    ).resolves.toBeDefined();
  });
});

describe('platform settings', () => {
  const entry = (doc: unknown) => {
    const documentJson = JSON.stringify(doc);
    return { documentJson, version: generateVersion(doc as Record<string, unknown>) };
  };
  it('accepts correctly versioned platform settings', async () => {
    const result = await build((c) => {
      c.payload.platformSettings = { 'login-ui_1': entry({ a: 1 }) };
    });
    expect(Object.keys(result.payload.platformSettings)).toEqual(['login-ui_1']);
  });
  it.each<[string, Mutator]>([
    ['null settings', (c) => (c.payload.platformSettings = null)],
    ['array settings', (c) => (c.payload.platformSettings = [])],
    ['entry extra key', (c) => (c.payload.platformSettings = { a: { ...entry({}), x: 1 } })],
    ['entry missing version', (c) => (c.payload.platformSettings = { a: { documentJson: '{}' } })],
    ['category with space', (c) => (c.payload.platformSettings = { 'a b': entry({}) })],
    ['category with colon', (c) => (c.payload.platformSettings = { 'a:b': entry({}) })],
    ['category too long', (c) => (c.payload.platformSettings = { ['a'.repeat(129)]: entry({}) })],
    [
      'documentJson not string',
      (c) => (c.payload.platformSettings = { a: { documentJson: {}, version: 'x' } }),
    ],
    [
      'document null',
      (c) => (c.payload.platformSettings = { a: { documentJson: 'null', version: 'x' } }),
    ],
    [
      'document array',
      (c) => (c.payload.platformSettings = { a: { documentJson: '[]', version: 'x' } }),
    ],
    [
      'document number',
      (c) => (c.payload.platformSettings = { a: { documentJson: '5', version: 'x' } }),
    ],
    [
      'document invalid json',
      (c) => (c.payload.platformSettings = { a: { documentJson: '{', version: 'x' } }),
    ],
    [
      'wrong version',
      (c) => (c.payload.platformSettings = { a: { documentJson: '{"a":1}', version: 'sha256:0' } }),
    ],
  ])('rejects %s', async (_n, mutate) => {
    await expect(build(mutate)).rejects.toThrow(new Error(INVALID));
  });
  it('accepts a 128-char category', async () => {
    const category = 'a'.repeat(128);
    await expect(
      build((c) => (c.payload.platformSettings = { [category]: entry({}) }))
    ).resolves.toBeDefined();
  });
});

describe('account routes', () => {
  const route = (c: any) => c.payload.accountRoutes['account:user-1'];
  it.each<[string, Mutator]>([
    ['null routes', (c) => (c.payload.accountRoutes = null)],
    ['array routes', (c) => (c.payload.accountRoutes = [])],
    ['no routes', (c) => (c.payload.accountRoutes = {})],
    ['extra route', (c) => (c.payload.accountRoutes['account:zzz'] = route(c))],
    ['wrong generation', (c) => (route(c).accountRouteGeneration = 2)],
    ['one target', (c) => route(c).targets.pop()],
    ['three targets', (c) => route(c).targets.push({ ...route(c).targets[0] })],
    ['duplicate pii role', (c) => (route(c).targets[0].dataRole = 'tenant_pii')],
    ['duplicate core role', (c) => (route(c).targets[1].dataRole = 'tenant_core/users')],
    ['invalid projection', (c) => (c.payload.accountRoutes['account:user-1'] = {})],
  ])('rejects %s', async (_n, mutate) => {
    await expect(build(mutate)).rejects.toThrow(new Error(INVALID));
  });
  it('rejects when a source account row is unreadable', async () => {
    const b = backup();
    const dataset = b.dataset.bind(b);
    await expect(
      build(() => undefined, {
        ...b,
        dataset: (id) =>
          id === 'core.identity_accounts' ? { ...dataset(id), rows: 5 } : dataset(id),
      })
    ).rejects.toThrow(INVALID);
  });
});

describe('embedded capture', () => {
  it('reads the capture and requests the installed dataset exactly', async () => {
    const input = embeddedBackup();
    const spy = vi.spyOn(input, 'dataset');
    await expect(readEmbeddedSamlDrCapture(input)).resolves.toEqual(capture());
    expect(spy).toHaveBeenCalledWith(SAML_DR_RUNTIME_STATE_DATASET.id);
  });
  it.each(['id', 'module', 'kind', 'store', 'schemaVersion', 'disposition'])(
    'rejects a descriptor with a different %s',
    async (key) => {
      const input = embeddedBackup();
      input.manifest.datasets = [
        ...manifest.datasets,
        {
          ...SAML_DR_RUNTIME_STATE_DATASET,
          [key]: key === 'schemaVersion' ? 99 : 'other',
        },
      ];
      await expect(readEmbeddedSamlDrCapture(input)).rejects.toThrow(INVALID);
    }
  );
  it('rejects a duplicated dataset entry', async () => {
    const input = embeddedBackup();
    input.manifest.datasets = [...input.manifest.datasets, SAML_DR_RUNTIME_STATE_DATASET];
    await expect(readEmbeddedSamlDrCapture(input)).rejects.toThrow(INVALID);
  });
  const withDataset = (patch: Record<string, unknown>) => {
    const input = embeddedBackup();
    const original = input.dataset.bind(input);
    input.dataset = (id) => ({ ...original(id), ...patch });
    return input;
  };
  it('rejects zero rows, oversized bytes, and an empty next cursor', async () => {
    await expect(readEmbeddedSamlDrCapture(withDataset({ rows: 0 }))).rejects.toThrow(INVALID);
    await expect(
      readEmbeddedSamlDrCapture(withDataset({ bytes: 256 * 1024 * 1024 + 1 }))
    ).rejects.toThrow(INVALID);
    await expect(
      readEmbeddedSamlDrCapture(
        withDataset({
          readNextRow: async (c: string | null) =>
            c === null ? { rowJson: '{}', nextCursor: '' } : null,
        })
      )
    ).rejects.toThrow(INVALID);
    await expect(
      readEmbeddedSamlDrCapture(withDataset({ readNextRow: async () => null }))
    ).rejects.toThrow(INVALID);
  });
  it('accepts bytes exactly at the limit', async () => {
    const input = embeddedBackup();
    const original = input.dataset.bind(input);
    input.dataset = (id) => ({ ...original(id), bytes: 256 * 1024 * 1024 });
    await expect(readEmbeddedSamlDrCapture(input)).resolves.toEqual(capture());
  });
  it('rejects a second row', async () => {
    const input = embeddedBackup();
    const original = input.dataset.bind(input);
    const row = canonicalRestoreJson({
      tenant_id: textCell(TENANT),
      capture_json: textCell(canonicalRestoreJson(capture())),
    });
    input.dataset = (id) => ({
      ...original(id),
      readNextRow: async (c: string | null) => ({
        rowJson: row,
        nextCursor: c === null ? '1' : '2',
      }),
    });
    await expect(readEmbeddedSamlDrCapture(input)).rejects.toThrow(INVALID);
  });
  it.each<[string, string]>([
    [
      'extra column',
      JSON.stringify({
        tenant_id: textCell(TENANT),
        capture_json: textCell('{}'),
        x: textCell(''),
      }),
    ],
    [
      'non-text capture',
      JSON.stringify({ tenant_id: textCell(TENANT), capture_json: integerCell(1) }),
    ],
    [
      'invalid capture json',
      JSON.stringify({ tenant_id: textCell(TENANT), capture_json: textCell('{') }),
    ],
  ])('rejects %s', async (_n, rowJson) => {
    const input = embeddedBackup();
    const original = input.dataset.bind(input);
    input.dataset = (id) => ({
      ...original(id),
      readNextRow: async (c: string | null) => (c === null ? { rowJson, nextCursor: '1' } : null),
    });
    await expect(readEmbeddedSamlDrCapture(input)).rejects.toThrow(INVALID);
  });
  it('rejects a capture that fails identity checks even when canonical', async () => {
    const value = capture();
    value.completeness.accountRoutes = false as never;
    await expect(readEmbeddedSamlDrCapture(embeddedBackup(value))).rejects.toThrow(INVALID);
  });
});

describe('pinned capture collection', () => {
  async function setup(mode = 0o600, content = canonicalRestoreJson(capture())) {
    const directory = await tmp();
    const capturePath = join(directory, 'source.json');
    await writeFile(capturePath, content);
    await chmod(capturePath, mode);
    return {
      directory,
      capturePath,
      sha: createHash('sha256').update(content).digest('hex'),
      outputPath: join(directory, 'out.json'),
    };
  }
  const run = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) =>
    collectAwsSamlSupplementFromPinnedCapture({
      backup: backup(),
      capturePath: s.capturePath,
      expectedCaptureSha256: s.sha,
      outputPath: s.outputPath,
      ...extra,
    });

  it('returns a complete receipt matching the written file', async () => {
    const s = await setup();
    const receipt = await run(s);
    const written = await readFile(s.outputPath);
    expect(receipt.outputPath).toBe(s.outputPath);
    expect(receipt.outputSha256).toBe(createHash('sha256').update(written).digest('hex'));
    expect(receipt).toMatchObject({
      tenantId: TENANT,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      accountAuthStates: 1,
      passkeyCounters: 1,
      persistentNameIds: 0,
    });
    expect(receipt.supplementSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it.each([
    ['uppercase', (h: string) => h.toUpperCase()],
    ['short', (h: string) => h.slice(1)],
    ['long', (h: string) => `${h}0`],
    ['non-hex', (h: string) => `g${h.slice(1)}`],
    ['prefixed', (h: string) => `x${h}`],
    ['suffixed', (h: string) => `${h}\n`],
  ])('rejects a %s expected hash before touching the file', async (_n, f) => {
    const s = await setup();
    await expect(run(s, { expectedCaptureSha256: f(s.sha) })).rejects.toThrow(INVALID);
    expect(ctl.lstatCounts.get(s.capturePath)).toBeUndefined();
  });
  it('rejects a wrong hash and a non-canonical capture', async () => {
    const s = await setup();
    await expect(run(s, { expectedCaptureSha256: 'f'.repeat(64) })).rejects.toThrow(INVALID);
    const pretty = await setup(0o600, JSON.stringify(capture(), null, 2));
    await expect(run(pretty)).rejects.toThrow(INVALID);
  });
  it.each([0o640, 0o604, 0o620, 0o602, 0o610, 0o601])('rejects mode %o', async (mode) => {
    const s = await setup(mode);
    await expect(run(s)).rejects.toThrow(INVALID);
  });
  it('accepts owner-only modes such as 0400', async () => {
    const s = await setup(0o400);
    await expect(run(s)).resolves.toBeDefined();
  });
  it('rejects a directory as capture path', async () => {
    const s = await setup();
    await expect(run(s, { capturePath: s.directory })).rejects.toThrow(INVALID);
  });
  it.each([
    [
      'inode',
      (st: any) =>
        Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1n }),
    ],
    [
      'device',
      (st: any) =>
        Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1n }),
    ],
    [
      'mode',
      (st: any) =>
        Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: st.mode | 0o1n }),
    ],
  ])('rejects a capture whose %s changes while being read', async (_n, tamper) => {
    const s = await setup();
    ctl.lstatHook = (path, count, st) => (path === s.capturePath && count === 2 ? tamper(st) : st);
    await expect(run(s)).rejects.toThrow(INVALID);
    expect(ctl.lstatCounts.get(s.capturePath)).toBeGreaterThanOrEqual(2);
  });
  it('rejects capture build failures', async () => {
    const bad = capture();
    bad.source.snapshotId = 'x';
    const s = await setup(0o600, canonicalRestoreJson(bad));
    await expect(run(s)).rejects.toThrow(INVALID);
  });
});

describe('supplement output writing', () => {
  async function dir() {
    const directory = await tmp();
    return { directory, outputPath: join(directory, 'out.json') };
  }
  const collect = (outputPath: string) =>
    collectAwsSamlSupplementFromBackup({ backup: embeddedBackup(), outputPath });

  it('writes mode 0600 and a pinned file whose receipt matches', async () => {
    const { outputPath } = await dir();
    const receipt = await collect(outputPath);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(receipt.outputPath).toBe(outputPath);
  });
  it.each([
    ['relative', () => 'out.json'],
    ['non-normalized', (d: string) => `${d}/sub/../out.json`],
    ['trailing dot segment', (d: string) => `${d}/./out.json`],
    ['double slash', (d: string) => `${d}//out.json`],
  ])('rejects a %s output path', async (_n, make) => {
    const { directory } = await dir();
    await expect(collect(make(directory))).rejects.toThrow(INVALID);
  });
  it('rejects an output directory reached through a symbolic link', async () => {
    const { directory } = await dir();
    const real = join(directory, 'real');
    await mkdir(real);
    const linked = join(directory, 'linked');
    await symlink(real, linked);
    await expect(collect(join(linked, 'out.json'))).rejects.toThrow(INVALID);
    await expect(readFile(join(real, 'out.json'))).rejects.toThrow();
  });
  it('rejects a missing directory and refuses to follow a symlink output', async () => {
    const { directory } = await dir();
    await expect(collect(join(directory, 'missing', 'out.json'))).rejects.toThrow(INVALID);
    const target = join(directory, 'target.json');
    await writeFile(target, 'keep');
    const outputPath = join(directory, 'out.json');
    await symlink(target, outputPath);
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
    expect(await readFile(target, 'utf8')).toBe('keep');
  });
  it('removes the file it created when verification fails afterwards', async () => {
    const { outputPath } = await dir();
    ctl.pinnedHook = async (path) => {
      if (path === outputPath) throw new Error('verify failed');
    };
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
    await expect(stat(outputPath)).rejects.toThrow();
  });
  it('does not remove a replaced file at the output path', async () => {
    const { directory, outputPath } = await dir();
    const other = join(directory, 'other.json');
    await writeFile(other, 'someone else');
    ctl.pinnedHook = async (path) => {
      if (path !== outputPath) return;
      await rename(other, outputPath);
      throw new Error('verify failed');
    };
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
    expect(await readFile(outputPath, 'utf8')).toBe('someone else');
  });
  it('does not remove a file with the same inode number on another device or different inode only', async () => {
    const { directory, outputPath } = await dir();
    const alias = join(directory, 'alias.json');
    ctl.pinnedHook = async (path) => {
      if (path !== outputPath) return;
      await link(outputPath, alias);
      throw new Error('verify failed');
    };
    // A hard link shares dev+ino, so the created file is removed from outputPath but the alias remains.
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
    await expect(stat(outputPath)).rejects.toThrow();
    expect((await stat(alias)).size).toBeGreaterThan(0);
  });
  it('tolerates the output disappearing before cleanup', async () => {
    const { outputPath } = await dir();
    ctl.pinnedHook = async (path) => {
      if (path !== outputPath) return;
      await unlink(outputPath);
      throw new Error('verify failed');
    };
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
  });
  it('differentiates dev and ino when deciding whether to clean up', async () => {
    const { outputPath } = await dir();
    ctl.pinnedHook = async (path) => {
      if (path !== outputPath) return;
      ctl.lstatHook = (p, _count, st: any) =>
        p === outputPath
          ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1n })
          : st;
      throw new Error('verify failed');
    };
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });
  it('differentiates ino when deciding whether to clean up', async () => {
    const { outputPath } = await dir();
    ctl.pinnedHook = async (path) => {
      if (path !== outputPath) return;
      ctl.lstatHook = (p, _count, st: any) =>
        p === outputPath
          ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1n })
          : st;
      throw new Error('verify failed');
    };
    await expect(collect(outputPath)).rejects.toThrow(INVALID);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });
});
