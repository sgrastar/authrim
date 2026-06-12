import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type {
  DatabaseAdapter,
  Env,
  ExecuteResult,
  HealthStatus,
  TransactionContext,
} from '@authrim/ar-lib-core';
import {
  adminPersistentIdentifierProfileCreateHandler,
  adminPersistentIdentifierProfileDeleteHandler,
  adminPersistentIdentifierProfileGetHandler,
  adminPersistentIdentifierPreviewHandler,
  adminPersistentIdentifierProfilesListHandler,
} from '../persistent-identifier-profiles';

interface RecordedExecute {
  sql: string;
  params: unknown[];
}

function createAdapter(options: {
  queryRows?: Record<string, unknown>[];
  queryRowSets?: Record<string, unknown>[][];
}): DatabaseAdapter & { executes: RecordedExecute[] } {
  const executes: RecordedExecute[] = [];
  const queryRows = [...(options.queryRows ?? [])];
  const queryRowSets = [...(options.queryRowSets ?? [])];
  const executeResult: ExecuteResult = { rowsAffected: 1, success: true };
  return {
    executes,
    async query<T>(): Promise<T[]> {
      if (queryRowSets.length > 0) {
        return queryRowSets.shift() as T[];
      }
      return queryRows as T[];
    },
    async queryOne<T>(): Promise<T | null> {
      return null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
      executes.push({ sql, params });
      return executeResult;
    },
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async batch(): Promise<ExecuteResult[]> {
      return [];
    },
    async isHealthy(): Promise<HealthStatus> {
      return { healthy: true, latencyMs: 1, type: 'test' };
    },
    getType(): string {
      return 'test';
    },
    async close(): Promise<void> {},
  };
}

function createApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/profiles', adminPersistentIdentifierProfilesListHandler);
  app.get('/profiles/:profileId', adminPersistentIdentifierProfileGetHandler);
  app.post('/profiles', adminPersistentIdentifierProfileCreateHandler);
  app.delete('/profiles/:profileId', adminPersistentIdentifierProfileDeleteHandler);
  app.post('/profiles/preview', adminPersistentIdentifierPreviewHandler);
  return { app, env: env as Env };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'persistent_identifier_profile_1',
    tenant_id: 'default',
    profile_key: 'default_pairwise',
    display_name: 'Default pairwise',
    description: null,
    mode: 'computed',
    algorithm: 'authrim_sha256_base64url',
    protocol_scope: 'any',
    usage_json: JSON.stringify(['saml_edu_person_targeted_id', 'oidc_pairwise_sub']),
    source_ref_json: null,
    secret_ref: 'tenant:default:saml:pairwise-nameid',
    issuer_entity_id: 'https://idp.example.edu/idp/shibboleth',
    audience_mode: 'runtime',
    format_json: '{}',
    lifecycle_state: 'active',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe('persistent identifier profiles admin API', () => {
  it('lists profiles without exposing secret material', async () => {
    const adapter = createAdapter({ queryRows: [profileRow()] });
    const { app, env } = createApp({ DB_ADMIN: adapter as unknown as Env['DB_ADMIN'] });

    const response = await app.request('/profiles', {}, env);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      profiles: [
        {
          id: 'persistent_identifier_profile_1',
          displayName: 'Default pairwise',
          secretRef: 'tenant:default:saml:pairwise-nameid',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  it('creates a computed profile with a tenant-scoped default secret ref', async () => {
    const adapter = createAdapter({});
    const keyManager = {
      getOrCreateSecretRpc: async () => ({
        active: { value: 'secret-value' },
      }),
    };
    const keyManagerNamespace = {
      idFromName: (name: string) => name,
      get: () => keyManager,
    };
    const { app, env } = createApp({
      DB_ADMIN: adapter as unknown as Env['DB_ADMIN'],
      KEY_MANAGER: keyManagerNamespace as unknown as Env['KEY_MANAGER'],
    });

    const response = await app.request(
      '/profiles',
      {
        method: 'POST',
        body: JSON.stringify({
          profileKey: 'default_pairwise',
          displayName: 'Default pairwise',
          protocolScope: 'saml',
          usage: ['saml_edu_person_targeted_id'],
        }),
      },
      env
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ result: { profileKey: 'default_pairwise' } });
    expect(adapter.executes[0]?.sql).toContain('INSERT INTO persistent_identifier_profiles');
    expect(adapter.executes[0]?.params).toContain('tenant:default:saml:pairwise-nameid');
  });

  it('previews SAML and OIDC persistent identifiers through KeyManager secret refs', async () => {
    const adapter = createAdapter({ queryRows: [profileRow()] });
    const keyManager = {
      getSecretRpc: async () => ({
        active: { value: 'secret-value' },
      }),
    };
    const keyManagerNamespace = {
      idFromName: (name: string) => name,
      get: () => keyManager,
    };
    const { app, env } = createApp({
      DB_ADMIN: adapter as unknown as Env['DB_ADMIN'],
      KEY_MANAGER: keyManagerNamespace as unknown as Env['KEY_MANAGER'],
    });

    const response = await app.request(
      '/profiles/preview',
      {
        method: 'POST',
        body: JSON.stringify({
          profileId: 'persistent_identifier_profile_1',
          subject: 'user-123',
          audience: 'https://sp.example.edu/shibboleth-sp',
        }),
      },
      env
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      result: {
        profileId: 'persistent_identifier_profile_1',
        secretMaterialIncluded: false,
      },
    });
    const result = body.result as Record<string, unknown>;
    expect(result.opaque).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
    expect(result.samlAttributeValue).toContain('https://idp.example.edu/idp/shibboleth!');
    expect(result.samlAttributeValue).toContain('!https://sp.example.edu/shibboleth-sp!');
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  it('blocks deleting profiles that are referenced by field mapping transforms', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          field_mapping_set_id: 'field_mapping_set_1',
          version_id: 'field_mapping_version_1',
          lifecycle_state: 'active',
          transform_id: 'mapping_transform_1',
          parameters_json: JSON.stringify({
            persistentIdentifierProfileId: 'persistent_identifier_profile_1',
          }),
        },
      ],
    });
    const { app, env } = createApp({ DB_ADMIN: adapter as unknown as Env['DB_ADMIN'] });

    const response = await app.request(
      '/profiles/persistent_identifier_profile_1',
      {
        method: 'DELETE',
      },
      env
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: 'conflict',
      references: [
        {
          fieldMappingSetId: 'field_mapping_set_1',
          versionId: 'field_mapping_version_1',
          transformId: 'mapping_transform_1',
        },
      ],
    });
  });
});
