import { describe, expect, it } from 'vitest';
import {
  grantedPermissionCovers,
  isValidPermission,
  isValidPermissionId,
  isValidPermissionName,
  minimumGrantTierForPermissions,
  parseCheckPermissionInput,
  parseConcretePermission,
  parsePermissionString,
} from '../permission-grammar';

describe('permission grammar', () => {
  it.each([
    ['documents:read', { kind: 'type_level', resource: 'documents', action: 'read' }],
    [
      'documents:doc_42:read',
      { kind: 'id_level', resource: 'documents', id: 'doc_42', action: 'read' },
    ],
    [
      'invoices:INV-2026/07.a@b:approve_once',
      { kind: 'id_level', resource: 'invoices', id: 'INV-2026/07.a@b', action: 'approve_once' },
    ],
    ['documents:*', { kind: 'resource_wildcard', resource: 'documents' }],
    ['*:*', { kind: 'all' }],
    ['*', { kind: 'all' }],
  ])('parses the granted permission %s', (value, expected) => {
    expect(parsePermissionString(value)).toEqual(expected);
    expect(isValidPermission(value)).toBe(true);
  });

  it.each([
    '',
    'documents',
    'Documents:read',
    'my-docs:read',
    '2docs:read',
    'documents:Read',
    'documents:read-all',
    ':read',
    'documents:',
    'documents::read',
    'documents:doc 42:read',
    'documents:doc\t42:read',
    'documents:doc_42:*',
    '*:read',
    '*:doc_42:read',
    'a:b:c:d',
    '**',
    ' documents:read',
  ])('refuses %j', (value) => {
    expect(parsePermissionString(value)).toBeNull();
    expect(isValidPermission(value)).toBe(false);
  });

  it('refuses values that are not strings', () => {
    for (const value of [null, undefined, 42, ['documents', 'read'], { resource: 'x' }]) {
      expect(isValidPermission(value)).toBe(false);
      expect(parseConcretePermission(value)).toBeNull();
    }
  });

  it('checks only concrete permissions', () => {
    expect(parseConcretePermission('documents:read')).not.toBeNull();
    expect(parseConcretePermission('documents:doc_1:read')).not.toBeNull();
    for (const value of ['documents:*', '*:*', '*']) {
      expect(parseConcretePermission(value)).toBeNull();
    }
  });

  it('validates names and ids', () => {
    expect(isValidPermissionName('read_all2')).toBe(true);
    expect(isValidPermissionName('_read')).toBe(false);
    expect(isValidPermissionName('*')).toBe(false);
    expect(isValidPermissionId('a:b')).toBe(false);
    expect(isValidPermissionId('')).toBe(false);
    expect(isValidPermissionId('ä-1')).toBe(true);
  });

  it.each([
    [[], 1],
    [['documents:read', 'documents:doc_1:read'], 1],
    [['documents:*'], 2],
    [['documents:read', 'reports:*'], 2],
    [['reports:*', '*'], 3],
    [['*:*'], 3],
    [['not a permission'], 1],
  ])('requires grant tier for %j: %i', (permissions, tier) => {
    expect(minimumGrantTierForPermissions(permissions)).toBe(tier);
  });

  it.each(['doc\u00001', 'doc\u00071', 'doc\u007f1', 'doc\u00851', 'doc\n1'])(
    'refuses the control character in the id %j',
    (id) => {
      expect(isValidPermissionId(id)).toBe(false);
      expect(isValidPermission(`documents:${id}:read`)).toBe(false);
    }
  );

  it('matches * and *:* identically, resource:* by resource, others exactly', () => {
    const type = { kind: 'type_level', resource: 'documents', action: 'read' } as const;
    const id = { kind: 'id_level', resource: 'documents', id: 'doc_1', action: 'read' } as const;
    for (const held of ['*', '*:*', 'documents:*']) {
      expect(grantedPermissionCovers(held, type)).toBe(true);
      expect(grantedPermissionCovers(held, id)).toBe(true);
    }
    expect(grantedPermissionCovers('reports:*', type)).toBe(false);
    expect(grantedPermissionCovers('documents:read', type)).toBe(true);
    expect(grantedPermissionCovers('documents:read', id)).toBe(false);
    expect(grantedPermissionCovers('documents:doc_1:read', id)).toBe(true);
    expect(grantedPermissionCovers('documents:doc_2:read', id)).toBe(false);
    expect(grantedPermissionCovers('documents:doc_1:read', type)).toBe(false);
    for (const held of ['*:read', 'Documents:read', '', null, 42]) {
      expect(grantedPermissionCovers(held, type)).toBe(false);
    }
  });

  it('parses a check input strictly: string or { resource, id?, action }', () => {
    expect(parseCheckPermissionInput('documents:read')).toEqual({
      kind: 'type_level',
      resource: 'documents',
      action: 'read',
    });
    expect(parseCheckPermissionInput({ resource: 'documents', action: 'read' })).toEqual({
      kind: 'type_level',
      resource: 'documents',
      action: 'read',
    });
    expect(
      parseCheckPermissionInput({ resource: 'documents', id: 'doc_1', action: 'read' })
    ).toMatchObject({ kind: 'id_level', id: 'doc_1' });
    for (const value of [
      { resource: 'documents', id: '', action: 'read' },
      { resource: 'documents', id: null, action: 'read' },
      { resource: 'documents', id: 7, action: 'read' },
      { resource: 'documents', action: 'read', extra: true },
      { resource: 'documents' },
      'documents:*',
      '*',
      ['documents', 'read'],
      null,
      42,
    ]) {
      expect(parseCheckPermissionInput(value)).toBeNull();
    }
  });
});
