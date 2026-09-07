import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultConfig } from '../core/config.js';
import { runGeneratedServerSurfacesSmoke } from '../core/generated-server-surfaces-smoke.js';

vi.mock('execa', () => ({
  execa: vi.fn(async () => ({ stdout: '', stderr: '', all: '', exitCode: 0 })),
}));

describe('generated server-surface smoke', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('covers server-side live paths against a generated environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-server-surfaces-smoke-'));
    const env = 'single';
    const envDir = join(baseDir, '.authrim', env);
    const keysDir = join(baseDir, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });

    const config = createDefaultConfig(env);
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
    };

    await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(
      join(envDir, 'lock.json'),
      JSON.stringify({
        version: '1.0.0',
        env,
        createdAt: '2026-08-31T00:00:00.000Z',
        d1: {
          DB_ADMIN: { id: 'admin-immutable-id', name: `${env}-authrim-admin-db` },
        },
        kv: {},
      })
    );

    const schemas: Array<Record<string, unknown>> = [];
    const routingRules: Array<Record<string, unknown>> = [];
    let createdUserId = 'user-1';
    let createdScimUserId = 'scim-user-1';
    let createdScimTokenHash = 'scim-hash-1';
    let runtimeProfileId = '';

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/token') && method === 'POST') {
        return new Response(
          JSON.stringify({
            access_token: 'machine-admin-token',
            token_type: 'Bearer',
            expires_in: 600,
            scope: 'admin:*',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/custom-claims?limit=100') && method === 'GET') {
        return new Response(JSON.stringify({ schemas, pagination: { total: schemas.length } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/custom-claims') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const schema = {
          id: `schema-${schemas.length + 1}`,
          field_key: body.field_key,
          display_label: body.display_label,
          field_type: body.field_type ?? 'string',
          is_required: body.is_required ? 1 : 0,
          is_active: 1,
          show_on_registration: body.show_on_registration ? 1 : 0,
          validation_rules: body.validation_rules ?? null,
        };
        schemas.push(schema);
        return new Response(JSON.stringify({ schema }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/api/admin/custom-claims/') && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/v1/registration-fields') && method === 'GET') {
        const fields = schemas
          .filter((schema) => schema.show_on_registration === 1)
          .map((schema) => ({
            field_key: schema.field_key,
            label: schema.display_label,
          }));
        return new Response(JSON.stringify({ fields }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/users') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        expect(headers.get('Idempotency-Key')).toMatch(/^server-surfaces-user-(missing|create)-/u);
        const requiredFieldKey = String(schemas[0]?.field_key ?? 'department');
        if (
          !(requiredFieldKey in body) ||
          body[requiredFieldKey] == null ||
          body[requiredFieldKey] === ''
        ) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              missing_required_fields: [
                {
                  field_key: requiredFieldKey,
                  label: schemas[0]?.display_label ?? 'Department',
                  field_type: schemas[0]?.field_type ?? 'string',
                },
              ],
            }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ user: { id: createdUserId } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith(`/api/admin/users/${createdUserId}`) && method === 'GET') {
        const requiredFieldKey = String(schemas[0]?.field_key ?? 'department');
        return new Response(
          JSON.stringify({
            user: { id: createdUserId },
            customFields: [
              { field_name: requiredFieldKey, field_value: 'Engineering', field_type: 'string' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith(`/api/admin/users/${createdUserId}`) && method === 'PUT') {
        const requiredFieldKey = String(schemas[0]?.field_key ?? 'department');
        return new Response(
          JSON.stringify({
            error: 'invalid_request',
            missing_required_fields: [
              {
                field_key: requiredFieldKey,
                label: schemas[0]?.display_label ?? 'Department',
                field_type: schemas[0]?.field_type ?? 'string',
              },
            ],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/scim-tokens') && method === 'POST') {
        return new Response(
          JSON.stringify({
            token: 'scim-token-1',
            tokenHash: createdScimTokenHash,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/scim/v2/Users') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const ext = body['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
        const requiredFieldKey = String(schemas[0]?.field_key ?? 'department');
        if (
          !ext ||
          typeof ext !== 'object' ||
          ext === null ||
          !(requiredFieldKey in (ext as Record<string, unknown>))
        ) {
          return new Response(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
              status: '400',
              detail: 'missing required field',
              scimType: 'invalidValue',
              missing_required_fields: [
                {
                  field_key: requiredFieldKey,
                  label: schemas[0]?.display_label ?? 'Department',
                  field_type: schemas[0]?.field_type ?? 'string',
                },
              ],
            }),
            { status: 400, headers: { 'content-type': 'application/scim+json; charset=utf-8' } }
          );
        }
        return new Response(
          JSON.stringify({
            id: createdScimUserId,
            userName: 'phase15-scim@example.test',
          }),
          { status: 201, headers: { 'content-type': 'application/scim+json; charset=utf-8' } }
        );
      }

      if (url.endsWith('/api/admin/runtime-profiles/defaults') && method === 'GET') {
        return new Response(
          JSON.stringify({
            defaults: {
              auditProfileId: 'builtin:audit:standard',
              residencyProfileId: 'builtin:residency:default',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('/api/admin/runtime-profiles/audit/') && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        runtimeProfileId = url.split('/').pop() || 'phase15-audit';
        return new Response(
          JSON.stringify({
            profile: {
              id: runtimeProfileId,
              label: body.label,
              sinks: body.sinks,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('/api/admin/runtime-profiles/audit/') && method === 'GET') {
        const id = url.split('/').pop() || runtimeProfileId;
        return new Response(
          JSON.stringify({
            profile: {
              id,
              label: 'Server Surface Smoke Audit Profile',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('/api/admin/runtime-profiles/audit/') && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/runtime-profiles?kind=audit') && method === 'GET') {
        return new Response(
          JSON.stringify({
            profiles: {
              audit: [{ id: runtimeProfileId }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/tenants/default/runtime-profiles') && method === 'GET') {
        return new Response(
          JSON.stringify({
            effective: {
              audit: { id: 'builtin:audit:standard' },
              residency: { id: 'builtin:residency:default' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/settings/audit-storage') && method === 'GET') {
        return new Response(JSON.stringify({ storage: { backend: 'd1-core' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/settings/audit-storage/retention') && method === 'GET') {
        return new Response(JSON.stringify({ retention: { eventLogRetentionDays: 90 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/settings/audit-storage/routing-rules') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        routingRules.push({ name: body.name });
        return new Response(JSON.stringify({ success: true, rule: { name: body.name } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/settings/audit-storage/routing-rules') && method === 'GET') {
        return new Response(JSON.stringify({ rules: routingRules }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/api/admin/settings/audit-storage/routing-rules/') && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/settings/audit-storage/stats') && method === 'GET') {
        return new Response(JSON.stringify({ stats: { total_logs: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith(`/api/admin/users/${createdScimUserId}`) && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith(`/api/admin/users/${createdUserId}`) && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith(`/api/admin/scim-tokens/${createdScimTokenHash}`) && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const result = await runGeneratedServerSurfacesSmoke({ baseDir, env });

    expect(result.ok, JSON.stringify(result.checks, null, 2)).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'server-surfaces-custom-claims-list',
        'server-surfaces-custom-claim-create',
        'server-surfaces-admin-create-required-fail',
        'server-surfaces-admin-create-valid',
        'server-surfaces-admin-update-required-fail',
        'server-surfaces-scim-token-create',
        'server-surfaces-scim-create-required-fail',
        'server-surfaces-scim-create-valid',
        'server-surfaces-runtime-profile-create',
        'phase4-routing-rule-create',
        'phase4-routing-rule-list',
      ])
    );
  });
});
