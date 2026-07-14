import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  settingsError: false,
  putPublic: vi.fn(async (_env: unknown, _tenant: string, value: unknown) => value),
  putSigning: vi.fn(async (_env: unknown, _tenant: string, value: unknown) => value),
  rotate: vi.fn(async () => ({
    keyRef: 'generated-key-ref',
    kid: 'generated-kid',
    certificate: 'generated-certificate',
  })),
  audit: vi.fn(async () => undefined),
  exportDR: vi.fn(async () => ({
    version: 1,
    kdf: { name: 'PBKDF2', iterations: 210000 },
    ciphertext: 'encrypted',
  })),
  importDR: vi.fn(async () => ({ importedKeys: 2, restoredRoles: ['idp', 'sp'] })),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.audit,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

vi.mock('../../common/entity-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/entity-id')>();
  return {
    ...actual,
    getSAMLPublicSettings: vi.fn(async () => {
      if (mocks.settingsError) throw new Error('settings unavailable');
      return mocks.settings;
    }),
    getSAMLLocalEntityIds: vi.fn(async () => ({
      issuerUrl: 'https://tenant.example.test',
      idpEntityId: 'https://tenant.example.test/saml/idp',
      spEntityId: 'https://tenant.example.test/saml/sp',
      idpMetadataUrl: 'https://tenant.example.test/saml/idp/metadata',
      spMetadataUrl: 'https://tenant.example.test/saml/sp/metadata',
    })),
    putSAMLPublicSettings: mocks.putPublic,
    putSAMLLocalSigningSettings: mocks.putSigning,
    normalizeSAMLEntityIdStyle: vi.fn((value: unknown) =>
      value === 'issuer_path' || value === 'role_path' ? value : null
    ),
    normalizeSAMLInteractiveLoginUrlPolicy: vi.fn((value: unknown) =>
      value === 'ui_base_url' || value === 'tenant_host' ? value : null
    ),
    normalizeCertificateSubjectAlternativeNames: vi.fn((value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    ),
    buildSAMLSigningCertificateSubjectAlternativeNames: vi.fn(
      (_ids: unknown, role: string, configured: string[]) => [`${role}.example.test`, ...configured]
    ),
  };
});

vi.mock('../../common/key-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/key-utils')>();
  return { ...actual, rotateSigningKeyWithCertificate: mocks.rotate };
});

vi.mock('../signing-rollover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signing-rollover')>();
  return {
    ...actual,
    getSAMLNextSigningCertificates: vi.fn((policy: { next?: unknown }) =>
      policy.next ? [policy.next] : []
    ),
    publishSAMLNextSigningCertificate: vi.fn((policy: object, next: object) => ({
      ...policy,
      next: { ...next, slot: 'next', state: 'published' },
    })),
    promoteSAMLNextSigningCertificate: vi.fn((policy: object, options: object) => ({
      ...policy,
      promoted: options,
    })),
    retireSAMLBackupSigningCertificate: vi.fn((policy: object) => ({
      ...policy,
      backup: undefined,
    })),
    deleteSAMLNextSigningCertificate: vi.fn((policy: object) => ({
      ...policy,
      next: undefined,
    })),
  };
});

vi.mock('../local-signing-dr-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../local-signing-dr-bundle')>();
  return {
    ...actual,
    buildEncryptedSAMLLocalSigningSecretDRBundle: mocks.exportDR,
    restoreEncryptedSAMLLocalSigningSecretDRBundle: mocks.importDR,
  };
});

import {
  handleExportSAMLLocalSigningDRBundle,
  handleGetSAMLSettings,
  handleImportSAMLLocalSigningDRBundle,
  handleUpdateSAMLLocalSigning,
  handleUpdateSAMLSettings,
} from '../providers';
import { SAMLDRBundleOperationError } from '../local-signing-dr-bundle';

function defaultSettings() {
  return {
    entityIdStyle: 'issuer_path',
    interactiveLoginUrlPolicy: 'ui_base_url',
    certificateSubject: {
      countryName: 'US',
      stateOrProvinceName: '',
      localityName: '',
      organizationName: 'Authrim',
      organizationalUnitName: '',
      commonName: 'Authrim SAML Signing',
    },
    certificateSubjectAlternativeNames: [],
    signingKeyPolicies: {
      idp: {
        active: { slot: 'active', keyRef: 'active-ref', kid: 'active-kid', state: 'active' },
      },
      sp: {},
    },
  };
}

function context(
  body: unknown = {},
  permissions: string[] | null = Object.values(ADMIN_PERMISSIONS)
) {
  return {
    env: {},
    req: { json: vi.fn(async () => body), header: vi.fn(() => undefined) },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return 'tenant-a';
      if (name === 'adminAuth') return permissions === null ? undefined : { permissions };
      return undefined;
    }),
    json: vi.fn(
      (value: unknown, status: number = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    header: vi.fn(),
  } as never;
}

