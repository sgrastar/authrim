import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  },
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

import {
  adminConsentGateBindingCreateHandler,
  adminConsentGateBindingDeleteHandler,
  adminConsentGateBindingGetHandler,
  adminConsentGateBindingPreviewHandler,
  adminConsentGateBindingsListHandler,
  adminConsentGateBindingUpdateHandler,
} from '../admin-consent-gate-bindings';

function context(body: unknown = {}, id = 'binding-a') {
  return {
    req: {
      json: vi.fn().mockResolvedValue(body),
      param: vi.fn((name: string) => (name === 'id' ? id : undefined)),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

const binding = {
  id: 'binding-a',
  tenant_id: 'tenant-a',
  gate_kind: 'legal_document',
  target_type: 'oidc_client',
  target_id: 'client-a',
  policy_id: 'policy-a',
  enabled: 1,
  created_at: 1_000,
  updated_at: 1_000,
};

describe('Admin Consent Gate Policy binding API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  });

  it('lists and gets only tenant-scoped bindings', async () => {
    mocks.adapter.query.mockResolvedValueOnce([binding]);
    const listResponse = await adminConsentGateBindingsListHandler(context());
    await expect(listResponse.json()).resolves.toEqual({ bindings: [binding] });
    expect(mocks.adapter.query).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
    ]);

    mocks.adapter.queryOne.mockResolvedValueOnce(binding);
    const getResponse = await adminConsentGateBindingGetHandler(context());
    expect(getResponse.status).toBe(200);
    expect(mocks.adapter.queryOne).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      'binding-a',
    ]);
  });

  it('returns not_found for a missing or cross-tenant binding', async () => {
    expect((await adminConsentGateBindingGetHandler(context())).status).toBe(404);
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    expect((await adminConsentGateBindingDeleteHandler(context())).status).toBe(404);
  });

  it.each([
    [{}, 'gate_kind is invalid'],
    [
      { gate_kind: 'unknown', target_type: 'tenant', policy_id: 'policy-a' },
      'gate_kind is invalid',
    ],
    [
      { gate_kind: 'legal_document', target_type: 'unknown', policy_id: 'policy-a' },
      'target_type is invalid',
    ],
    [{ gate_kind: 'legal_document', target_type: 'tenant' }, 'policy_id is required'],
    [
      {
        gate_kind: 'legal_document',
        target_type: 'tenant',
        policy_id: 'policy-a',
        enabled: 1,
      },
      'enabled must be a boolean',
    ],
  ])('rejects invalid create body %#', async (body, message) => {
    const response = await adminConsentGateBindingCreateHandler(context(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_description: expect.stringContaining(message),
    });
  });

  it('creates a normalized binding after verifying Policy tenant ownership', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'policy-a' });
    const response = await adminConsentGateBindingCreateHandler(
      context({
        gate_kind: 'legal_document',
        target_type: 'oidc_client',
        target_id: ' client-a ',
        policy_id: ' policy-a ',
        enabled: true,
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.adapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('consent_policies'),
      ['tenant-a', 'policy-a']
    );
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consent_gate_policy_bindings'),
      expect.arrayContaining([
        'tenant-a',
        'legal_document',
        'oidc_client',
        'client-a',
        'policy-a',
        1,
      ])
    );
  });

  it('rejects cross-tenant Policy binding creation', async () => {
    const response = await adminConsentGateBindingCreateHandler(
      context({
        gate_kind: 'legal_document',
        target_type: 'tenant',
        policy_id: 'policy-other-tenant',
      })
    );
    expect(response.status).toBe(404);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects incompatible Gate and target types', async () => {
    const response = await adminConsentGateBindingCreateHandler(
      context({
        gate_kind: 'oidc_authorization',
        target_type: 'saml_sp',
        target_id: 'sp-a',
        policy_id: 'policy-a',
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('updates and deletes through tenant-scoped predicates', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(binding).mockResolvedValueOnce({ id: 'policy-a' });
    const updateResponse = await adminConsentGateBindingUpdateHandler(context({ enabled: false }));
    expect(updateResponse.status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND id = ?'),
      expect.arrayContaining(['tenant-a', 'binding-a'])
    );

    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    expect((await adminConsentGateBindingDeleteHandler(context())).status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('tenant_id = ?'),
      ['tenant-a', 'binding-a']
    );
  });

  it('previews exact binding precedence without accepting a Policy ID from the request', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(binding);
    const response = await adminConsentGateBindingPreviewHandler(
      context({
        gate_kind: 'legal_document',
        target_type: 'oidc_client',
        target_id: 'client-a',
        policy_id: 'attacker-policy',
        node_config: { policy_resolution: 'target_binding' },
      })
    );
    await expect(response.json()).resolves.toEqual({
      effective: {
        gate_kind: 'legal_document',
        target_type: 'oidc_client',
        target_id: 'client-a',
        policy_id: 'policy-a',
        source: 'exact_binding',
        binding_id: 'binding-a',
        policy: null,
        statement_versions: [],
        affected_targets: [],
      },
    });
  });

  it('includes effective Policy versions, defaults, and affected targets in preview', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce({ id: 'policy-a', display_name: 'Policy A', description: 'Example' });
    mocks.adapter.query
      .mockResolvedValueOnce([
        {
          statement_id: 'terms',
          statement_slug: 'terms',
          version: '1',
          requirement: 'required',
          checkbox_mode: 'required',
          checkbox_default_checked: 0,
        },
      ])
      .mockResolvedValueOnce([binding]);

    const response = await adminConsentGateBindingPreviewHandler(
      context({
        gate_kind: 'legal_document',
        target_type: 'oidc_client',
        target_id: 'client-a',
        node_config: { policy_resolution: 'target_binding' },
      })
    );

    await expect(response.json()).resolves.toMatchObject({
      effective: {
        policy: { id: 'policy-a', display_name: 'Policy A' },
        statement_versions: [expect.objectContaining({ statement_id: 'terms', version: '1' })],
        affected_targets: [
          { target_type: 'oidc_client', target_id: 'client-a', binding_id: 'binding-a' },
        ],
      },
    });
  });

  it('returns configuration_error when a required preview has no effective Policy', async () => {
    const response = await adminConsentGateBindingPreviewHandler(
      context({
        gate_kind: 'saml_attribute_release',
        target_type: 'saml_sp',
        target_id: 'sp-a',
        node_config: { policy_resolution: 'target_binding', policy_required: true },
      })
    );
    expect(response.status).toBe(409);
  });

  it.each([
    [{ node_config: 'invalid' }, 'node_config must be an object'],
    [{ node_config: { policy_required: 'yes' } }, 'node_config.policy_required must be a boolean'],
    [
      { node_config: { fallback_policy_ref: ' ' } },
      'node_config.fallback_policy_ref must be a nonblank string',
    ],
  ])('rejects malformed preview config %#', async (extra, message) => {
    const response = await adminConsentGateBindingPreviewHandler(
      context({
        gate_kind: 'legal_document',
        target_type: 'tenant',
        ...extra,
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error_description: message });
  });

  it('returns stable server errors for storage failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await adminConsentGateBindingsListHandler(context())).status).toBe(500);
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await adminConsentGateBindingGetHandler(context())).status).toBe(500);
  });
});
