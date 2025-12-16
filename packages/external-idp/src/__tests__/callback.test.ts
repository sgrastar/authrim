/**
 * Callback Handler Tests
 * Tests normalizeUserInfo and other callback functionality
 */

import { describe, it, expect } from 'vitest';

// Since normalizeUserInfo is a private function in callback.ts,
// we export a test-accessible version or re-implement the logic for testing.
// For comprehensive testing, we'll test the logic directly.

/**
 * Implementation of normalizeUserInfo for testing
 * This mirrors the implementation in callback.ts
 */
function normalizeUserInfo(
  userInfo: Record<string, unknown>,
  attributeMapping: Record<string, string>
): Record<string, unknown> {
  // If no mapping provided, return as-is
  if (!attributeMapping || Object.keys(attributeMapping).length === 0) {
    return userInfo;
  }

  const normalized: Record<string, unknown> = { ...userInfo };

  // Apply attribute mapping
  for (const [targetClaim, sourcePath] of Object.entries(attributeMapping)) {
    const value = getNestedValue(userInfo, sourcePath);
    if (value !== undefined) {
      // Convert numbers to strings for sub (required for OIDC compatibility)
      if (targetClaim === 'sub' && typeof value === 'number') {
        normalized[targetClaim] = String(value);
      } else {
        normalized[targetClaim] = value;
      }
    }
  }

  return normalized;
}

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

