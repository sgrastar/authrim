import { describe, expect, it } from 'vitest';
import type { DatabaseSource } from '../../../db';
import { resolveAuditPersistenceSourcesFromEnv } from '../runtime-sources';

describe('audit runtime sources', () => {
  it('keeps Core and PII bindings distinct', () => {
    const core = {} as DatabaseSource;
    const pii = {} as DatabaseSource;

    expect(resolveAuditPersistenceSourcesFromEnv({ DB: core, DB_PII: pii })).toEqual({
      coreSource: core,
      piiSource: pii,
    });
  });

  it('fails closed instead of falling back to Core when the PII binding is missing', () => {
    expect(() =>
      resolveAuditPersistenceSourcesFromEnv({
        DB: {} as DatabaseSource,
        DB_PII: undefined as unknown as DatabaseSource,
      })
    ).toThrow('audit_pii_database_binding_missing');
  });
});
