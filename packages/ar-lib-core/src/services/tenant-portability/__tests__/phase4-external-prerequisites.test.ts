import { expect, it } from 'vitest';
import { assertPhase4ExternalPrerequisitesResolved } from '../phase4-external-prerequisites';

it('accepts included tenant material and resolved target-side dependencies', () => {
  expect(
    assertPhase4ExternalPrerequisitesResolved([
      {
        id: 'shared/email/default',
        kind: 'email_delivery',
        scope: 'shared',
        resolution: 'target_binding',
        status: 'resolved',
        required: true,
      },
      {
        id: 'tenant-a/directory/hr',
        kind: 'directory_connection',
        scope: 'tenant',
        resolution: 'reconnect',
        status: 'resolved',
        required: false,
      },
      {
        id: 'tenant-a/signing/oidc',
        kind: 'key_material',
        scope: 'tenant',
        resolution: 'included',
        status: 'resolved',
        required: true,
      },
    ])
  ).toEqual([
    expect.objectContaining({ id: 'shared/email/default' }),
    expect.objectContaining({ id: 'tenant-a/directory/hr' }),
    expect.objectContaining({ id: 'tenant-a/signing/oidc' }),
  ]);
});

it('stops activation when a required dependency is unresolved', () => {
  expect(() =>
    assertPhase4ExternalPrerequisitesResolved([
      {
        id: 'kms/customer-key',
        kind: 'key_material',
        scope: 'tenant',
        resolution: 'target_binding',
        status: 'unresolved',
        required: true,
      },
    ])
  ).toThrow('backup_phase4_prerequisites_unresolved');
});

it('rejects secret-bearing or contradictory prerequisite records', () => {
  expect(() =>
    assertPhase4ExternalPrerequisitesResolved([
      {
        id: 'shared/signing-root',
        kind: 'shared_key',
        scope: 'shared',
        resolution: 'included',
        status: 'resolved',
        required: true,
      },
    ])
  ).toThrow('backup_phase4_prerequisites_invalid');

  expect(() =>
    assertPhase4ExternalPrerequisitesResolved([
      {
        id: 'kms/customer-key',
        kind: 'key_material',
        scope: 'tenant',
        resolution: 'target_binding',
        status: 'resolved',
        required: true,
        secret: 'must-not-be-returned',
      },
    ])
  ).toThrow('backup_phase4_prerequisites_invalid');
});
