import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  validateVersionFormat,
  resolveClaimValue,
  evaluateConditionalRules,
  getActiveConsentStatements,
  getLocalization,
  resolveConsentRequirements,
  checkUserConsentSatisfaction,
  getConsentItemsForScreen,
  processConsentItemDecisions,
  getUserClaimsForRules,
  resolveClientTrustPolicy,
  resolveSignInConfirmationPolicy,
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
      if (
        sql.includes('record_retention_days') &&
        sql.includes('reconsent_interval_days') &&
        sql.includes('FROM consent_statements')
      ) {
        return queryResults.get('consent_statement_settings') || [];
      }
      if (sql.includes('FROM consent_statement_versions') && sql.includes('is_current = 1')) {
        return queryResults.get('current_version') || [];
      }
      if (sql.includes('content_type') && sql.includes('consent_statement_versions')) {
        return queryResults.get('version_content_type') || [];
      }
      if (sql.includes('FROM consent_statement_versions') && sql.includes('id = ?')) {
        return queryResults.get('version_by_id') || [];
      }
      if (sql.includes('FROM consent_statement_localizations')) {
        return queryResults.get('localizations') || [];
      }
      if (sql.includes('FROM consent_policy_items')) {
        return queryResults.get('consent_policy_items') || [];
      }
      if (sql.includes('FROM client_trust_policies')) {
        return queryResults.get('client_trust_policies') || [];
      }
      if (sql.includes('FROM sign_in_confirmation_policies')) {
        return queryResults.get('sign_in_confirmation_policies') || [];
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
      if (sql.includes('FROM identity_accounts')) {
        const userId = String(params?.[0] ?? 'user-claims');
        return [
          {
            id: `account:${userId}`,
            tenant_id: String(params?.[1] ?? 'tenant-claims'),
            account_type: 'user',
            lifecycle_state: 'active',
            legacy_user_id: userId,
            primary_subject_id: `subject:${userId}`,
            display_label: null,
            metadata_json: null,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
        ];
      }
      if (sql.includes('FROM identity_subjects')) {
        return [
          {
            id: String(params?.[0] ?? 'subject:user-claims'),
            tenant_id: String(params?.[1] ?? 'tenant-claims'),
            subject_type: 'person',
            lifecycle_state: 'active',
            display_label: null,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
        ];
      }
      if (sql.includes('FROM profiles')) {
        const pii = queryResults.get('users_pii')?.[0] as Record<string, unknown> | undefined;
        return [
          {
            id: 'profile:user-claims',
            tenant_id: String(params?.[1] ?? 'tenant-claims'),
            subject_id: String(params?.[0] ?? 'subject:user-claims'),
            profile_type: 'default',
            lifecycle_state: 'active',
            locale: pii?.locale ?? null,
            zoneinfo: pii?.zoneinfo ?? null,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
        ];
      }
      if (sql.includes('FROM profile_attribute_values')) {
        const pii = queryResults.get('users_pii')?.[0] as Record<string, unknown> | undefined;
        const attrs: unknown[] = [];
        for (const field of ['given_name', 'family_name', 'birthdate']) {
          if (pii?.[field]) {
            attrs.push({
              id: `attr:${field}`,
              tenant_id: String(params?.[1] ?? 'tenant-claims'),
              profile_id: String(params?.[0] ?? 'profile:user-claims'),
              catalog_entry_id: `field.canonical.${field}`,
              value_type: 'reference',
              value_json: null,
              value_storage_ref: `canonical-sensitive://tenant-claims/user-claims/${field}`,
              classification: 'sensitive',
              purpose: 'profile',
              is_primary: 0,
              display_order: attrs.length,
              lifecycle_state: 'active',
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
            });
          }
        }
        if (pii?.address_country || pii?.address_region) {
          attrs.push({
            id: 'attr:address',
            tenant_id: String(params?.[1] ?? 'tenant-claims'),
            profile_id: String(params?.[0] ?? 'profile:user-claims'),
            catalog_entry_id: 'field.canonical.address',
            value_type: 'json',
            value_json: JSON.stringify({
              country: pii.address_country,
              region: pii.address_region,
            }),
            value_storage_ref: null,
            classification: 'sensitive',
            purpose: 'profile',
            is_primary: 0,
            display_order: attrs.length,
            lifecycle_state: 'active',
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          });
        }
        if (pii?.metadata) {
          attrs.push({
            id: 'attr:metadata',
            tenant_id: String(params?.[1] ?? 'tenant-claims'),
            profile_id: String(params?.[0] ?? 'profile:user-claims'),
            catalog_entry_id: 'metadata',
            value_type: 'json',
            value_json: pii.metadata,
            value_storage_ref: null,
            classification: 'internal',
            purpose: 'profile',
            is_primary: 0,
            display_order: attrs.length,
            lifecycle_state: 'active',
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          });
        }
        return attrs;
      }
      if (sql.includes('FROM contact_points')) {
        const pii = queryResults.get('users_pii')?.[0] as Record<string, unknown> | undefined;
        return [
          ...(pii?.email
            ? [
                {
                  id: 'contact:email',
                  tenant_id: String(params?.[1] ?? 'tenant-claims'),
                  subject_id: String(params?.[0] ?? 'subject:user-claims'),
                  account_id: 'account:user-claims',
                  contact_type: 'email',
                  purpose: 'primary',
                  normalized_hash: 'email',
                  value_storage_ref: 'canonical-sensitive://tenant-claims/user-claims/email',
                  is_primary: 1,
                  verification_state: 'verified',
                  lifecycle_state: 'active',
                  created_at: 1,
                  updated_at: 1,
                  deleted_at: null,
                },
              ]
            : []),
          ...(pii?.phone_number
            ? [
                {
                  id: 'contact:phone',
                  tenant_id: String(params?.[1] ?? 'tenant-claims'),
                  subject_id: String(params?.[0] ?? 'subject:user-claims'),
                  account_id: 'account:user-claims',
                  contact_type: 'phone',
                  purpose: 'primary',
                  normalized_hash: 'phone',
                  value_storage_ref: 'canonical-sensitive://tenant-claims/user-claims/phone_number',
                  is_primary: 1,
                  verification_state: 'unverified',
                  lifecycle_state: 'active',
                  created_at: 1,
                  updated_at: 1,
                  deleted_at: null,
                },
              ]
            : []),
        ];
      }
      if (sql.includes('COUNT(*)') && sql.includes('consent_statement_localizations')) {
        return queryResults.get('localization_count') || [{ cnt: 0 }];
      }
      return [];
    }),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM identity_sensitive_values')) {
        const pii = queryResults.get('users_pii')?.[0] as Record<string, unknown> | undefined;
        const value = pii?.[String(params?.[2])];
        return value === undefined ? null : { value_json: JSON.stringify(value) };
      }
      const rows = await (createMockAdapter({ queryResults }).query as any)(sql, params);
      return rows[0] ?? null;
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

  describe('getLocalization', () => {
    it('should constrain localization lookup by tenant and version id', async () => {
      const mockQuery = vi.fn(async () => [
        {
          id: 'loc-1',
          tenant_id: 'tenant-a',
          version_id: 'ver-1',
          language: 'en',
          title: 'Terms',
          description: 'Terms text',
          document_url: null,
          inline_content: 'Terms text',
          created_at: 1,
          updated_at: 1,
        },
      ]);
      const adapter = {
        query: mockQuery,
        execute: vi.fn(),
      } as unknown as DatabaseAdapter;

      const result = await getLocalization(adapter, 'tenant-a', 'ver-1', 'en');

      expect(result?.title).toBe('Terms');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenant_id = ? AND version_id = ?'),
        ['tenant-a', 'ver-1']
      );
    });

    it('should fall back to English when requested and tenant default languages are unavailable', async () => {
      const adapter = {
        query: vi.fn(async () => [
          {
            id: 'loc-ja',
            tenant_id: 'tenant-a',
            version_id: 'ver-1',
            language: 'ja',
            title: '利用規約',
            description: '日本語',
            processing_purpose: null,
            withdrawal_impact: null,
            document_url: null,
            inline_content: '日本語',
            created_at: 1,
            updated_at: 1,
          },
          {
            id: 'loc-en',
            tenant_id: 'tenant-a',
            version_id: 'ver-1',
            language: 'en',
            title: 'Terms',
            description: 'English',
            processing_purpose: null,
            withdrawal_impact: null,
            document_url: null,
            inline_content: 'English',
            created_at: 1,
            updated_at: 1,
          },
        ]),
        execute: vi.fn(),
      } as unknown as DatabaseAdapter;

      const result = await getLocalization(adapter, 'tenant-a', 'ver-1', 'fr', 'de');

      expect(result?.language).toBe('en');
      expect(result?.title).toBe('Terms');
    });

    it('should fall back to the only available non-English localization', async () => {
      const adapter = {
        query: vi.fn(async () => [
          {
            id: 'loc-ja',
            tenant_id: 'tenant-a',
            version_id: 'ver-1',
            language: 'ja',
            title: '利用規約',
            description: '日本語',
            processing_purpose: null,
            withdrawal_impact: null,
            document_url: null,
            inline_content: '日本語',
            created_at: 1,
            updated_at: 1,
          },
        ]),
        execute: vi.fn(),
      } as unknown as DatabaseAdapter;

      const result = await getLocalization(adapter, 'tenant-a', 'ver-1', 'fr', 'de');

      expect(result?.language).toBe('ja');
      expect(result?.title).toBe('利用規約');
    });
  });

  describe('resolveConsentRequirements', () => {
    it('should resolve legacy tenant requirements without reading direct consent policy assignments', async () => {
      const now = Date.now();
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'active_statements',
            [
              {
                id: 'stmt-1',
                tenant_id: 'default',
                slug: 'privacy',
                category: 'privacy_policy',
                legal_basis: 'consent',
                processing_purpose: null,
                display_order: 10,
                is_active: 1,
                record_retention_days: 365,
                withdrawal_allowed: 1,
                withdrawal_impact: null,
                reconsent_on_version_change: 1,
                reconsent_interval_days: 180,
                created_at: now,
                updated_at: now,
              },
            ],
          ],
          [
            'tenant_requirements',
            [
              {
                id: 'req-1',
                tenant_id: 'default',
                statement_id: 'stmt-1',
                requirement: 'required',
                min_version: null,
                conditional_rules_json: null,
                display_order: 5,
                created_at: now,
                updated_at: now,
              },
            ],
          ],
          [
            'consent_statement_settings',
            [
              {
                record_retention_days: 365,
                withdrawal_allowed: 1,
                reconsent_interval_days: 180,
              },
            ],
          ],
          [
            'client_overrides',
            [
              {
                id: 'override-1',
                client_id: 'client-1',
                statement_id: 'stmt-1',
                requirement: 'required',
                min_version: '20260601',
                enforcement: 'block',
                checkbox_mode: 'required',
                checkbox_default_checked: 0,
                binding_type: 'scope',
                binding_value: 'profile email',
                evidence_profile: 'attribute_release',
                language_fallback: 'tenant_default',
                display_order: 5,
                conditional_rules_json: null,
              },
            ],
          ],
          [
            'current_version',
            [
              {
                id: 'ver-1',
                tenant_id: 'default',
                statement_id: 'stmt-1',
                version: '20260601',
                content_type: 'url',
                effective_at: now,
                content_hash: null,
                is_current: 1,
                status: 'active',
                created_at: now,
                updated_at: now,
              },
            ],
          ],
        ]),
      });

      const result = await resolveConsentRequirements(
        adapter,
        'default',
        'client-1',
        {},
        {
          requested_scopes: ['openid', 'email'],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        statement_id: 'stmt-1',
        is_required: true,
        min_version: '20260601',
        reconsent_interval_days: 180,
        checkbox_mode: 'required',
        checkbox_default_checked: true,
      });
      const directPolicyAssignmentQuery = vi
        .mocked(adapter.query)
        .mock.calls.find(([sql]) => String(sql).includes('consent_policy_assignments'));
      expect(directPolicyAssignmentQuery).toBeUndefined();
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

    it('should detect reconsent interval expiration', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version: '20260601',
                status: 'granted',
                granted_at: Date.now() - 31 * 24 * 60 * 60 * 1000,
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
          current_version: { version: '20260601' } as any,
          is_required: true,
          enforcement: 'block',
          show_deletion_link: false,
          reconsent_interval_days: 30,
          display_order: 0,
        },
      ];

      const result = await checkUserConsentSatisfaction(adapter, 'default', 'user-1', requirements);

      expect(result.satisfied).toBe(false);
      expect(result.unsatisfied).toEqual(['stmt-1']);
    });

    it('should honor stored audit snapshot expiration without recalculating from current settings', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version: '20260601',
                status: 'granted',
                granted_at: Date.now() - 31 * 24 * 60 * 60 * 1000,
                expires_at: null,
                consent_settings_snapshot_at: Date.now() - 31 * 24 * 60 * 60 * 1000,
                reconsent_interval_days_snapshot: null,
              },
            ],
          ],
        ]),
      });

      const requirements: ResolvedConsentRequirement[] = [
        {
          statement_id: 'stmt-1',
          statement: { slug: 'tos' } as any,
          current_version: { version: '20260601' } as any,
          is_required: true,
          enforcement: 'block',
          show_deletion_link: false,
          reconsent_interval_days: 30,
          display_order: 0,
        },
      ];

      const result = await checkUserConsentSatisfaction(adapter, 'default', 'user-1', requirements);

      expect(result.satisfied).toBe(true);
      expect(result.unsatisfied).toEqual([]);
    });
  });

  describe('policy setting resolution', () => {
    it('should resolve target client trust policy', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'client_trust_policies',
            [
              {
                target_type: 'oidc_client',
                target_id: 'client-1',
                first_party: 1,
                trusted: 1,
                skip_authorization_consent: 1,
              },
            ],
          ],
        ]),
      });

      const result = await resolveClientTrustPolicy(adapter, 'default', 'oidc_client', 'client-1');

      expect(result).toEqual({
        target_type: 'oidc_client',
        target_id: 'client-1',
        first_party: true,
        trusted: true,
        skip_authorization_consent: true,
      });
      const trustPolicyQuery = vi
        .mocked(adapter.query)
        .mock.calls.find(([sql]) => String(sql).includes('FROM client_trust_policies'));
      expect(trustPolicyQuery?.[0]).toContain('AND target_type = ?');
      expect(trustPolicyQuery?.[0]).toContain('AND target_id = ?');
      expect(trustPolicyQuery?.[0]).not.toContain('tenant_default');
      expect(trustPolicyQuery?.[1]).toEqual(['default', 'oidc_client', 'client-1']);
    });

    it('should resolve login sign-in confirmation policy', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'sign_in_confirmation_policies',
            [
              {
                mode: 'every_time',
                remember_duration_days: 7,
                show_application_context: 1,
                show_tenant_context: 0,
              },
            ],
          ],
        ]),
      });

      const result = await resolveSignInConfirmationPolicy(adapter, 'default');

      expect(result).toEqual({
        mode: 'every_time',
        remember_duration_days: 7,
        show_application_context: true,
        show_tenant_context: false,
      });
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
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenant_id = ? AND version_id = ?'),
        ['default', 'ver-1']
      );
      expect(adapter.execute).toHaveBeenLastCalledWith(
        expect.stringContaining('WHERE id = ? AND statement_id = ? AND tenant_id = ?'),
        expect.arrayContaining(['ver-1', 'stmt-1', 'default'])
      );
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

    it('should constrain content hash inputs by tenant when tenant is provided', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          ['version_content_type', [{ content_type: 'inline' }]],
          [
            'localizations',
            [{ language: 'en', document_url: null, inline_content: 'Tenant A terms' }],
          ],
        ]),
      });

      const hash = await computeContentHash(adapter, 'ver-1', 'tenant-a');

      expect(hash).toHaveLength(64);
      expect(adapter.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = ? AND tenant_id = ?'),
        ['ver-1', 'tenant-a']
      );
      expect(adapter.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenant_id = ? AND version_id = ?'),
        ['tenant-a', 'ver-1']
      );
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
          [
            'consent_statement_settings',
            [{ record_retention_days: 365, reconsent_interval_days: 180 }],
          ],
        ]),
      });

      const decisions = { 'stmt-1': 'granted' as const };
      const evidence: ConsentEvidence = {
        client_id: 'client-1',
        user_agent: 'Mozilla/5.0',
      };

      await processConsentItemDecisions(adapter, 'default', 'user-1', decisions, evidence);

      const executeCalls = (adapter.execute as any).mock.calls;
      const insertRecordCall = executeCalls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO user_consent_records')
      );
      const historyCall = executeCalls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO consent_item_history')
      );

      expect(insertRecordCall?.[0]).toContain('expires_at');
      expect(insertRecordCall?.[0]).toContain('retain_until');
      expect(insertRecordCall?.[0]).toContain('consent_settings_snapshot_at');
      expect(insertRecordCall?.[1]).toContain(365);
      expect(insertRecordCall?.[1]).toContain(180);
      expect(historyCall?.[0]).toContain('version_id_after');
      expect(historyCall?.[0]).toContain('record_retention_days_snapshot');
      expect(historyCall?.[0]).toContain('reconsent_interval_days_snapshot');
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

    it('should save the displayed fixed version when a decision target is supplied', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([['user_records', []]]),
      });

      await processConsentItemDecisions(
        adapter,
        'default',
        'user-1',
        { 'stmt-1': 'granted' },
        { client_id: 'client-1' },
        undefined,
        {
          'stmt-1': {
            version_id: 'fixed-ver-1',
            version: '20250101',
            withdrawal_allowed: true,
          },
        }
      );

      const insertCall = (adapter.execute as any).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO user_consent_records')
      );
      expect(insertCall?.[1]).toContain('fixed-ver-1');
      expect(insertCall?.[1]).toContain('20250101');
    });

    it('should not withdraw an existing grant when withdrawal is not allowed', async () => {
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
        ]),
      });

      await processConsentItemDecisions(
        adapter,
        'default',
        'user-1',
        { 'stmt-1': 'denied' },
        { client_id: 'client-1' },
        undefined,
        {
          'stmt-1': {
            version_id: 'ver-1',
            version: '20250206',
            withdrawal_allowed: false,
          },
        }
      );

      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it('should extend prior audit history retention when granted consent is withdrawn', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'user_records',
            [
              {
                statement_id: 'stmt-1',
                version_id: 'ver-1',
                version: '20250206',
                status: 'granted',
                granted_at: Date.now(),
                expires_at: null,
              },
            ],
          ],
          [
            'consent_statement_settings',
            [{ record_retention_days: 365, reconsent_interval_days: 180 }],
          ],
        ]),
      });

      await processConsentItemDecisions(
        adapter,
        'default',
        'user-1',
        { 'stmt-1': 'denied' },
        { client_id: 'client-1' },
        undefined,
        {
          'stmt-1': {
            version_id: 'ver-1',
            version: '20250206',
            withdrawal_allowed: true,
          },
        }
      );

      const retentionUpdateCall = (adapter.execute as any).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('UPDATE consent_item_history')
      );

      expect(retentionUpdateCall?.[0]).toContain('retain_until');
      expect(retentionUpdateCall?.[0]).toContain('consent_settings_snapshot_at');
      expect(retentionUpdateCall?.[1]).toContain(365);
      expect(retentionUpdateCall?.[1]).toContain(180);
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
      expect(queryCalls.some(([sql]) => sql.includes('FROM profile_attribute_values'))).toBe(true);
      expect(queryCalls.some(([sql]) => sql.includes('FROM contact_points'))).toBe(true);
    });
  });
});
