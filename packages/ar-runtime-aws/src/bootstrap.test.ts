import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import { generateSelfSignedCertificate } from '../../ar-saml/src/common/key-utils';
import { assertSAMLIdPProviderReadiness } from '@authrim/ar-saml/idp-readiness';
import { createAwsSamlTenant, type CreateAwsSamlTenantInput } from './bootstrap';
import { assertAwsRuntimeSchemaReady } from './import/aws-schema-bootstrap';
import { assertPasskeyOnlySamlFlowReady } from './ui/passkey-flow-profile';

vi.mock('@authrim/ar-saml/idp-readiness', () => ({
  assertSAMLIdPProviderReadiness: vi.fn(async () => undefined),
}));
vi.mock('./import/aws-schema-bootstrap', () => ({
  assertAwsRuntimeSchemaReady: vi.fn(async () => undefined),
}));
vi.mock('./ui/passkey-flow-profile', () => ({
  assertPasskeyOnlySamlFlowReady: vi.fn(async () => undefined),
}));

const TENANT_ID = 'tenant-a';
const ORIGIN = 'https://tenant-a.example.test';
const SP = 'https://sp.example.test/saml';
const IMPORTED_RELEASE: SAMLRuntimeImportedSPRelease = {
  tenantId: TENANT_ID,
  entityId: SP,
  sourceSelector: null,
  sourceBindingRef: {
    activationId: 'activation-1',
    fieldMappingSetId: 'set-1',
    fieldMappingVersionId: 'version-1',
    mappingSnapshotHash: 'snapshot-1',
    destinationProfileId: 'profile-1',
    destinationProfileVersionId: 'profile-version-1',
  },
  binding: {},
  destinationProfile: {
    profileId: 'profile-1',
    profileVersionId: 'profile-version-1',
    destinationType: 'saml',
    fields: [],
  },
};

async function input(): Promise<CreateAwsSamlTenantInput> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certificate = await generateSelfSignedCertificate(
    publicKey.export({ format: 'jwk' }),
    privateKeyPem
  );
  const documents = new Map<string, string>([
    [
      `settings:tenant:${TENANT_ID}:federation`,
      JSON.stringify({ 'federation.saml_enabled': true }),
    ],
    [
      `settings:tenant:${TENANT_ID}:authentication-methods`,
      JSON.stringify({
        'authentication-methods.passkey.login_enabled': true,
        'authentication-methods.passkey.reauth_enabled': true,
        'authentication-methods.email_otp.enabled': false,
        'authentication-methods.external_provider_usage': [],
      }),
    ],
  ]);
  const settings = { get: vi.fn(async (key: string) => documents.get(key) ?? null) };
  return {
    tenantId: TENANT_ID,
    origin: ORIGIN,
    environmentName: 'aws-dr-test',
    inventory: {
      tenantId: TENANT_ID,
      allocationScope: 'shared_pool',
      metadataCoreDb: {
        getType: () => 'postgres',
        queryOne: vi.fn(async () => null),
      } as unknown as DatabaseAdapter,
      accountCoreByBindingRef: {},
      accountPiiByBindingRef: {},
      lookupRows: [],
      coreAccountRouteGenerations: {},
      lookupReadKeys: [{ generation: 1, secret: 'lookup-secret-with-at-least-thirty-two-bytes' }],
    },
    stateDb: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    auditPorts: { append: vi.fn(async () => undefined) },
    settings,
    configuration: { get: vi.fn(async () => null) },
    signingBundle: {
      tenantId: TENANT_ID,
      keys: [
        {
          keyRef: `tenant:${TENANT_ID}:saml:idp:signing`,
          kid: 'key-1',
          privateKeyPem,
          certificate,
        },
      ],
    },
    pairwiseSecret: {
      tenantId: TENANT_ID,
      secretRef: `tenant:${TENANT_ID}:saml:pairwise-nameid`,
      active: { kid: 'salt-1', value: 'imported-secret', createdAt: 1234 },
      updatedAt: 1234,
    },
    spEntityIds: [SP],
    identityMappings: [IMPORTED_RELEASE],
    consentIpSalt: 'existing-consent-salt-with-thirty-two-bytes',
    flowRuntimeHmacSecret: 'imported-flow-hmac-secret-with-thirty-two-bytes',
    assertSnapshotReady: vi.fn(async () => undefined),
  };
}

