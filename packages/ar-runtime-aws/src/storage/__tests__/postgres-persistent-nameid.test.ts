import { describe, expect, it } from 'vitest';
import { validateSAMLPersistentNameIDRecord } from '../postgres-persistent-nameid';

const key =
  'saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.test%2Fsaml:subject:user-a';

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    tenantId: 'tenant-a',
    spEntityId: 'https://sp.example.test/saml',
    subjectId: 'user-a',
    nameId: 'stable-nameid',
    createdAt: 1000,
    ...overrides,
  });
}

describe('validateSAMLPersistentNameIDRecord', () => {
  it('accepts the tenant, SP, subject and timestamp bound to the encoded registry key', () => {
    expect(validateSAMLPersistentNameIDRecord(key, record())).toEqual({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test/saml',
      subjectId: 'user-a',
      createdAt: 1000,
    });
  });

  it.each([
    record({ tenantId: 'tenant-b' }),
    record({ spEntityId: 'https://other.example.test/saml' }),
    record({ subjectId: 'user-b' }),
    record({ createdAt: 0 }),
    record({ nameId: '' }),
    '{',
  ])('rejects unbound or malformed source records', (value) => {
    expect(() => validateSAMLPersistentNameIDRecord(key, value)).toThrow(
      'aws_persistent_nameid_invalid'
    );
  });
});
