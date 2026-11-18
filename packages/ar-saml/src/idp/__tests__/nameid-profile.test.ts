/**
 * loadSAMLNameIdProfile reads the NameID section of the active destination profile version.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { loadSAMLNameIdProfile } from '../nameid-profile';

function adapterReturning(row: { schema_json: string } | null) {
  const queryOne = vi.fn(async () => row);
  return { adapter: { queryOne } as unknown as DatabaseAdapter, queryOne };
}

describe('loadSAMLNameIdProfile', () => {
  it('should query the active SAML profile version for the tenant (or the platform) by id', async () => {
    const { adapter, queryOne } = adapterReturning({
      schema_json: JSON.stringify({ nameId: { format: 'urn:f', classification: 'public' } }),
    });

    await loadSAMLNameIdProfile(adapter, 'tenant-a', 'profile-1');

    expect(queryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = queryOne.mock.calls[0] as unknown as [string, unknown[]];
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain('FROM destination_profiles p');
    expect(normalized).toContain('v.id = p.active_version_id');
    expect(normalized).toContain("p.tenant_id IN (?, 'platform')");
    expect(normalized).toContain("p.destination_type = 'saml'");
    expect(normalized).toContain("p.lifecycle_state = 'active' AND v.lifecycle_state = 'active'");
    expect(params).toEqual(['profile-1', 'tenant-a']);
  });

  it('should return the format and classification from the schema', async () => {
    const { adapter } = adapterReturning({
      schema_json: JSON.stringify({
        nameId: {
          format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          classification: 'pseudonymous',
        },
      }),
    });
    expect(await loadSAMLNameIdProfile(adapter, 't', 'p')).toEqual({
      format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      classification: 'pseudonymous',
    });
  });

  it('should default classification to internal and format to null when they are not strings', async () => {
    const { adapter } = adapterReturning({
      schema_json: JSON.stringify({ nameId: { format: 42, classification: null } }),
    });
    expect(await loadSAMLNameIdProfile(adapter, 't', 'p')).toEqual({
      format: null,
      classification: 'internal',
    });

    const empty = adapterReturning({ schema_json: JSON.stringify({ nameId: {} }) });
    expect(await loadSAMLNameIdProfile(empty.adapter, 't', 'p')).toEqual({
      format: null,
      classification: 'internal',
    });
  });

  it('should return null when no active profile matches', async () => {
    const { adapter } = adapterReturning(null);
    expect(await loadSAMLNameIdProfile(adapter, 't', 'missing')).toBeNull();
  });

  it.each([
    ['the schema is not an object', JSON.stringify('just a string')],
    ['the schema is an array', JSON.stringify([{ nameId: {} }])],
    ['the schema is null', JSON.stringify(null)],
    ['nameId is missing', JSON.stringify({ attributes: [] })],
    ['nameId is not an object', JSON.stringify({ nameId: 'urn:f' })],
    ['nameId is an array', JSON.stringify({ nameId: ['urn:f'] })],
  ])('should return null when %s', async (_label, schema_json) => {
    const { adapter } = adapterReturning({ schema_json });
    expect(await loadSAMLNameIdProfile(adapter, 't', 'p')).toBeNull();
  });

  it('should propagate malformed JSON as an error', async () => {
    const { adapter } = adapterReturning({ schema_json: '{not json' });
    await expect(loadSAMLNameIdProfile(adapter, 't', 'p')).rejects.toBeInstanceOf(SyntaxError);
  });
});
