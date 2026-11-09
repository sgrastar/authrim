import { describe, expect, it } from 'vitest';
import type { ClientMetadata } from '@authrim/ar-lib-core';
import {
  evaluateDeviceSecretIntrospectionPolicy,
  evaluateDeviceSecretRevokePolicy,
  resolveDeviceSecretCallerClass,
} from '../device-secret-policy';

function client(input: Record<string, unknown> = {}): ClientMetadata {
  return {
    client_id: 'caller-client',
    application_type: 'native',
    ...input,
  } as ClientMetadata;
}

const own = { clientId: 'caller-client', trustGroupId: 'group-a' };
const other = { clientId: 'other-client', trustGroupId: 'group-a' };

describe('device secret caller classification', () => {
  it.each([
    [client(), 'native_public_client'],
    [client({ application_type: 'web' }), 'public_client'],
    [client({ client_secret_hash: 'stored-hash' }), 'confidential_or_service_client'],
    [
      client({ application_type: 'web', client_secret_hash: 'stored-hash' }),
      'confidential_or_service_client',
    ],
  ] as const)(
    'classifies the caller from client type and secret presence',
    (metadata, expected) => {
      expect(resolveDeviceSecretCallerClass(metadata)).toBe(expected);
    }
  );
});

describe('device secret revoke policy', () => {
  it('lets a native public client revoke only its own secret', () => {
    expect(evaluateDeviceSecretRevokePolicy(client(), own)).toEqual({
      allowed: true,
      callerClass: 'native_public_client',
    });
    expect(evaluateDeviceSecretRevokePolicy(client(), other)).toMatchObject({
      allowed: false,
      code: 'revoke_disabled',
    });
  });

  it('keeps a web public client denied even when the target belongs to it', () => {
    expect(evaluateDeviceSecretRevokePolicy(client({ application_type: 'web' }), own)).toEqual({
      allowed: false,
      callerClass: 'public_client',
      code: 'revoke_disabled',
      description: 'Device secret revocation is disabled for this caller',
    });
  });

  it('requires an explicit flag for a confidential client to revoke its own secret', () => {
    const confidential = client({ client_secret_hash: 'stored-hash' });
    expect(evaluateDeviceSecretRevokePolicy(confidential, own).allowed).toBe(false);
    expect(
      evaluateDeviceSecretRevokePolicy(
        client({ client_secret_hash: 'stored-hash', device_secret_revoke_enabled: true }),
        own
      )
    ).toEqual({ allowed: true, callerClass: 'confidential_or_service_client' });
  });

  it('allows cross-client revocation only within the matching allowlisted trust group', () => {
    const allowed = client({
      client_secret_hash: 'stored-hash',
      trust_group_id: 'group-a',
      device_secret_revoke_trust_groups: ['group-a'],
    });
    expect(evaluateDeviceSecretRevokePolicy(allowed, other).allowed).toBe(true);
    expect(
      evaluateDeviceSecretRevokePolicy(allowed, { ...other, trustGroupId: 'group-b' })
    ).toMatchObject({ allowed: false, code: 'revoke_disabled' });
    expect(
      evaluateDeviceSecretRevokePolicy(client({ ...allowed, trust_group_id: 'group-b' }), other)
    ).toMatchObject({ allowed: false, code: 'revoke_disabled' });
  });

  it('applies wildcard trust groups only after proving caller and target membership match', () => {
    const metadata = client({
      client_secret_hash: 'stored-hash',
      trust_group: 'group-a',
      device_secret_revoke_trust_groups: ['*'],
    });
    expect(evaluateDeviceSecretRevokePolicy(metadata, other).allowed).toBe(true);
    expect(evaluateDeviceSecretRevokePolicy(metadata, { clientId: 'other-client' })).toMatchObject({
      allowed: false,
      code: 'revoke_disabled',
    });
  });
});

describe('device secret introspection policy', () => {
  it.each([client(), client({ application_type: 'web' })])(
    'rejects public callers even for their own secret',
    (metadata) => {
      expect(evaluateDeviceSecretIntrospectionPolicy(metadata, own)).toMatchObject({
        allowed: false,
        code: 'unauthorized_introspection_caller',
      });
    }
  );

  it('allows the confidential owner by default but respects an explicit disable', () => {
    const confidential = client({ client_secret_hash: 'stored-hash' });
    expect(evaluateDeviceSecretIntrospectionPolicy(confidential, own)).toEqual({
      allowed: true,
      callerClass: 'confidential_or_service_client',
    });
    expect(
      evaluateDeviceSecretIntrospectionPolicy(
        client({ client_secret_hash: 'stored-hash', device_secret_introspection_enabled: false }),
        own
      )
    ).toMatchObject({ allowed: false, code: 'introspection_disabled' });
  });

  it('does not infer cross-client authority from a matching trust group alone', () => {
    const metadata = client({ client_secret_hash: 'stored-hash', trust_group_id: 'group-a' });
    expect(evaluateDeviceSecretIntrospectionPolicy(metadata, other)).toMatchObject({
      allowed: false,
      code: 'unauthorized_introspection_caller',
    });
  });

  it('requires an allowlisted group for cross-client introspection', () => {
    const metadata = client({
      client_secret_hash: 'stored-hash',
      trust_group_id: 'group-a',
      device_secret_introspection_trust_groups: ['group-a'],
    });
    expect(evaluateDeviceSecretIntrospectionPolicy(metadata, other).allowed).toBe(true);
    expect(
      evaluateDeviceSecretIntrospectionPolicy(metadata, { ...other, trustGroupId: 'group-b' })
    ).toMatchObject({ allowed: false, code: 'unauthorized_introspection_caller' });
    expect(
      evaluateDeviceSecretIntrospectionPolicy(
        client({ ...metadata, device_secret_introspection_enabled: false }),
        other
      )
    ).toMatchObject({ allowed: false, code: 'introspection_disabled' });
  });
});
