import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  directoryIdentityLookupSubject,
  guestResumeCredentialLookupSubject,
  passkeyCredentialLookupSubject,
} from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => {
  const tenantMetadata: { value: unknown } = { value: undefined };
  return { byIdentifier: vi.fn(), byUser: vi.fn(), tenantMetadata };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAccountDataContextByIdentifierFromHono: mocks.byIdentifier,
    resolveAccountDataContextFromHono: mocks.byUser,
    getTenantMetadataContextFromHono: () => mocks.tenantMetadata.value,
  };
});

import {
  isDeletedDestinationRouteError,
  publishDirectoryRoute,
  publishPasskeyRoute,
  publishTenantD1PasskeyRoute,
  resolveDirectoryAccountRoute,
  resolveEmailAccountRoute,
  resolveGuestAccountRoute,
  resolvePasskeyAccountRoute,
  resolveTenantD1EmailAccountRoute,
  resolveTenantD1PasskeyAccountRoute,
  usesRoutedAccountStorage,
} from '../account-provisioning';
import { TENANT_ID, accountContext, sha256HexOf } from './helpers/mut-account-context';

const ACCOUNT = { tenantId: TENANT_ID, accountId: 'account:user-a', legacyUserId: 'user-a' };
const PASSKEY = {
  tenantId: TENANT_ID,
  userId: 'user-a',
  passkeyId: 'passkey-a',
  credentialId: 'credential_A-1',
  rpId: 'login.example.com',
};
const DIRECTORY = {
  tenantId: TENANT_ID,
  userId: 'user-a',
  connectorId: 'connector-a',
  directorySubject: 'cn=person',
};
const routeMissing = () => new Error('account_data_route_not_found');

beforeEach(() => {
  mocks.byIdentifier.mockReset().mockResolvedValue(ACCOUNT);
  mocks.byUser.mockReset().mockResolvedValue(ACCOUNT);
  mocks.tenantMetadata.value = { route: { allocationScope: 'tenant_exclusive' } };
});

describe('account route lookups', () => {
  it('resolves an email route by exact address', async () => {
    const { c } = accountContext();
    await expect(resolveEmailAccountRoute(c, 'person@example.com')).resolves.toBe('resolved');
    expect(mocks.byIdentifier).toHaveBeenCalledWith(c, {
      indexKind: 'email_exact',
      identifier: 'person@example.com',
    });
  });

  it('reports a missing email route and rethrows other failures', async () => {
    const { c } = accountContext();
    mocks.byIdentifier.mockRejectedValueOnce(routeMissing());
    await expect(resolveEmailAccountRoute(c, 'x@example.com')).resolves.toBe('not_found');
    mocks.byIdentifier.mockRejectedValueOnce(new Error('store_down'));
    await expect(resolveEmailAccountRoute(c, 'x@example.com')).rejects.toThrow('store_down');
    mocks.byIdentifier.mockRejectedValueOnce('account_data_route_not_found');
    await expect(resolveEmailAccountRoute(c, 'x@example.com')).rejects.toBe(
      'account_data_route_not_found'
    );
  });

  it('resolves passkey and guest routes by their external subjects', async () => {
    const { c } = accountContext();
    const input = { credentialId: 'cred', rpId: 'login.example.com' };
    await expect(resolvePasskeyAccountRoute(c, input)).resolves.toBe(ACCOUNT);
    await expect(resolveGuestAccountRoute(c, 'e'.repeat(64))).resolves.toBe(ACCOUNT);
    expect(mocks.byIdentifier.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      { indexKind: 'external_subject', identifier: passkeyCredentialLookupSubject(input) },
      {
        indexKind: 'external_subject',
        identifier: guestResumeCredentialLookupSubject('e'.repeat(64)),
      },
    ]);
  });

  it('resolves a directory route, null when it has none, and rethrows other failures', async () => {
    const { c } = accountContext();
    const input = { connectorId: 'connector-a', directorySubject: 'cn=person' };
    await expect(resolveDirectoryAccountRoute(c, input)).resolves.toBe(ACCOUNT);
    expect(mocks.byIdentifier).toHaveBeenCalledWith(c, {
      indexKind: 'external_subject',
      identifier: directoryIdentityLookupSubject(input),
    });
    mocks.byIdentifier.mockRejectedValueOnce(routeMissing());
    await expect(resolveDirectoryAccountRoute(c, input)).resolves.toBeNull();
    mocks.byIdentifier.mockRejectedValueOnce(new Error('store_down'));
    await expect(resolveDirectoryAccountRoute(c, input)).rejects.toThrow('store_down');
    mocks.byIdentifier.mockRejectedValueOnce({ message: 'account_data_route_not_found' });
    await expect(resolveDirectoryAccountRoute(c, input)).rejects.toEqual({
      message: 'account_data_route_not_found',
    });
  });
});