describe('AWS SAML tenant bootstrap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps API-only readiness independent of captured Login UI and passkey UI policy', async () => {
    const options = await input();
    options.destinationUi = {
      components: { loginUi: false, adminUi: false },
      ui: {
        login: { mode: 'disabled' },
        admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
      },
    };
    const previous = options.settings.get.bind(options.settings);
    options.settings.get = async (key) =>
      key.endsWith(':tenant')
        ? JSON.stringify({ 'tenant.ui_base_url': ORIGIN, 'tenant.ui_login_path': '/source-login' })
        : key.endsWith(':authentication-methods')
          ? null
          : previous(key);
    const runtime = createAwsSamlTenant(options);
    expect(runtime.env.UI_URL).toBeUndefined();
    expect(runtime.env.LOGIN_UI_ENABLED).toBe('false');
    await expect(runtime.assertReady()).resolves.toBeUndefined();
    expect(assertPasskeyOnlySamlFlowReady).not.toHaveBeenCalled();
    expect(assertSAMLIdPProviderReadiness).toHaveBeenCalledOnce();
  });

  it('uses the declared external UI without weakening the existing authentication policy', async () => {
    const options = await input();
    options.destinationUi = {
      components: { loginUi: false, adminUi: false },
      ui: {
        login: {
          mode: 'external',
          baseUrl: 'https://login.example.test',
          clientId: 'custom-login',
          paths: { login: '/sign-in', reauth: '/prove-again' },
        },
        admin: { mode: 'disabled' },
      },
    };
    const runtime = createAwsSamlTenant(options);
    expect(runtime.env.ALLOWED_ORIGINS).toBe(`${ORIGIN},https://login.example.test`);
    expect(runtime.env.LOGIN_UI_EXECUTION_HOST_MODE).toBe('dedicated');
    await expect(runtime.assertReady()).resolves.toBeUndefined();
    expect(assertPasskeyOnlySamlFlowReady).toHaveBeenCalledWith(
      options.inventory.metadataCoreDb,
      TENANT_ID,
      [SP],
      'https://login.example.test',
      'custom-login'
    );
    vi.mocked(assertPasskeyOnlySamlFlowReady).mockRejectedValueOnce(
      new Error('aws_login_origin_unavailable')
    );
    await expect(runtime.assertReady()).rejects.toThrow('aws_login_origin_unavailable');
  });

  it('connects narrow ports and checks every imported capability before serving', async () => {
    const options = await input();
    const tenant = createAwsSamlTenant(options);
    expect(tenant.origin).toBe(ORIGIN);
    expect(tenant.env.DB).toBeUndefined();
    expect(tenant.env.KEY_MANAGER).toBeUndefined();
    expect(
      tenant.env.SAML_RUNTIME_PORTS?.serviceProviders.isAllowed({
        tenantId: TENANT_ID,
        entityId: SP,
      })
    ).toBe(true);
    expect(await tenant.env.KV?.get(`consent:ip_salt:${TENANT_ID}`)).toBe(options.consentIpSalt);
    await expect(tenant.env.KV?.put(`consent:ip_salt:${TENANT_ID}`, 'changed')).rejects.toThrow(
      'immutable'
    );
    await tenant.assertReady();
    expect(options.assertSnapshotReady).toHaveBeenCalledOnce();
    expect(assertAwsRuntimeSchemaReady).toHaveBeenCalledWith(options.stateDb);
    expect(assertPasskeyOnlySamlFlowReady).toHaveBeenCalledWith(
      options.inventory.metadataCoreDb,
      TENANT_ID,
      [SP],
      ORIGIN
    );
    expect(assertSAMLIdPProviderReadiness).toHaveBeenCalledWith({
      env: tenant.env,
      tenantId: TENANT_ID,
      spEntityIds: [SP],
    });
  });

  it('rejects missing audit delivery and mismatched imported tenant material', async () => {
    const options = await input();
    expect(() => createAwsSamlTenant({ ...options, auditPorts: undefined as never })).toThrow(
      'aws_saml_tenant_input_invalid'
    );
    expect(() =>
      createAwsSamlTenant({
        ...options,
        signingBundle: { ...options.signingBundle, tenantId: 'tenant-b' },
      })
    ).toThrow('aws_saml_tenant_input_invalid');
  });

  it('fails readiness when the verified snapshot is no longer available', async () => {
    const options = await input();
    options.assertSnapshotReady = vi.fn(async () => {
      throw new Error('snapshot_stale');
    });
    await expect(createAwsSamlTenant(options).assertReady()).rejects.toThrow('snapshot_stale');
    expect(assertPasskeyOnlySamlFlowReady).not.toHaveBeenCalled();
  });

  it('rejects policy that needs a human verification screen or disables Flow', async () => {
    const options = await input();
    const originalGet = options.settings.get.bind(options.settings);
    options.settings.get = async (key) =>
      key.endsWith(':authentication-methods')
        ? JSON.stringify({
            'authentication-methods.passkey.login_enabled': true,
            'authentication-methods.passkey.reauth_enabled': true,
            'authentication-methods.email_otp.enabled': false,
            'authentication-methods.external_provider_usage': [],
            'authentication-methods.human_verification.login_enabled': true,
          })
        : originalGet(key);
    await expect(createAwsSamlTenant(options).assertReady()).rejects.toThrow(
      'aws_human_verification_unsupported'
    );

    const flowDisabled = await input();
    flowDisabled.configuration.get = async (key) =>
      key === 'flag:ENABLE_LOGIN_RUNTIME_FLOW' ? 'false' : null;
    await expect(createAwsSamlTenant(flowDisabled).assertReady()).rejects.toThrow(
      'aws_login_flow_feature_disabled'
    );
  });

  it('rejects settings that would hydrate another login handle or query provider bridge', async () => {
    const options = await input();
    const originalGet = options.settings.get.bind(options.settings);
    options.settings.get = async (key) =>
      key.endsWith(':authentication-methods')
        ? JSON.stringify({ 'authentication-methods.passkey.login_enabled': true })
        : originalGet(key);
    await expect(createAwsSamlTenant(options).assertReady()).rejects.toThrow(
      'aws_login_methods_unsupported'
    );

    const providerFallback = await input();
    const providerGet = providerFallback.settings.get.bind(providerFallback.settings);
    providerFallback.settings.get = async (key) =>
      key.endsWith(':authentication-methods')
        ? JSON.stringify({
            'authentication-methods.email_otp.enabled': false,
            'authentication-methods.external_provider_usage': [{ id: 'saml:external' }],
          })
        : providerGet(key);
    await expect(createAwsSamlTenant(providerFallback).assertReady()).rejects.toThrow(
      'aws_login_methods_unsupported'
    );
  });
});
