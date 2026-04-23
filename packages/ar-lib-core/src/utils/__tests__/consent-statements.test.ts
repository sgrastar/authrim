import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  validateVersionFormat,
  resolveClaimValue,
  evaluateConditionalRules,
  getActiveConsentStatements,
  resolveConsentRequirements,
  checkUserConsentSatisfaction,
  getConsentItemsForScreen,
  processConsentItemDecisions,
  getUserClaimsForRules,
  activateVersion,
  computeContentHash,
  hashIpAddress,
} from '../consent-statements';
import type {
  ConditionalConsentRule,
  ConsentEvidence,
  ResolvedConsentRequirement,
} from '../../types/consent-statements';

/**
 * Consent Statement Management Tests
 *
 * Tests for SAP CDC-like consent management:
 * - Version format validation (D2)
 * - Claim resolution (D12)
 * - Conditional rule evaluation (D4)
 * - Consent satisfaction checking
 * - Version activation (D5, D8)
 * - Content hashing (D11)
 * - IP hashing (D7)
 */

/**
 * Create a mock DatabaseAdapter
 */
function createMockAdapter(
  options: {
    queryResults?: Map<string, unknown[]>;
    executeError?: Error;
  } = {}
): DatabaseAdapter {
  const queryResults = options.queryResults || new Map();

  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      // Match query by SQL pattern
      if (sql.includes('FROM consent_statements') && sql.includes('is_active = 1')) {
        return queryResults.get('active_statements') || [];
      }
      if (sql.includes('FROM consent_statement_versions') && sql.includes('is_current = 1')) {
        return queryResults.get('current_version') || [];
      }
      if (sql.includes('FROM consent_statement_localizations')) {
        return queryResults.get('localizations') || [];
      }
      if (sql.includes('FROM tenant_consent_requirements')) {
        return queryResults.get('tenant_requirements') || [];
      }
      if (sql.includes('FROM client_consent_overrides')) {
        return queryResults.get('client_overrides') || [];
      }
      if (sql.includes('FROM user_consent_records')) {
        return queryResults.get('user_records') || [];
      }
      if (sql.includes('FROM users_core')) {
        return queryResults.get('users_core') || [];
      }
      if (sql.includes('FROM users_pii')) {
        return queryResults.get('users_pii') || [];
      }
      if (sql.includes('COUNT(*)') && sql.includes('consent_statement_localizations')) {
        return queryResults.get('localization_count') || [{ cnt: 0 }];
      }
      if (sql.includes('content_type') && sql.includes('consent_statement_versions')) {
        return queryResults.get('version_content_type') || [];
      }
      return [];
    }),
    execute: vi.fn(async () => {
      if (options.executeError) throw options.executeError;
      return { success: true, meta: { changes: 1 } };
    }),
  } as unknown as DatabaseAdapter;
}

/**
 * Create mock KV namespace
 */
function createMockKV(salt?: string): KVNamespace {
  return {
    get: vi.fn(async (key: string) => {
      if (key.startsWith('consent:ip_salt:')) return salt || null;
      return null;
    }),
    put: vi.fn(async () => {}),
  } as unknown as KVNamespace;
}