describe('tenant routed-storage gates', () => {
  it('skips every routed lookup when the tenant is not routed', async () => {
    mocks.tenantMetadata.value = undefined;
    const { c } = accountContext();
    expect(usesRoutedAccountStorage(c)).toBe(false);
    await expect(resolveTenantD1EmailAccountRoute(c, 'x@example.com')).resolves.toBe(
      'not_required'
    );
    await expect(
      resolveTenantD1PasskeyAccountRoute(c, { credentialId: 'c', rpId: 'r' })
    ).resolves.toBeNull();
    await expect(publishTenantD1PasskeyRoute(c, PASSKEY)).resolves.toBe(201);
    expect(mocks.byIdentifier).not.toHaveBeenCalled();
    expect(mocks.byUser).not.toHaveBeenCalled();
  });

  it('runs the routed lookups for a routed tenant', async () => {
    const publishPasskey = vi.fn().mockResolvedValue({
      status: 202,
      operationId: 'passkey-route-passkey-a',
      accountId: 'account:user-a',
    });
    const { c } = accountContext({ publishPasskey });
    expect(usesRoutedAccountStorage(c)).toBe(true);
    await expect(resolveTenantD1EmailAccountRoute(c, 'x@example.com')).resolves.toBe('resolved');
    await expect(
      resolveTenantD1PasskeyAccountRoute(c, { credentialId: 'c', rpId: 'r' })
    ).resolves.toBe(ACCOUNT);
    await expect(publishTenantD1PasskeyRoute(c, PASSKEY)).resolves.toBe(202);
  });
});

describe('isDeletedDestinationRouteError', () => {
  it('matches only a revalidation failure caused by an inactive account', () => {
    const error = (message: string, cause?: unknown) => new Error(message, { cause });
    expect(
      isDeletedDestinationRouteError(
        error('lookup_destination_revalidation_failed', 'account_inactive')
      )
    ).toBe(true);
    expect(
      isDeletedDestinationRouteError(error('lookup_destination_revalidation_failed', 'other'))
    ).toBe(false);
    expect(isDeletedDestinationRouteError(error('other', 'account_inactive'))).toBe(false);
    expect(
      isDeletedDestinationRouteError({
        message: 'lookup_destination_revalidation_failed',
        cause: 'account_inactive',
      })
    ).toBe(false);
  });
});