describe('SAML settings administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = defaultSettings();
    mocks.settingsError = false;
    mocks.exportDR.mockResolvedValue({
      version: 1,
      kdf: { name: 'PBKDF2', iterations: 210000 },
      ciphertext: 'encrypted',
    });
    mocks.importDR.mockResolvedValue({ importedKeys: 2, restoredRoles: ['idp', 'sp'] });
  });

  it('requires read permission before disclosing settings', async () => {
    expect((await handleGetSAMLSettings(context({}, null))).status).toBe(401);
    expect((await handleGetSAMLSettings(context({}, []))).status).toBe(403);
  });

  it('returns public settings and generated local endpoints', async () => {
    const response = await handleGetSAMLSettings(context());
    expect(response.status).toBe(200);
    const body = await response.json<{
      tenantId: string;
      generated: { idpEntityId: string };
      localSigning: { idpSigningKeyPolicy: unknown };
    }>();
    expect(body).toMatchObject({
      tenantId: 'tenant-a',
      generated: { idpEntityId: 'https://tenant.example.test/saml/idp' },
    });
    expect(body.localSigning.idpSigningKeyPolicy).toBeTypeOf('object');
  });

  it('maps settings storage failures to an internal error', async () => {
    mocks.settingsError = true;
    expect((await handleGetSAMLSettings(context())).status).toBe(500);
    expect((await handleUpdateSAMLSettings(context())).status).toBe(500);
  });

  it.each([
    [{ entityIdStyle: 'invalid' }, 'entityIdStyle'],
    [{ interactiveLoginUrlPolicy: 'invalid' }, 'interactiveLoginUrlPolicy'],
  ])('rejects invalid public settings field %s', async (body, _field) => {
    const response = await handleUpdateSAMLSettings(context(body));
    expect(response.status).toBe(400);
    expect(mocks.putPublic).not.toHaveBeenCalled();
  });

  it('retains omitted values and reports unchanged certificate data', async () => {
    const response = await handleUpdateSAMLSettings(context({}));
    expect(response.status).toBe(200);
    expect(mocks.putPublic).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      expect.objectContaining({ entityIdStyle: 'issuer_path' })
    );
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('normalizes certificate subject text and SANs', async () => {
    const response = await handleUpdateSAMLSettings(
      context({
        entityIdStyle: 'role_path',
        interactiveLoginUrlPolicy: 'tenant_host',
        certificateSubject: {
          countryName: ' jp ',
          organizationName: '\u0000 Example Org ',
          commonName: ' '.repeat(2),
          localityName: 123,
        },
        certificateSubjectAlternativeNames: ['saml.example.test', 1],
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entityIdStyle: 'role_path',
      interactiveLoginUrlPolicy: 'tenant_host',
      certificateSubject: {
        countryName: 'JP',
        organizationName: 'Example Org',
        commonName: 'Authrim SAML Signing',
        localityName: '',
      },
      certificateSubjectAlternativeNames: ['saml.example.test'],
    });
  });

  it.each([
    [{}, 'role'],
    [{ role: 'invalid', action: 'publish_next' }, 'role'],
    [{ role: 'idp', action: 'invalid' }, 'action'],
    [
      {
        role: 'idp',
        action: 'publish_next',
        validFrom: '2030-01-02T00:00:00Z',
        validTo: '2030-01-01T00:00:00Z',
      },
      'validTo',
    ],
  ])('validates local signing request field %s', async (body, _field) => {
    const response = await handleUpdateSAMLLocalSigning(context(body));
    expect(response.status).toBe(400);
    expect(mocks.putSigning).not.toHaveBeenCalled();
  });

  it.each([
    ['recreate_active', 'idp'],
    ['publish_next', 'idp'],
    ['promote_next', 'idp'],
    ['retire_backup', 'idp'],
    ['delete_next', 'idp'],
    ['recreate_active', 'sp'],
  ] as const)('applies %s signing transition for %s', async (action, role) => {
    const response = await handleUpdateSAMLLocalSigning(
      context({
        role,
        action,
        keepPreviousAsBackup: false,
        targetKid: 'target-kid',
        targetKeyRef: 'target-ref',
        validFrom: 1_900_000_000_000,
        validTo: '2031-01-01T00:00:00Z',
        publicKeyAlgorithm: 'RSA',
        publicKeySizeBits: '4096',
        certificateSubjectAlternativeNames: ['extra.example.test'],
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.putSigning).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('uses defaults for invalid optional key-generation values', async () => {
    const response = await handleUpdateSAMLLocalSigning(
      context({
        role: 'sp',
        action: 'publish_next',
        validFrom: 'invalid',
        validTo: {},
        publicKeyAlgorithm: 'EC',
        publicKeySizeBits: 1024,
      })
    );
    expect(response.status).toBe(200);
    const rotateCalls = mocks.rotate.mock.calls as unknown as Array<
      [unknown, string, { certificateOptions: Record<string, unknown> }]
    >;
    expect(rotateCalls[0]?.[1]).toBe('tenant-a');
    expect(rotateCalls[0]?.[2].certificateOptions).toMatchObject({
      validFrom: undefined,
      validTo: undefined,
      publicKeyAlgorithm: undefined,
      publicKeySizeBits: undefined,
    });
  });

  it('fails closed when key rotation or settings persistence fails', async () => {
    mocks.rotate.mockRejectedValueOnce(new Error('key manager unavailable'));
    expect(
      (await handleUpdateSAMLLocalSigning(context({ role: 'idp', action: 'recreate_active' })))
        .status
    ).toBe(500);

    mocks.putSigning.mockRejectedValueOnce(new Error('settings unavailable'));
    expect(
      (await handleUpdateSAMLLocalSigning(context({ role: 'idp', action: 'retire_backup' }))).status
    ).toBe(500);
  });
});

describe('SAML signing disaster-recovery bundle administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = defaultSettings();
    mocks.settingsError = false;
    mocks.exportDR.mockResolvedValue({
      version: 1,
      kdf: { name: 'PBKDF2', iterations: 210000 },
      ciphertext: 'encrypted',
    });
    mocks.importDR.mockResolvedValue({ importedKeys: 2, restoredRoles: ['idp', 'sp'] });
  });

  it('requires separate export and import permissions', async () => {
    expect((await handleExportSAMLLocalSigningDRBundle(context({}, null))).status).toBe(401);
    expect((await handleExportSAMLLocalSigningDRBundle(context({}, []))).status).toBe(403);
    expect((await handleImportSAMLLocalSigningDRBundle(context({}, null))).status).toBe(401);
    expect((await handleImportSAMLLocalSigningDRBundle(context({}, []))).status).toBe(403);
  });

  it('exports only an encrypted, non-cacheable bundle and audits the operation', async () => {
    const c = context({ passphrase: 'correct horse battery staple' });
    const response = await handleExportSAMLLocalSigningDRBundle(c);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ciphertext: 'encrypted' });
    expect(mocks.exportDR).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'correct horse battery staple'
    );
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('imports a bundle, reloads public settings, and reports restored roles', async () => {
    const response = await handleImportSAMLLocalSigningDRBundle(
      context({ bundle: { ciphertext: 'encrypted' }, passphrase: 'secret' })
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      tenantId: string;
      imported: { importedKeys: number; restoredRoles: string[] };
      localSigning: { idpSigningKeyPolicy: unknown };
    }>();
    expect(body).toMatchObject({
      tenantId: 'tenant-a',
      imported: { importedKeys: 2, restoredRoles: ['idp', 'sp'] },
    });
    expect(body.localSigning.idpSigningKeyPolicy).toBeTypeOf('object');
    expect(mocks.audit).toHaveBeenCalled();
  });

  it.each([
    ['SAML DR bundle is malformed'],
    ['encrypted SAML DR bundle payload is missing'],
    ['cannot decrypt SAML DR bundle'],
    ['passphrase is too short'],
  ])('maps validation failure %s to a redacted 400 response', async (message) => {
    mocks.exportDR.mockRejectedValueOnce(new Error(message));
    const response = await handleExportSAMLLocalSigningDRBundle(context({ passphrase: 'secret' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('reports the typed operation stage without exposing PEM or passphrase material', async () => {
    mocks.importDR.mockRejectedValueOnce(
      new SAMLDRBundleOperationError(
        'decrypt_bundle',
        'passphrase=topsecret -----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----'
      )
    );
    const response = await handleImportSAMLLocalSigningDRBundle(
      context({ bundle: {}, passphrase: 'topsecret' })
    );
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('stage=decrypt bundle');
    expect(body).not.toContain('topsecret');
    expect(body).not.toContain('PRIVATE KEY');
  });

  it('maps unexpected export, audit, and settings-reload failures to stage-aware 500s', async () => {
    mocks.exportDR.mockRejectedValueOnce({ reason: 'unknown' });
    expect((await handleExportSAMLLocalSigningDRBundle(context())).status).toBe(500);

    mocks.audit.mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await handleExportSAMLLocalSigningDRBundle(context())).status).toBe(500);

    mocks.settingsError = true;
    expect((await handleImportSAMLLocalSigningDRBundle(context())).status).toBe(500);
  });
});
