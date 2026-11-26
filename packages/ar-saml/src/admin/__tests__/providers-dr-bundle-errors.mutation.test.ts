/**
 * DR bundle export/import error reporting: status classification, failure stage and the
 * redaction of secrets from the detail that is returned to the administrator.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, dig, harnessContext } from './helpers/provider-handler-harness';

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  exportDR: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => ({
      version: 1,
      kdf: { name: 'PBKDF2', iterations: 210000 },
      ciphertext: 'encrypted',
    })
  ),
  importDR: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => ({
      importedKeys: 2,
      restoredRoles: ['idp'],
    })
  ),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
  logError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuditLog: mocks.audit,
    getLogger: () => ({
      module: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

vi.mock('../../common/entity-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/entity-id')>();
  return {
    ...actual,
    getSAMLPublicSettings: vi.fn(async () => ({
      certificateSubject: { commonName: 'x' },
      certificateSubjectAlternativeNames: { dnsNames: [] },
      signingKeyPolicies: { idp: { active: { kid: 'k' } } },
    })),
    getSAMLLocalEntityIds: vi.fn(async () => ({
      issuerUrl: 'https://tenant.example.test',
      idpEntityId: 'https://tenant.example.test/saml/idp',
      spEntityId: 'https://tenant.example.test/saml/sp',
      idpMetadataUrl: 'https://tenant.example.test/saml/idp/metadata',
      spMetadataUrl: 'https://tenant.example.test/saml/sp/metadata',
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
  handleImportSAMLLocalSigningDRBundle,
} from '../providers';
import { SAMLDRBundleOperationError } from '../local-signing-dr-bundle';

async function exportWith(error: unknown) {
  mocks.exportDR.mockRejectedValue(error);
  const response = await handleExportSAMLLocalSigningDRBundle(
    harnessContext({ body: { passphrase: 'pw' } })
  );
  return { response, body: await bodyOf<unknown>(response) };
}

function description(body: unknown): string {
  return String(dig(body, 'error_description'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detail redaction', () => {
  it('replaces embedded PEM blocks', async () => {
    const { body } = await exportWith(
      new Error(
        'SAML DR bundle failed near -----BEGIN PRIVATE KEY-----\nMIIabc\nxyz\n-----END PRIVATE KEY----- and -----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE----- done'
      )
    );

    expect(description(body)).toBe(
      'SAML signing DR bundle export failed; stage=export signing keys; detail=SAML DR bundle failed near [redacted PEM] and [redacted PEM] done'
    );
  });

  it('redacts secret-looking key/value pairs, case-insensitively, with : or =', async () => {
    const { body } = await exportWith(
      new Error(
        'failure passphrase=hunter2 Payload: abc123 BUNDLE = zzz privateKeyPem:KEY privatePEM=KEY2 keep=this'
      )
    );

    expect(description(body)).toContain(
      'detail=failure passphrase=[redacted] Payload=[redacted] BUNDLE=[redacted] privateKeyPem=[redacted] privatePEM=[redacted] keep=this'
    );
    expect(description(body)).not.toMatch(/hunter2|abc123|zzz|KEY2/);
  });

  it('does not treat a longer word as a secret key', async () => {
    const { body } = await exportWith(new Error('failure mypayload=visible payloads=visible'));

    expect(description(body)).toContain('mypayload=visible payloads=visible');
  });

  it('turns control characters into single spaces and trims', async () => {
    const { body } = await exportWith(
      new Error('  SAML DR bundle\u0000\u001f\n\tfailed\u007f  badly  ')
    );

    expect(description(body)).toContain('detail=SAML DR bundle failed badly');
  });

  it('cuts the detail to 280 characters', async () => {
    const { body } = await exportWith(new Error(`SAML DR bundle ${'x'.repeat(400)}`));

    const detail = description(body).split('detail=')[1] ?? '';
    expect(detail).toHaveLength(280);
    expect(detail.startsWith('SAML DR bundle xxx')).toBe(true);
  });

  it('keeps a detail of exactly 280 characters whole', async () => {
    const message = `SAML DR bundle ${'y'.repeat(265)}`;
    const { body } = await exportWith(new Error(message));

    expect(description(body).split('detail=')[1]).toBe(message);
  });

  it.each([
    ['an empty message', new Error('')],
    ['a message of only control characters', new Error('\u0000\u0001 \n')],
    ['a non-Error rejection', 'boom'],
  ])('reports "Unknown error" for %s', async (_label, error) => {
    const { response, body } = await exportWith(error);

    expect(response.status).toBe(500);
    expect(description(body)).toBe(
      'SAML signing DR bundle export failed; stage=export signing keys; detail=Unknown error'
    );
  });
});

describe('status classification', () => {
  it.each([
    'SAML DR bundle is malformed',
    'Invalid encrypted SAML DR bundle',
    'Unable to decrypt SAML DR bundle',
    'A passphrase is required',
  ])('answers 400 for the validation error "%s"', async (message) => {
    const { response, body } = await exportWith(new Error(message));

    expect(response.status).toBe(400);
    expect(dig(body, 'error')).toBe('invalid_request');
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('answers 500 and logs an unexpected error', async () => {
    const { response, body } = await exportWith(new Error('kaput'));

    expect(response.status).toBe(500);
    expect(dig(body, 'error')).toBe('server_error');
    expect(mocks.logError).toHaveBeenCalledWith(
      'Export SAML local signing DR bundle error',
      {},
      expect.any(Error)
    );
  });

  it('sends no-store headers with errors', async () => {
    const responseHeaders: Record<string, string> = {};
    mocks.exportDR.mockRejectedValue(new Error('kaput'));

    await handleExportSAMLLocalSigningDRBundle(
      harnessContext({ body: { passphrase: 'pw' }, responseHeaders })
    );

    expect(responseHeaders).toEqual({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  });
});

describe('failure stage', () => {
  it('uses the stage reported by the bundle operation, underscores shown as spaces', async () => {
    const { body } = await exportWith(
      new SAMLDRBundleOperationError('encrypt_bundle', 'SAML DR bundle failed')
    );

    expect(description(body)).toContain('stage=encrypt bundle');
    expect(description(body)).toContain('detail=SAML DR bundle failed');
  });

  it('reports the audit stage when the audit write fails after a successful export', async () => {
    mocks.exportDR.mockResolvedValue({ kdf: { name: 'PBKDF2', iterations: 1 } });
    mocks.audit.mockRejectedValueOnce(new Error('audit down'));

    const response = await handleExportSAMLLocalSigningDRBundle(
      harnessContext({ body: { passphrase: 'pw' } })
    );

    expect(response.status).toBe(500);
    expect(description(await bodyOf<unknown>(response))).toContain('stage=audit');
  });

  it('refuses callers without the export permission before touching the keys', async () => {
    const response = await handleExportSAMLLocalSigningDRBundle(
      harnessContext({ body: {}, permissions: [] })
    );

    expect(response.status).toBe(403);
    expect(mocks.exportDR).not.toHaveBeenCalled();
  });

  it('exports with no-store headers and an audit of the key derivation', async () => {
    const responseHeaders: Record<string, string> = {};
    mocks.exportDR.mockResolvedValue({
      kdf: { name: 'PBKDF2', iterations: 210000 },
      ciphertext: 'c',
    });

    const response = await handleExportSAMLLocalSigningDRBundle(
      harnessContext({ body: { passphrase: 'pw' }, responseHeaders })
    );

    expect(response.status).toBe(200);
    expect(responseHeaders).toEqual({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    expect(mocks.exportDR.mock.calls[0]?.slice(1)).toEqual(['tenant-a', 'pw']);
    const entry = mocks.audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'saml.local_signing.dr_bundle.exported',
      resource: 'saml_settings',
      resourceId: 'tenant-a',
      severity: 'warning',
    });
    expect(JSON.parse(String(entry.metadata))).toMatchObject({
      encrypted: true,
      kdf: 'PBKDF2',
      kdf_iterations: 210000,
    });
  });
});

describe('import', () => {
  async function importWith(error: unknown) {
    mocks.importDR.mockRejectedValue(error);
    const response = await handleImportSAMLLocalSigningDRBundle(
      harnessContext({ body: { bundle: { b: 1 }, passphrase: 'pw' } })
    );
    return { response, body: await bodyOf<unknown>(response) };
  }

  it('starts at the decrypt stage and reports the import operation', async () => {
    const { response, body } = await importWith(new Error('SAML DR bundle bad'));

    expect(response.status).toBe(400);
    expect(description(body)).toBe(
      'SAML signing DR bundle import failed; stage=decrypt bundle; detail=SAML DR bundle bad'
    );
  });

  it('answers 500 and logs for an unexpected import failure', async () => {
    const { response } = await importWith(new Error('kaput'));

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Import SAML local signing DR bundle error',
      {},
      expect.any(Error)
    );
  });

  it('reports the reload_settings stage when settings cannot be read back', async () => {
    mocks.importDR.mockResolvedValue({ importedKeys: 1, restoredRoles: ['idp'] });
    const entityId = await import('../../common/entity-id');
    vi.spyOn(entityId, 'getSAMLPublicSettings').mockRejectedValueOnce(new Error('kv down'));

    const response = await handleImportSAMLLocalSigningDRBundle(
      harnessContext({ body: { bundle: {}, passphrase: 'pw' } })
    );

    expect(response.status).toBe(500);
    expect(description(await bodyOf<unknown>(response))).toContain('stage=reload settings');
  });

  it('returns the step-up refusal raised from the pre-write gate', async () => {
    mocks.stepUp.mockResolvedValueOnce(new Response('step-up', { status: 428 }));
    mocks.importDR.mockImplementation(async (...args: unknown[]) => {
      await (args[4] as () => Promise<void>)();
      return { importedKeys: 1, restoredRoles: [] };
    });

    const response = await handleImportSAMLLocalSigningDRBundle(
      harnessContext({ body: { bundle: { b: 1 }, passphrase: 'pw' } })
    );

    expect(response.status).toBe(428);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('imports, audits the restored roles and returns the settings with no-store headers', async () => {
    const responseHeaders: Record<string, string> = {};
    mocks.importDR.mockResolvedValue({ importedKeys: 3, restoredRoles: ['idp', 'sp'] });

    const response = await handleImportSAMLLocalSigningDRBundle(
      harnessContext({ body: { bundle: { b: 1 }, passphrase: 'pw' }, responseHeaders })
    );

    expect(response.status).toBe(200);
    expect(responseHeaders).toEqual({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    const body = await bodyOf<unknown>(response);
    expect(dig(body, 'imported')).toEqual({ importedKeys: 3, restoredRoles: ['idp', 'sp'] });
    expect(dig(body, 'localSigning', 'idpSigningKeyPolicy', 'active', 'kid')).toBe('k');
    expect(dig(body, 'localSigning', 'spSigningKeyPolicy')).toEqual({});
    expect(dig(body, 'generated', 'issuerUrl')).toBe('https://tenant.example.test');
    const entry = mocks.audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'saml.local_signing.dr_bundle.imported',
      severity: 'warning',
      resourceId: 'tenant-a',
    });
    expect(JSON.parse(String(entry.metadata))).toMatchObject({
      imported_key_count: 3,
      restored_roles: ['idp', 'sp'],
    });
  });
});
