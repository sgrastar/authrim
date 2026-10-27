import { describe, expect, it, vi } from 'vitest';
import { verifyRestoredSourceLoginUi, assertSourceSAMLSigningPolicy } from './runtime-assembly';
import type { AssembleAwsSamlTenantInput } from './runtime-assembly-input';
import type { AwsRuntimeUiConfig } from '../ui/runtime-ui-config';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';

const ui: AwsRuntimeUiConfig = {
  components: { loginUi: false, adminUi: false },
  ui: {
    login: {
      mode: 'external',
      baseUrl: 'https://login.example.test',
      clientId: 'external-login',
      paths: { login: '/login', reauth: '/reauth' },
    },
    admin: { mode: 'disabled' },
  },
};
function row(values: Record<string, string | number | null>): PortableSqliteRow {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === null
        ? (['null', null] as const)
        : typeof value === 'number'
          ? (['integer', String(value)] as const)
          : (['text', value] as const),
    ])
  );
}

function fixture() {
  const client = {
    tenant_id: 'tenant-a',
    client_id: 'external-login',
    application_type: 'web',
    allowed_channels: '["browser"]',
    client_secret_hash: null,
  };
  const origin = {
    tenant_id: 'tenant-a',
    client_id: 'external-login',
    origin: 'https://login.example.test',
    handoff_allowed: 1,
    is_active: 1,
  };
  const queryOne = vi.fn(async (sql: string) => (sql.includes('oauth_clients') ? client : origin));
  const input = {
    backup: { manifest: { source: { tenantId: 'tenant-a', issuer: 'https://idp.example.test' } } },
    supplement: {
      sourceLoginUi: {
        client: row({ ...client, logout_webhook_secret_encrypted: null }),
        origins: [row(origin)],
      },
    },
    restored: { metadataCoreDb: { queryOne } },
    destinationUi: structuredClone(ui),
  } as unknown as AssembleAwsSamlTenantInput;
  return { input, queryOne, client, origin };
}

describe('AWS runtime source UI provenance', () => {
  it('requires the captured external client and active handoff origin to exist in restored SQL', async () => {
    const value = fixture();
    await expect(verifyRestoredSourceLoginUi(value.input)).resolves.toBeUndefined();
    expect(value.queryOne).toHaveBeenCalledWith(expect.stringContaining('oauth_clients'), [
      'tenant-a',
      'external-login',
    ]);
    expect(value.queryOne).toHaveBeenCalledWith(expect.stringContaining('web_origin_registry'), [
      'tenant-a',
      'external-login',
      'https://login.example.test',
    ]);
    value.origin.handoff_allowed = 0;
    await expect(verifyRestoredSourceLoginUi(value.input)).rejects.toThrow(
      'aws_runtime_assembly_invalid'
    );
  });

  it.each(['client', 'origin', 'secret', 'tenant'] as const)(
    'refuses mismatched %s evidence',
    async (kind) => {
      const value = fixture();
      if (kind === 'client' && value.input.destinationUi?.ui.login.mode === 'external')
        value.input.destinationUi.ui.login.clientId = 'other';
      if (kind === 'origin' && value.input.destinationUi?.ui.login.mode === 'external')
        value.input.destinationUi.ui.login.baseUrl = 'https://unapproved.example.test';
      if (kind === 'secret')
        Object.assign(value.client, { client_secret_hash: 'must-not-be-public' });
      if (kind === 'tenant') value.origin.tenant_id = 'other';
      await expect(verifyRestoredSourceLoginUi(value.input)).rejects.toThrow(
        'aws_runtime_assembly_invalid'
      );
    }
  );

  it('accepts explicit source absence only with disabled destination and performs no fabricated client queries', async () => {
    const value = fixture();
    value.input.supplement.sourceLoginUi = { mode: 'disabled' };
    await expect(verifyRestoredSourceLoginUi(value.input)).rejects.toThrow();
    value.input.destinationUi = {
      ...ui,
      ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
    };
    await expect(verifyRestoredSourceLoginUi(value.input)).resolves.toBeUndefined();
    expect(value.queryOne).not.toHaveBeenCalled();
    Reflect.deleteProperty(value.input.supplement, 'sourceLoginUi');
    await expect(verifyRestoredSourceLoginUi(value.input)).rejects.toThrow();
  });

  it('requires source SAML policy to select the external UI instead of silently changing it', () => {
    const issuer = 'https://idp.example.test';
    const bundle = {
      settings: {
        entityIdStyle: 'metadata_url' as const,
        interactiveLoginUrlPolicy: 'ui_base_url' as const,
      },
      generated: { issuerUrl: issuer, idpEntityId: `${issuer}/saml/idp/metadata` },
    } as Parameters<typeof assertSourceSAMLSigningPolicy>[0];
    expect(() => assertSourceSAMLSigningPolicy(bundle, issuer, ui)).not.toThrow();
    expect(() => assertSourceSAMLSigningPolicy(bundle, issuer)).toThrow();
    expect(() =>
      assertSourceSAMLSigningPolicy(
        { ...bundle, settings: { ...bundle.settings, interactiveLoginUrlPolicy: 'tenant_host' } },
        issuer,
        ui
      )
    ).toThrow();
  });
});