describe('passkey route publication', () => {
  const published = (overrides: Record<string, unknown> = {}) =>
    vi.fn().mockResolvedValue({
      status: 201,
      operationId: 'passkey-route-passkey-a',
      accountId: 'account:user-a',
      ...overrides,
    });

  it('publishes the canonical request with a digest idempotency key', async () => {
    const publishPasskey = published();
    const { c } = accountContext({ publishPasskey });
    await expect(publishPasskeyRoute(c, PASSKEY)).resolves.toBe(201);
    expect(mocks.byUser).toHaveBeenCalledWith(c, 'user-a');
    const canonical =
      '{"accountId":"account:user-a","credentialId":"credential_A-1","passkeyId":"passkey-a",' +
      '"rpId":"login.example.com","schemaVersion":1,"tenantId":"tenant-a","userId":"user-a"}';
    expect(publishPasskey).toHaveBeenCalledWith({
      schemaVersion: 1,
      operationId: 'passkey-route-passkey-a',
      idempotencyKey: `auth-passkey-route:${await sha256HexOf(canonical)}`,
      ...PASSKEY,
      accountId: 'account:user-a',
    });
  });

  it('refuses without a provisioner or for another account', async () => {
    await expect(
      publishPasskeyRoute(accountContext({ withoutProvisioner: true }).c, PASSKEY)
    ).rejects.toThrow('account_provisioner_unavailable');
    mocks.byUser.mockResolvedValue({ ...ACCOUNT, legacyUserId: 'user-b' });
    const publishPasskey = published();
    await expect(
      publishPasskeyRoute(accountContext({ publishPasskey }).c, PASSKEY)
    ).rejects.toThrow('passkey_route_account_mismatch');
    expect(publishPasskey).not.toHaveBeenCalled();
  });

  it.each([
    ['another operation', { operationId: 'passkey-route-other' }],
    ['another account', { accountId: 'account:user-b' }],
    ['an unexpected status', { status: 200 }],
  ])('rejects a result for %s', async (_label, overrides) => {
    const { c } = accountContext({ publishPasskey: published(overrides) });
    await expect(publishPasskeyRoute(c, PASSKEY)).rejects.toThrow(
      'passkey_route_publication_result_invalid'
    );
  });
});

describe('directory route publication', () => {
  const canonical =
    '{"accountId":"account:user-a","connectorId":"connector-a","directorySubject":"cn=person",' +
    '"schemaVersion":1,"tenantId":"tenant-a","userId":"user-a"}';
  const published = async (overrides: Record<string, unknown> = {}) =>
    vi.fn().mockResolvedValue({
      status: 202,
      operationId: `directory-route-${(await sha256HexOf(canonical)).slice(0, 32)}`,
      accountId: 'account:user-a',
      ...overrides,
    });

  it('publishes with operation and idempotency ids derived from the canonical link', async () => {
    const publishDirectory = await published();
    const { c } = accountContext({ publishDirectory });
    await expect(publishDirectoryRoute(c, DIRECTORY)).resolves.toBe(202);
    const digest = await sha256HexOf(canonical);
    expect(mocks.byUser).toHaveBeenCalledWith(c, 'user-a');
    expect(publishDirectory).toHaveBeenCalledWith({
      schemaVersion: 1,
      operationId: `directory-route-${digest.slice(0, 32)}`,
      idempotencyKey: `auth-directory-route:${digest}`,
      ...DIRECTORY,
      accountId: 'account:user-a',
    });
  });

  it('refuses without a provisioner or for another account', async () => {
    await expect(
      publishDirectoryRoute(accountContext({ withoutProvisioner: true }).c, DIRECTORY)
    ).rejects.toThrow('account_provisioner_unavailable');
    mocks.byUser.mockResolvedValue({ ...ACCOUNT, legacyUserId: 'user-b' });
    const publishDirectory = await published();
    await expect(
      publishDirectoryRoute(accountContext({ publishDirectory }).c, DIRECTORY)
    ).rejects.toThrow('directory_route_account_mismatch');
    expect(publishDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ['another operation', { operationId: 'directory-route-other' }],
    ['another account', { accountId: 'account:user-b' }],
    ['an unexpected status', { status: 500 }],
  ])('rejects a result for %s', async (_label, overrides) => {
    const { c } = accountContext({ publishDirectory: await published(overrides) });
    await expect(publishDirectoryRoute(c, DIRECTORY)).rejects.toThrow(
      'directory_route_publication_result_invalid'
    );
  });
});
