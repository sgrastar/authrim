/**
 * handleUpdateSAMLLocalSigning with the real rollover functions: the certificate publication mode
 * that results from the combination of active, next and backup keys.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dig, harnessContext, parseJson } from './helpers/provider-handler-harness';

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  settings: null as Record<string, unknown> | null,
  putSigning: vi.fn(async (_env: unknown, _tenant: string, value: unknown) => value),
  rotate: vi.fn(async (..._args: unknown[]) => ({
    keyRef: 'tenant:tenant-a:idp:generated',
    kid: 'generated-kid',
    certificate: 'generated-certificate',
  })),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
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
    getSAMLPublicSettings: vi.fn(async () => mocks.settings),
    getSAMLLocalEntityIds: vi.fn(async () => ({
      issuerUrl: 'https://tenant.example.test',
      idpEntityId: 'https://tenant.example.test/saml/idp',
      spEntityId: 'https://tenant.example.test/saml/sp',
      idpMetadataUrl: 'https://tenant.example.test/saml/idp/metadata',
      spMetadataUrl: 'https://tenant.example.test/saml/sp/metadata',
    })),
    putSAMLLocalSigningSettings: mocks.putSigning,
  };
});

vi.mock('../../common/key-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/key-utils')>();
  return { ...actual, rotateSigningKeyWithCertificate: mocks.rotate };
});

import { handleUpdateSAMLLocalSigning } from '../providers';

const ACTIVE = {
  slot: 'active',
  keyRef: 'tenant:tenant-a:idp:active',
  kid: 'active-kid',
  certificate: 'ACTIVE',
  state: 'active',
};
const NEXT = {
  slot: 'next',
  id: 'n1',
  keyRef: 'tenant:tenant-a:idp:next',
  kid: 'next-kid',
  certificate: 'NEXT',
  state: 'published_next',
};
const BACKUP = { ...ACTIVE, slot: 'backup', keyRef: 'tenant:tenant-a:idp:backup', kid: 'b-kid' };

function settings(idp: Record<string, unknown>) {
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
    certificateSubjectAlternativeNames: { dnsNames: [] },
    signingKeyPolicies: { idp, sp: {} },
  };
}

function savedIdpPolicy(): unknown {
  const saved = mocks.putSigning.mock.calls[0]?.[2];
  return dig(saved, 'signingKeyPolicies', 'idp');
}

async function run(body: Record<string, unknown>, permissions?: string[]) {
  return handleUpdateSAMLLocalSigning(harnessContext({ body, permissions }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('metadataCertificatePublication after recreating the active key', () => {
  it.each([
    { label: 'no next key', policy: { active: ACTIVE }, expected: 'active_only' },
    {
      label: 'a next key',
      policy: { active: ACTIVE, nextCandidates: [NEXT] },
      expected: 'active_next',
    },
    {
      label: 'a next and a backup key',
      policy: { active: ACTIVE, nextCandidates: [NEXT], backup: BACKUP },
      expected: 'active_next_backup',
    },
    {
      label: 'only a backup key',
      policy: { active: ACTIVE, backup: BACKUP },
      expected: 'active_only',
    },
  ])('with $label publishes $expected', async ({ policy, expected }) => {
    mocks.settings = settings(policy);

    const response = await run({ role: 'idp', action: 'recreate_active' });

    expect(response.status).toBe(200);
    expect(dig(savedIdpPolicy(), 'metadataCertificatePublication')).toBe(expected);
    expect(dig(savedIdpPolicy(), 'active', 'kid')).toBe('generated-kid');
    expect(dig(savedIdpPolicy(), 'active', 'state')).toBe('active');
  });

  it('reuses the key reference of the current active key', async () => {
    mocks.settings = settings({ active: ACTIVE });

    await run({ role: 'idp', action: 'recreate_active' });

    expect(dig(mocks.rotate.mock.calls[0], 2, 'keyRef')).toBe('tenant:tenant-a:idp:active');
  });
});

describe('publishing a next key', () => {
  it.each([
    { label: 'without a backup', policy: { active: ACTIVE }, expected: 'active_next' },
    {
      label: 'with a backup',
      policy: { active: ACTIVE, backup: BACKUP },
      expected: 'active_next_backup',
    },
  ])('publishes $label as $expected', async ({ policy, expected }) => {
    mocks.settings = settings(policy);

    const response = await run({ role: 'idp', action: 'publish_next' });

    expect(response.status).toBe(200);
    expect(dig(savedIdpPolicy(), 'metadataCertificatePublication')).toBe(expected);
    expect(dig(savedIdpPolicy(), 'nextCandidates', 0, 'kid')).toBe('generated-kid');
    expect(String(dig(mocks.rotate.mock.calls[0], 2, 'keyRef'))).toMatch(
      /^tenant:tenant-a:.*:next:\d+$/
    );
  });
});

describe('audit and permissions', () => {
  it.each([
    ['recreate_active', 'warning'],
    ['promote_next', 'warning'],
    ['publish_next', 'info'],
    ['retire_backup', 'info'],
    ['delete_next', 'info'],
  ])('audits %s with severity %s', async (action, severity) => {
    mocks.settings = settings({ active: ACTIVE, nextCandidates: [NEXT], backup: BACKUP });

    const response = await run({ role: 'idp', action });

    expect(response.status).toBe(200);
    const entry = mocks.audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: `saml.local_signing.${action}`,
      resource: 'saml_settings',
      resourceId: 'tenant-a:idp',
      severity,
    });
    const metadata = parseJson(String(entry.metadata));
    expect(dig(metadata, 'role')).toBe('idp');
  });

  it('refuses a caller without the update permission', async () => {
    mocks.settings = settings({ active: ACTIVE });

    expect((await run({ role: 'idp', action: 'retire_backup' }, [])).status).toBe(403);
    expect(mocks.putSigning).not.toHaveBeenCalled();
  });

  it('stops before generating a key when the step-up refuses', async () => {
    mocks.settings = settings({ active: ACTIVE });
    mocks.stepUp.mockResolvedValueOnce(new Response('step-up', { status: 428 }));

    const response = await run({ role: 'idp', action: 'recreate_active' });

    expect(response.status).toBe(428);
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.putSigning).not.toHaveBeenCalled();
  });

  it('keeps previous active as backup on promotion unless told otherwise', async () => {
    mocks.settings = settings({ active: ACTIVE, nextCandidates: [NEXT] });

    await run({ role: 'idp', action: 'promote_next' });
    expect(dig(savedIdpPolicy(), 'backup', 'kid')).toBe('active-kid');
    expect(dig(savedIdpPolicy(), 'active', 'kid')).toBe('next-kid');

    mocks.putSigning.mockClear();
    await run({ role: 'idp', action: 'promote_next', keepPreviousAsBackup: false });
    expect(dig(savedIdpPolicy(), 'backup')).toBeUndefined();
    expect(dig(savedIdpPolicy(), 'metadataCertificatePublication')).toBe('active_only');
  });
});