describe('Consent Statements Utility', () => {
  describe('validateVersionFormat', () => {
    it('should accept valid YYYYMMDD format', () => {
      expect(validateVersionFormat('20250206')).toBe(true);
      expect(validateVersionFormat('20240101')).toBe(true);
      expect(validateVersionFormat('20991231')).toBe(true);
    });

    it('should reject invalid format', () => {
      expect(validateVersionFormat('2025-02-06')).toBe(false); // Hyphens
      expect(validateVersionFormat('20250')).toBe(false); // Too short
      expect(validateVersionFormat('202502061')).toBe(false); // Too long
      expect(validateVersionFormat('abcd1234')).toBe(false); // Non-numeric
    });

    it('should reject invalid dates', () => {
      expect(validateVersionFormat('20250230')).toBe(false); // Feb 30
      expect(validateVersionFormat('20251332')).toBe(false); // Month 13
      expect(validateVersionFormat('20250100')).toBe(false); // Day 0
      expect(validateVersionFormat('20250001')).toBe(false); // Month 0
    });

    it('should handle leap years correctly', () => {
      expect(validateVersionFormat('20240229')).toBe(true); // 2024 is leap year
      expect(validateVersionFormat('20250229')).toBe(false); // 2025 is not leap year
    });
  });

  describe('resolveClaimValue', () => {
    it('should resolve top-level claims', () => {
      const claims = { email: 'user@example.com', email_verified: true };
      expect(resolveClaimValue(claims, 'email')).toBe('user@example.com');
      expect(resolveClaimValue(claims, 'email_verified')).toBe(true);
    });

    it('should resolve nested claims with dot notation', () => {
      const claims = {
        address: {
          country: 'US',
          region: 'CA',
        },
      };
      expect(resolveClaimValue(claims, 'address.country')).toBe('US');
      expect(resolveClaimValue(claims, 'address.region')).toBe('CA');
    });

    it('should return undefined for missing claims', () => {
      const claims = { email: 'user@example.com' };
      expect(resolveClaimValue(claims, 'phone_number')).toBeUndefined();
      expect(resolveClaimValue(claims, 'address.country')).toBeUndefined();
    });

    it('should calculate age from birthdate', () => {
      const now = new Date();
      const year20YearsAgo = now.getFullYear() - 20;
      const birthdate = `${year20YearsAgo}-01-15`;
      const claims = { birthdate };

      const age = resolveClaimValue(claims, 'birthdate_age');
      expect(age).toBeGreaterThanOrEqual(19);
      expect(age).toBeLessThanOrEqual(21);
    });

    it('should return undefined for invalid birthdate', () => {
      const claims = { birthdate: 'invalid-date' };
      expect(resolveClaimValue(claims, 'birthdate_age')).toBeUndefined();
    });

    it('should handle metadata claims', () => {
      const claims = {
        metadata: {
          segment: 'enterprise',
          plan: 'premium',
        },
      };
      expect(resolveClaimValue(claims, 'metadata.segment')).toBe('enterprise');
      expect(resolveClaimValue(claims, 'metadata.plan')).toBe('premium');
    });
  });

  describe('evaluateConditionalRules', () => {
    it('should evaluate eq operator', () => {
      const rules: ConditionalConsentRule[] = [
        { claim: 'country', op: 'eq', value: 'US', result: 'required' },
      ];
      const claims = { country: 'US' };

      expect(evaluateConditionalRules(rules, claims)).toBe('required');
    });

    it('should evaluate in operator', () => {
      const rules: ConditionalConsentRule[] = [
        { claim: 'address.country', op: 'in', value: ['DE', 'FR', 'IT'], result: 'required' },
      ];
      const claims = { address: { country: 'DE' } };

      expect(evaluateConditionalRules(rules, claims)).toBe('required');
    });

    it('should evaluate lt operator for age', () => {
      const rules: ConditionalConsentRule[] = [
        { claim: 'birthdate_age', op: 'lt', value: 18, result: 'required' },
      ];
      const year15YearsAgo = new Date().getFullYear() - 15;
      const claims = { birthdate: `${year15YearsAgo}-01-01` };

      expect(evaluateConditionalRules(rules, claims)).toBe('required');
    });

    it('should return false for missing claims (D4)', () => {
      const rules: ConditionalConsentRule[] = [
        { claim: 'address.country', op: 'in', value: ['DE'], result: 'required' },
      ];
      const claims = {}; // No address claim

      // Claim missing → comparison returns false → no rule matches
      expect(evaluateConditionalRules(rules, claims)).toBeNull();
    });

    it('should handle exists operator', () => {
      const rules: ConditionalConsentRule[] = [
        { claim: 'metadata.segment', op: 'exists', value: undefined, result: 'required' },
      ];
      const claimsWithSegment = { metadata: { segment: 'enterprise' } };
      const claimsWithoutSegment = {};

      expect(evaluateConditionalRules(rules, claimsWithSegment)).toBe('required');
      expect(evaluateConditionalRules(rules, claimsWithoutSegment)).toBeNull();
    });

    it('should evaluate rules in order and return first match', () => {
      const rules: ConditionalConsentRule[] = [
        { claim: 'plan', op: 'eq', value: 'free', result: 'hidden' },
        { claim: 'plan', op: 'eq', value: 'premium', result: 'optional' },
      ];
      const claims = { plan: 'free' };

      expect(evaluateConditionalRules(rules, claims)).toBe('hidden');
    });
  });

  describe('getActiveConsentStatements', () => {
    it('should retrieve active statements for tenant', async () => {
      const mockStatements = [
        {
          id: 'stmt-1',
          tenant_id: 'default',
          slug: 'tos',
          category: 'terms_of_service',
          legal_basis: 'consent',
          processing_purpose: null,
          display_order: 0,
          is_active: 1,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      const adapter = createMockAdapter({
        queryResults: new Map([['active_statements', mockStatements]]),
      });

      const result = await getActiveConsentStatements(adapter, 'default');

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('tos');
      expect(result[0].is_active).toBe(true);
    });

    it('should return empty array when no active statements', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([['active_statements', []]]),
      });

      const result = await getActiveConsentStatements(adapter, 'default');
      expect(result).toEqual([]);
    });
  });

  describe('checkUserConsentSatisfaction', () => {
    it('should return satisfied when user has granted all required items', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version: '20250206',
                status: 'granted',
                granted_at: Date.now(),
                expires_at: null,
              },
            ],
          ],
        ]),
      });

      const requirements: ResolvedConsentRequirement[] = [
        {
          statement_id: 'stmt-1',
          statement: { slug: 'tos' } as any,
          current_version: { version: '20250206' } as any,
          is_required: true,
          min_version: '20250101',
          enforcement: 'block',
          show_deletion_link: false,
          display_order: 0,
        },
      ];

      const result = await checkUserConsentSatisfaction(adapter, 'default', 'user-1', requirements);

      expect(result.satisfied).toBe(true);
      expect(result.unsatisfied).toEqual([]);
    });

    it('should detect unsatisfied when user has not granted', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([['user_records', []]]),
      });

      const requirements: ResolvedConsentRequirement[] = [
        {
          statement_id: 'stmt-1',
          statement: { slug: 'tos' } as any,
          current_version: { version: '20250206' } as any,
          is_required: true,
          enforcement: 'block',
          show_deletion_link: false,
          display_order: 0,
        },
      ];

      const result = await checkUserConsentSatisfaction(adapter, 'default', 'user-1', requirements);

      expect(result.satisfied).toBe(false);
      expect(result.unsatisfied).toEqual(['stmt-1']);
    });

    it('should detect version upgrade needed (D2: YYYYMMDD string comparison)', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version: '20240101', // Old version
                status: 'granted',
                granted_at: Date.now(),
                expires_at: null,
              },
            ],
          ],
        ]),
      });

      const requirements: ResolvedConsentRequirement[] = [
        {
          statement_id: 'stmt-1',
          statement: { slug: 'tos' } as any,
          current_version: { version: '20250206' } as any,
          is_required: true,
          min_version: '20250206', // Requires new version
          enforcement: 'block',
          show_deletion_link: false,
          display_order: 0,
        },
      ];

      const result = await checkUserConsentSatisfaction(adapter, 'default', 'user-1', requirements);

      expect(result.satisfied).toBe(false);
      expect(result.unsatisfied).toEqual(['stmt-1']);
    });

    it('should detect expired consent', async () => {
      const pastTimestamp = Date.now() - 86400000; // 1 day ago

      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version: '20250206',
                status: 'granted',
                granted_at: Date.now(),
                expires_at: pastTimestamp,
              },
            ],
          ],
        ]),
      });

      const requirements: ResolvedConsentRequirement[] = [
        {
          statement_id: 'stmt-1',
          statement: { slug: 'tos' } as any,
          current_version: { version: '20250206' } as any,
          is_required: true,
          enforcement: 'block',
          show_deletion_link: false,
          display_order: 0,
        },
      ];

      const result = await checkUserConsentSatisfaction(adapter, 'default', 'user-1', requirements);

      expect(result.satisfied).toBe(false);
      expect(result.unsatisfied).toEqual(['stmt-1']);
    });
  });

  describe('activateVersion', () => {
    it('should require at least one localization (D8)', async () => {
      const queryResults = new Map();
      const mockQuery = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, status FROM consent_statement_versions')) {
          return [{ id: 'ver-1', status: 'draft' }];
        }
        if (sql.includes('COUNT(*)') && sql.includes('consent_statement_localizations')) {
          return [{ cnt: 0 }]; // No localizations
        }
        return [];
      });

      const adapter = {
        query: mockQuery,
        execute: vi.fn(),
      } as unknown as DatabaseAdapter;

      await expect(activateVersion(adapter, 'default', 'stmt-1', 'ver-1')).rejects.toThrow(
        'Cannot activate version without at least one localization'
      );
    });

    it('should activate version when localization exists', async () => {
      const mockQuery = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, status FROM consent_statement_versions')) {
          return [{ id: 'ver-1', status: 'draft' }];
        }
        if (sql.includes('COUNT(*)') && sql.includes('consent_statement_localizations')) {
          return [{ cnt: 1 }];
        }
        if (sql.includes('content_type') && sql.includes('consent_statement_versions')) {
          return [{ content_type: 'url' }];
        }
        if (sql.includes('SELECT language, document_url, inline_content')) {
          return [
            { language: 'en', document_url: 'https://example.com/tos', inline_content: null },
          ];
        }
        return [];
      });

      const adapter = {
        query: mockQuery,
        execute: vi.fn(),
      } as unknown as DatabaseAdapter;

      await expect(activateVersion(adapter, 'default', 'stmt-1', 'ver-1')).resolves.not.toThrow();
      expect(adapter.execute).toHaveBeenCalledTimes(2); // Deactivate old + activate new
    });
  });

  describe('computeContentHash', () => {
    it('should compute SHA-256 hash for URL content type (D11)', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          ['version_content_type', [{ content_type: 'url' }]],
          [
            'localizations',
            [
              { language: 'en', document_url: 'https://example.com/tos-en', inline_content: null },
              { language: 'ja', document_url: 'https://example.com/tos-ja', inline_content: null },
            ],
          ],
        ]),
      });

      const hash = await computeContentHash(adapter, 'ver-1');

      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64); // SHA-256 = 32 bytes = 64 hex chars
    });

    it('should compute deterministic hash (same input = same hash)', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          ['version_content_type', [{ content_type: 'inline' }]],
          [
            'localizations',
            [
              { language: 'en', document_url: null, inline_content: 'Terms of Service' },
              { language: 'ja', document_url: null, inline_content: '利用規約' },
            ],
          ],
        ]),
      });

      const hash1 = await computeContentHash(adapter, 'ver-1');
      const hash2 = await computeContentHash(adapter, 'ver-1');

      expect(hash1).toBe(hash2);
    });
  });

  describe('hashIpAddress', () => {
    it('should hash IP with tenant salt (D7)', async () => {
      const kv = createMockKV('tenant-salt-123');

      const hash1 = await hashIpAddress('192.168.1.1', 'tenant-1', kv);
      const hash2 = await hashIpAddress('192.168.1.1', 'tenant-1', kv);

      expect(hash1).toBeTruthy();
      expect(hash1.length).toBe(64); // SHA-256
      expect(hash1).toBe(hash2); // Deterministic
    });

    it('should generate different hashes for different tenants', async () => {
      const kv1 = createMockKV('tenant-1-salt');
      const kv2 = createMockKV('tenant-2-salt');

      const hash1 = await hashIpAddress('192.168.1.1', 'tenant-1', kv1);
      const hash2 = await hashIpAddress('192.168.1.1', 'tenant-2', kv2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle null KV gracefully', async () => {
      const hash = await hashIpAddress('192.168.1.1', 'tenant-1', null);

      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64);
    });
  });

  describe('processConsentItemDecisions', () => {
    it('should insert new granted record', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          ['user_records', []],
          ['current_version', [{ id: 'ver-1', version: '20250206' }]],
        ]),
      });

      const decisions = { 'stmt-1': 'granted' as const };
      const evidence: ConsentEvidence = {
        client_id: 'client-1',
        user_agent: 'Mozilla/5.0',
      };

      await processConsentItemDecisions(adapter, 'default', 'user-1', decisions, evidence);

      expect(adapter.execute).toHaveBeenCalled();
    });

    it('should be idempotent for same version granted (D9)', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version: '20250206',
                status: 'granted',
                granted_at: Date.now(),
              },
            ],
          ],
          ['current_version', [{ id: 'ver-1', version: '20250206' }]],
        ]),
      });

      const decisions = { 'stmt-1': 'granted' as const };
      const evidence: ConsentEvidence = { client_id: 'client-1' };

      await processConsentItemDecisions(adapter, 'default', 'user-1', decisions, evidence);

      // Should skip update (idempotent)
      const executeCalls = (adapter.execute as any).mock.calls;
      expect(executeCalls.length).toBe(0);
    });

    it('should insert denied record (D10)', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          ['user_records', []],
          ['current_version', [{ id: 'ver-1', version: '20250206' }]],
        ]),
      });

      const decisions = { 'stmt-1': 'denied' as const };
      const evidence: ConsentEvidence = { client_id: 'client-1' };

      await processConsentItemDecisions(adapter, 'default', 'user-1', decisions, evidence);

      expect(adapter.execute).toHaveBeenCalled();
    });
  });

  describe('getUserClaimsForRules', () => {
    it('should load email and locale from users_pii using id and tenant_id', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          ['users_core', [{ email_verified: 1 }]],
          [
            'users_pii',
            [
              {
                email: 'claims@example.com',
                locale: 'ja',
                given_name: 'Yuta',
                family_name: 'Sato',
                phone_number: '+819012345678',
                birthdate: '1990-01-01',
                address_country: 'JP',
                address_region: 'Tokyo',
                zoneinfo: 'Asia/Tokyo',
                metadata: '{"segment":"enterprise"}',
              },
            ],
          ],
        ]),
      });

      const claims = await getUserClaimsForRules(adapter, 'tenant-claims', 'user-claims');

      expect(claims).toMatchObject({
        email: 'claims@example.com',
        email_verified: true,
        locale: 'ja',
        given_name: 'Yuta',
        family_name: 'Sato',
        phone_number: '+819012345678',
        birthdate: '1990-01-01',
        zoneinfo: 'Asia/Tokyo',
        metadata: { segment: 'enterprise' },
        address: {
          country: 'JP',
          region: 'Tokyo',
        },
      });

      const queryCalls = (adapter.query as any).mock.calls as Array<[string, unknown[]]>;
      expect(queryCalls).toContainEqual([
        'SELECT email_verified FROM users_core WHERE id = ? AND tenant_id = ?',
        ['user-claims', 'tenant-claims'],
      ]);
      expect(queryCalls).toContainEqual([
        `SELECT email, locale, given_name, family_name, birthdate, phone_number,
              address_country, address_region, zoneinfo, metadata
       FROM users_pii WHERE id = ? AND tenant_id = ?`,
        ['user-claims', 'tenant-claims'],
      ]);
    });
  });
});
