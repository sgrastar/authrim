import { describe, expect, it } from 'vitest';
import {
  createLookupAliasIndex,
  createLookupBlindIndex,
  createLookupBlindIndexes,
  normalizeLookupEmail,
  lookupVirtualBucket,
} from '../blind-index';

const KEY = { generation: 7, secret: '0123456789abcdef0123456789abcdef' };

describe('lookup blind indexes', () => {
  it('reuses canonical exact-email normalization without provider-specific rewriting', async () => {
    expect(normalizeLookupEmail('  User.Name+tag@Example.COM  ')).toBe('user.name+tag@example.com');
    const first = await createLookupBlindIndex('email_exact', 'User.Name+tag@Example.COM', KEY);
    const second = await createLookupBlindIndex('email_exact', ' user.name+tag@example.com ', KEY);
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.virtualBucket).toBeGreaterThanOrEqual(0);
    expect(first.virtualBucket).toBeLessThan(4096);
    expect(JSON.stringify(first)).not.toContain('user.name');
  });

  it('domain-separates identifier kinds and length-prefixes external subject tuples', async () => {
    const account = await createLookupBlindIndex('account_id', 'same-value', KEY);
    const email = await createLookupBlindIndex('email_exact', 'same-value@example.com', KEY);
    const externalA = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'https://issuer.example/a', subject: 'bc' },
      KEY
    );
    const externalB = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'https://issuer.example/ab', subject: 'c' },
      KEY
    );
    expect(new Set([account.digest, email.digest, externalA.digest, externalB.digest]).size).toBe(
      4
    );
  });

  it('encodes UUID account IDs canonically', async () => {
    const lower = await createLookupBlindIndex(
      'account_id',
      '550e8400-e29b-41d4-a716-446655440000',
      KEY
    );
    const upper = await createLookupBlindIndex(
      'account_id',
      '550E8400-E29B-41D4-A716-446655440000',
      KEY
    );
    expect(lower).toEqual(upper);
  });

  it('supports exactly a current key and optional previous key', async () => {
    const indexes = await createLookupBlindIndexes('email_exact', 'person@example.com', [
      KEY,
      { generation: 6, secret: 'abcdef0123456789abcdef0123456789' },
    ]);
    expect(indexes.map((index) => index.hmacKeyGeneration)).toEqual([7, 6]);
    expect(indexes[0].digest).not.toBe(indexes[1].digest);

    await expect(createLookupBlindIndexes('email_exact', 'person@example.com', [])).rejects.toThrow(
      'lookup_blind_index_key_count_invalid'
    );
    await expect(
      createLookupBlindIndexes('email_exact', 'person@example.com', [KEY, KEY])
    ).rejects.toThrow('lookup_blind_index_key_generation_duplicate');
  });

  it('rejects weak keys and malformed identifiers without reflecting input', async () => {
    await expect(
      createLookupBlindIndex('email_exact', 'raw-secret-value', {
        generation: 1,
        secret: 'short',
      })
    ).rejects.toThrow('lookup_email_invalid');
    await expect(
      createLookupBlindIndex('email_exact', 'raw-secret-value@example.com', {
        generation: 1,
        secret: 'short',
      })
    ).rejects.toThrow('lookup_blind_index_key_too_short');
    await expect(
      createLookupBlindIndex('external_subject', { issuer: '', subject: 'raw-subject' }, KEY)
    ).rejects.toThrow('lookup_external_subject_issuer_invalid');
  });

  it('uses the documented first 12 SHA-256 bits for identifier and alias buckets', async () => {
    const index = await createLookupBlindIndex('email_exact', 'vector@example.com', KEY);
    expect(await lookupVirtualBucket(index.indexKind, index.digest)).toBe(index.virtualBucket);

    const alias = await createLookupAliasIndex('tenant_slug', 'Example-Tenant');
    expect(alias.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(alias.virtualBucket).toBeGreaterThanOrEqual(0);
    expect(alias.virtualBucket).toBeLessThan(4096);
    await expect(createLookupAliasIndex('tenant_slug', 'not a slug')).rejects.toThrow(
      'lookup_alias_invalid'
    );
  });
});
