import { describe, expect, it } from 'vitest';
import { maskSensitiveFieldsRecursive } from '@authrim/ar-lib-plugin';
import {
  mergeConfigPreservingSecrets,
  UnrestorableMaskedValueError,
} from '../routes/settings/plugins';

const stored = {
  apiKey: 're_live_1234567890abcdef',
  pin: 123456789012,
  defaultFrom: 'noreply@example.com',
  auth: { token: 'tok_live_abcdefghijklmnop', realm: 'main' },
  secrets: ['first-secret-value-123', 'second-secret-value-456'],
  providers: [{ name: 'a', password: 'pw-aaaaaaaaaaaaaaaa' }],
};

function fetched(config: Record<string, unknown>, maxDepth?: number): Record<string, unknown> {
  return maskSensitiveFieldsRecursive(config, {
    usePatternMatching: true,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  });
}

describe('saving back a fetched (masked) plugin configuration', () => {
  it('keeps every stored secret when the masked configuration is saved unchanged', () => {
    const masked = fetched(stored);
    expect(JSON.stringify(masked)).not.toContain('1234567890abcdef');
    expect(mergeConfigPreservingSecrets(stored, masked)).toEqual(stored);
  });

  it('keeps stored secrets and applies the real changes made next to them', () => {
    const edited = {
      ...fetched(stored),
      defaultFrom: 'new@example.com',
      auth: { ...(fetched(stored).auth as object), realm: 'other' },
    };
    expect(mergeConfigPreservingSecrets(stored, edited)).toEqual({
      ...stored,
      defaultFrom: 'new@example.com',
      auth: { token: stored.auth.token, realm: 'other' },
    });
  });

  it('takes a real new secret over the stored one, at any depth', () => {
    const edited = {
      ...fetched(stored),
      apiKey: 're_live_brand_new_key_000',
      pin: 555,
      auth: { token: 'tok_live_replacement_token', realm: 'main' },
      secrets: ['first-secret-value-123', 'changed-secret-value-789'],
    };
    const merged = mergeConfigPreservingSecrets(stored, edited);
    expect(merged.apiKey).toBe('re_live_brand_new_key_000');
    expect(merged.pin).toBe(555);
    expect((merged.auth as { token: string }).token).toBe('tok_live_replacement_token');
    expect(merged.secrets).toEqual(['first-secret-value-123', 'changed-secret-value-789']);
  });

  it('restores a subtree the masker replaced with the depth placeholder', () => {
    const deep = { level: { a: { b: { c: { password: 'deep-secret-value-000000' } } } } };
    const masked = fetched(deep, 2);
    expect(JSON.stringify(masked)).toContain('[MAX_DEPTH_EXCEEDED]');
    expect(mergeConfigPreservingSecrets(deep, masked)).toEqual(deep);
  });

  it('does not treat a mask-looking value of a non-secret field as a placeholder', () => {
    const merged = mergeConfigPreservingSecrets(
      { note: 'plain', defaultFrom: 'a@example.com' },
      { note: 'five ***** stars' }
    );
    expect(merged.note).toBe('five ***** stars');
  });

  it('keeps stored keys the patch does not mention', () => {
    expect(mergeConfigPreservingSecrets(stored, { defaultFrom: 'x@example.com' })).toEqual({
      ...stored,
      defaultFrom: 'x@example.com',
    });
  });

  it('refuses a mask when there is no stored secret to restore', () => {
    expect(() => mergeConfigPreservingSecrets({}, { apiKey: 're_l****5678' })).toThrow(
      UnrestorableMaskedValueError
    );
    expect(() => mergeConfigPreservingSecrets({}, { apiKey: '****' })).toThrow(
      UnrestorableMaskedValueError
    );
    expect(() =>
      mergeConfigPreservingSecrets({ other: 'x' }, { auth: { token: 'tok_****mnop' } })
    ).toThrow(UnrestorableMaskedValueError);
  });

  it('saves a new secret that merely contains asterisks, as given', () => {
    const merged = mergeConfigPreservingSecrets(stored, { apiKey: 'my****secret-with-stars' });
    expect(merged.apiKey).toBe('my****secret-with-stars');
    // Same shape as a mask but not the mask of the stored value: a real new value.
    expect(mergeConfigPreservingSecrets(stored, { apiKey: 'abcd****wxyz' }).apiKey).toBe(
      'abcd****wxyz'
    );
    expect(mergeConfigPreservingSecrets(stored, { apiKey: '****' }).apiKey).toBe('****');
  });

  it('restores only the exact mask of the stored value', () => {
    const mask = fetched(stored).apiKey;
    expect(mergeConfigPreservingSecrets(stored, { apiKey: mask }).apiKey).toBe(stored.apiKey);
  });

  it('treats the depth placeholder as a value of a non-object setting', () => {
    expect(mergeConfigPreservingSecrets(stored, { defaultFrom: '[MAX_DEPTH_EXCEEDED]' })).toEqual({
      ...stored,
      defaultFrom: '[MAX_DEPTH_EXCEEDED]',
    });
    expect(() => mergeConfigPreservingSecrets({}, { level: '[MAX_DEPTH_EXCEEDED]' })).toThrow(
      UnrestorableMaskedValueError
    );
  });

  describe('arrays of settings', () => {
    const providers = [
      { name: 'alpha', password: 'alpha-password-000000' },
      { name: 'beta', password: 'beta-password-1111111' },
      { name: 'gamma', password: 'gamma-password-222222' },
    ];

    it('gives each element its own secret after a reorder', () => {
      const masked = fetched({ providers }).providers as unknown[];
      const reordered = [masked[2], masked[0], masked[1]];
      expect(mergeConfigPreservingSecrets({ providers }, { providers: reordered })).toEqual({
        providers: [providers[2], providers[0], providers[1]],
      });
    });

    it('keeps the right secrets when the first element is deleted', () => {
      const masked = fetched({ providers }).providers as unknown[];
      expect(mergeConfigPreservingSecrets({ providers }, { providers: masked.slice(1) })).toEqual({
        providers: [providers[1], providers[2]],
      });
    });

    it('keeps the right secrets when an element is inserted, and refuses the new one masked', () => {
      const masked = fetched({ providers }).providers as Array<Record<string, unknown>>;
      const inserted = [
        masked[0],
        { name: 'new', password: 'new-password-33333333' },
        masked[1],
        masked[2],
      ];
      expect(mergeConfigPreservingSecrets({ providers }, { providers: inserted })).toEqual({
        providers: [providers[0], inserted[1], providers[1], providers[2]],
      });
      const newWithMask = [{ name: 'new', password: masked[0]?.password }, ...masked.slice(1)];
      expect(() => mergeConfigPreservingSecrets({ providers }, { providers: newWithMask })).toThrow(
        UnrestorableMaskedValueError
      );
    });

    it('restores by index only while an array without identifiers keeps its length', () => {
      const secretsStored = { passwords: ['first-secret-value-123', 'second-secret-value-456'] };
      const masked = fetched(secretsStored).passwords as string[];
      expect(mergeConfigPreservingSecrets(secretsStored, { passwords: masked })).toEqual(
        secretsStored
      );
      // A deletion changes the length: nothing is restored across it.
      expect(() =>
        mergeConfigPreservingSecrets(secretsStored, { passwords: masked.slice(1) })
      ).toThrow(UnrestorableMaskedValueError);
      // A reorder at the same length does not hand an element another's secret.
      const reordered = mergeConfigPreservingSecrets(secretsStored, {
        passwords: [masked[1], masked[0]],
      }).passwords as string[];
      expect(reordered[1]).not.toBe(secretsStored.passwords[1]);
      expect(reordered[0]).not.toBe(secretsStored.passwords[0]);
    });
  });
});