describe('normalizeUserInfo', () => {
  describe('basic attribute mapping', () => {
    it('should return userInfo as-is when no mapping provided', () => {
      const userInfo = {
        sub: '12345',
        name: 'John Doe',
        email: 'john@example.com',
      };

      const result = normalizeUserInfo(userInfo, {});
      expect(result).toEqual(userInfo);
    });

    it('should return userInfo as-is when mapping is undefined', () => {
      const userInfo = {
        sub: '12345',
        name: 'John Doe',
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = normalizeUserInfo(userInfo, undefined as any);
      expect(result).toEqual(userInfo);
    });

    it('should map simple attributes', () => {
      const userInfo = {
        id: '12345',
        login: 'johndoe',
        avatar_url: 'https://example.com/avatar.jpg',
      };

      const mapping = {
        sub: 'id',
        name: 'login',
        picture: 'avatar_url',
      };

      const result = normalizeUserInfo(userInfo, mapping);

      expect(result.sub).toBe('12345');
      expect(result.name).toBe('johndoe');
      expect(result.picture).toBe('https://example.com/avatar.jpg');
      // Original attributes should still be present
      expect(result.id).toBe('12345');
      expect(result.login).toBe('johndoe');
    });
  });

  describe('GitHub-specific mapping', () => {
    it('should map GitHub numeric id to string sub', () => {
      const githubUserInfo = {
        id: 12345678, // GitHub uses numeric IDs
        login: 'octocat',
        name: 'The Octocat',
        email: 'octocat@github.com',
        avatar_url: 'https://avatars.githubusercontent.com/u/12345678',
      };

      const githubMapping = {
        sub: 'id',
        preferred_username: 'login',
        name: 'name',
        email: 'email',
        picture: 'avatar_url',
      };

      const result = normalizeUserInfo(githubUserInfo, githubMapping);

      // sub should be converted from number to string
      expect(result.sub).toBe('12345678');
      expect(typeof result.sub).toBe('string');
      expect(result.preferred_username).toBe('octocat');
      expect(result.picture).toBe('https://avatars.githubusercontent.com/u/12345678');
    });
  });

  describe('nested attribute mapping', () => {
    it('should map nested attributes using dot notation', () => {
      const twitterUserInfo = {
        data: {
          id: '987654321',
          username: 'twitteruser',
          name: 'Twitter User',
          profile_image_url: 'https://pbs.twimg.com/profile_images/abc.jpg',
        },
      };

      const twitterMapping = {
        sub: 'data.id',
        preferred_username: 'data.username',
        name: 'data.name',
        picture: 'data.profile_image_url',
      };

      const result = normalizeUserInfo(twitterUserInfo, twitterMapping);

      expect(result.sub).toBe('987654321');
      expect(result.preferred_username).toBe('twitteruser');
      expect(result.name).toBe('Twitter User');
      expect(result.picture).toBe('https://pbs.twimg.com/profile_images/abc.jpg');
    });

    it('should handle deeply nested attributes', () => {
      const userInfo = {
        response: {
          user: {
            profile: {
              id: 'deep-nested-id',
            },
          },
        },
      };

      const mapping = {
        sub: 'response.user.profile.id',
      };

      const result = normalizeUserInfo(userInfo, mapping);
      expect(result.sub).toBe('deep-nested-id');
    });

    it('should return undefined for non-existent nested paths', () => {
      const userInfo = {
        data: {
          id: '123',
        },
      };

      const mapping = {
        sub: 'data.nonexistent.path',
        name: 'missing.attribute',
      };

      const result = normalizeUserInfo(userInfo, mapping);

      // Original data should still be present
      expect(result.data).toEqual({ id: '123' });
      // Mapped attributes should not be set if source is undefined
      expect(result.sub).toBeUndefined();
      expect(result.name).toBeUndefined();
    });
  });

  describe('Facebook-specific mapping', () => {
    it('should map Facebook id to sub', () => {
      const facebookUserInfo = {
        id: '10000123456789',
        name: 'Facebook User',
        email: 'user@facebook.com',
        picture: {
          data: {
            url: 'https://graph.facebook.com/10000123456789/picture',
          },
        },
      };

      const facebookMapping = {
        sub: 'id',
        name: 'name',
        email: 'email',
        picture: 'picture.data.url',
      };

      const result = normalizeUserInfo(facebookUserInfo, facebookMapping);

      expect(result.sub).toBe('10000123456789');
      expect(result.name).toBe('Facebook User');
      expect(result.picture).toBe('https://graph.facebook.com/10000123456789/picture');
    });
  });

  describe('edge cases', () => {
    it('should handle null values in source', () => {
      const userInfo = {
        id: '123',
        name: null,
        email: undefined,
      };

      const mapping = {
        sub: 'id',
        name: 'name',
        email: 'email',
      };

      const result = normalizeUserInfo(userInfo, mapping);

      expect(result.sub).toBe('123');
      expect(result.name).toBe(null);
      expect(result.email).toBeUndefined();
    });

    it('should handle empty string values', () => {
      const userInfo = {
        id: '',
        name: 'Test',
      };

      const mapping = {
        sub: 'id',
      };

      const result = normalizeUserInfo(userInfo, mapping);
      expect(result.sub).toBe('');
    });

    it('should handle zero as numeric id', () => {
      const userInfo = {
        id: 0,
      };

      const mapping = {
        sub: 'id',
      };

      const result = normalizeUserInfo(userInfo, mapping);
      expect(result.sub).toBe('0');
      expect(typeof result.sub).toBe('string');
    });

    it('should preserve non-sub numeric values as numbers', () => {
      const userInfo = {
        age: 25,
        score: 100.5,
      };

      const mapping = {
        user_age: 'age',
        user_score: 'score',
      };

      const result = normalizeUserInfo(userInfo, mapping);
      expect(result.user_age).toBe(25);
      expect(typeof result.user_age).toBe('number');
      expect(result.user_score).toBe(100.5);
    });

    it('should handle boolean values', () => {
      const userInfo = {
        email_verified: true,
        is_active: false,
      };

      const mapping = {
        verified: 'email_verified',
        active: 'is_active',
      };

      const result = normalizeUserInfo(userInfo, mapping);
      expect(result.verified).toBe(true);
      expect(result.active).toBe(false);
    });

    it('should handle array values', () => {
      const userInfo = {
        groups: ['admin', 'users'],
        roles: ['editor'],
      };

      const mapping = {
        user_groups: 'groups',
        user_roles: 'roles',
      };

      const result = normalizeUserInfo(userInfo, mapping);
      expect(result.user_groups).toEqual(['admin', 'users']);
      expect(result.user_roles).toEqual(['editor']);
    });
  });

  describe('OIDC-compliant providers', () => {
    it('should pass through OIDC-compliant userinfo without modification', () => {
      const oidcUserInfo = {
        sub: 'user-123-uuid',
        name: 'John Doe',
        given_name: 'John',
        family_name: 'Doe',
        email: 'john@example.com',
        email_verified: true,
        picture: 'https://example.com/photo.jpg',
      };

      // No mapping needed for OIDC-compliant providers
      const result = normalizeUserInfo(oidcUserInfo, {});
      expect(result).toEqual(oidcUserInfo);
    });
  });
});

describe('getNestedValue', () => {
  it('should get top-level value', () => {
    const obj = { name: 'test' };
    expect(getNestedValue(obj, 'name')).toBe('test');
  });

  it('should get nested value', () => {
    const obj = { user: { profile: { name: 'nested' } } };
    expect(getNestedValue(obj, 'user.profile.name')).toBe('nested');
  });

  it('should return undefined for missing path', () => {
    const obj = { user: { name: 'test' } };
    expect(getNestedValue(obj, 'user.email')).toBeUndefined();
    expect(getNestedValue(obj, 'missing.path')).toBeUndefined();
  });

  it('should handle null in path', () => {
    const obj = { user: null };
    expect(getNestedValue(obj, 'user.name')).toBeUndefined();
  });

  it('should handle arrays in path', () => {
    const obj = { items: [{ id: 1 }, { id: 2 }] };
    expect(getNestedValue(obj, 'items.0.id')).toBe(1);
    expect(getNestedValue(obj, 'items.1.id')).toBe(2);
  });
});
