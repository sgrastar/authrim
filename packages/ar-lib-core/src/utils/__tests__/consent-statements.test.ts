import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { singleDatabaseStatementConsent } from '../../services/statement-consent-stores';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  validateVersionFormat,
  getActiveConsentStatements,
  getLocalization,
  resolveStatementRequirements,
  checkUserConsentSatisfaction,
  getConsentItemsForScreen,
  processConsentItemDecisions,
  resolveClientTrustPolicy,
  resolveSignInConfirmationPolicy,
  activateVersion,
  computeContentHash,
  hashIpAddress,
} from '../consent-statements';
import type { ConsentEvidence, ResolvedConsentRequirement } from '../../types/consent-statements';

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

    it('recognizes PostgreSQL bigint trust flags without accepting malformed values', async () => {
      const adapter = createMockAdapter({
        queryResults: new Map([
          [
            'client_trust_policies',
            [
              {
                target_type: 'saml_sp',
                target_id: 'https://sp.example.test',
                first_party: '1',
                trusted: '1',
                skip_authorization_consent: 'false',
              },
            ],
          ],
        ]),
      });

      await expect(
        resolveClientTrustPolicy(adapter, 'tenant-a', 'saml_sp', 'https://sp.example.test')
      ).resolves.toEqual({
        target_type: 'saml_sp',
        target_id: 'https://sp.example.test',
        first_party: true,
        trusted: true,
        skip_authorization_consent: false,
      });
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
    it.each([0, '0'])('should require at least one localization (D8), count=%s', async (count) => {
      const queryResults = new Map();
      const mockQuery = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, status, updated_at FROM consent_statement_versions')) {
          return [{ id: 'ver-1', status: 'draft', updated_at: '1' }];
        }
        if (sql.includes('COUNT(*)') && sql.includes('consent_statement_localizations')) {
          return [{ cnt: count }]; // PostgreSQL COUNT returns BIGINT text.
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
        if (sql.includes('SELECT id, status, updated_at FROM consent_statement_versions')) {
          return [{ id: 'ver-1', status: 'draft', updated_at: '1' }];
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
        batch: vi.fn(async (statements: { sql: string }[]) =>
          statements.map(() => ({ success: true, rowsAffected: 1 }))
        ),
      } as unknown as DatabaseAdapter;

      await expect(activateVersion(adapter, 'default', 'stmt-1', 'ver-1')).resolves.not.toThrow();
      expect(adapter.batch).toHaveBeenCalledTimes(1);
      const statements = vi.mocked(adapter.batch).mock.calls[0][0];
      expect(statements).toHaveLength(6);
      // The statement row is locked first, serializing publishes of its versions.
      expect(statements[0].sql).toContain('UPDATE consent_statements SET updated_at=updated_at');
      expect(statements[3].sql).toContain('definition_generation=definition_generation+1');
      expect(statements[4].sql).toContain('statement_consent_projection_jobs');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenant_id = ? AND version_id = ?'),
        ['default', 'ver-1']
      );
      expect(statements[5].params).toEqual(expect.arrayContaining(['ver-1', 'stmt-1', 'default']));
    });
  });

  describe('resolveStatementRequirements (real SQLite)', () => {
    let fixture: ReturnType<typeof sqliteAdapter>;
    const addStatement = async (
      id: string,
      options: {
        order: number;
        active?: boolean;
        version?: { status: string; current: boolean; version: string } | null;
        requiredVersion?: string | null;
      }
    ) => {
      await fixture.adapter.execute(
        'INSERT INTO consent_statements(id,tenant_id,slug,is_active,display_order,required_consent_version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)',
        [
          id,
          'default',
          id,
          options.active === false ? 0 : 1,
          options.order,
          options.requiredVersion ?? null,
        ]
      );
      const version =
        options.version === undefined
          ? { status: 'active', current: true, version: '20260101' }
          : options.version;
      if (version) {
        await fixture.adapter.execute(
          'INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,created_at,updated_at) VALUES(?,?,?,?,1,?,?,1,1)',
          [`${id}-v`, 'default', id, version.version, version.status, version.current ? 1 : 0]
        );
      }
    };
    beforeEach(() => {
      fixture = sqliteAdapter('core');
    });
    afterEach(() => fixture.db.close());

    it('returns the statements in the order the Flow lists them, not the tenant display order', async () => {
      await addStatement('a', { order: 0 });
      await addStatement('b', { order: 1 });
      const result = await resolveStatementRequirements(fixture.adapter, 'default', [
        { statement_id: 'b', required: true },
        { statement_id: 'a', required: false },
      ]);
      expect(result.map((r) => [r.statement_id, r.is_required, r.display_order])).toEqual([
        ['b', true, 0],
        ['a', false, 1],
      ]);
      expect(result[0]).toMatchObject({ enforcement: 'block', checkbox_mode: 'required' });
      expect(result[1].checkbox_mode).toBe('optional');
    });

    it('skips unknown, inactive and version-less statements', async () => {
      await addStatement('ok', { order: 0 });
      await addStatement('off', { order: 1, active: false });
      await addStatement('none', { order: 2, version: null });
      await addStatement('draft', {
        order: 3,
        version: { status: 'draft', current: true, version: '20260101' },
      });
      const result = await resolveStatementRequirements(
        fixture.adapter,
        'default',
        ['ok', 'off', 'none', 'draft', 'missing'].map((statement_id) => ({
          statement_id,
          required: true,
        }))
      );
      expect(result.map((r) => r.statement_id)).toEqual(['ok']);
    });

    it('requires agreement from required_consent_version, or the current version when unset', async () => {
      await addStatement('pinned', { order: 0, requiredVersion: '20250101' });
      await addStatement('unset', { order: 1 });
      const result = await resolveStatementRequirements(fixture.adapter, 'default', [
        { statement_id: 'pinned', required: true },
        { statement_id: 'unset', required: true },
      ]);
      expect(result.map((r) => r.min_version)).toEqual(['20250101', '20260101']);
    });

    it('returns nothing for an empty list', async () => {
      expect(await resolveStatementRequirements(fixture.adapter, 'default', [])).toEqual([]);
    });
  });

  describe('activateVersion required_consent_version (real SQLite)', () => {
    let fixture: ReturnType<typeof sqliteAdapter>;
    const requiredVersion = async () =>
      (
        await fixture.adapter.queryOne<{ required_consent_version: string | null }>(
          "SELECT required_consent_version FROM consent_statements WHERE id='stmt-1'"
        )
      )?.required_consent_version;
    const addVersion = async (id: string, version: string) => {
      await fixture.adapter.execute(
        "INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,created_at,updated_at) VALUES(?,'default','stmt-1',?,1,'draft',0,1,1)",
        [id, version]
      );
      await fixture.adapter.execute(
        "INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,document_url,created_at,updated_at) VALUES(?,'default',?,'en','Terms','','https://example.com/tos',1,1)",
        [`${id}-loc`, id]
      );
    };
    beforeEach(async () => {
      fixture = sqliteAdapter('core');
      await fixture.adapter.execute(
        "INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at) VALUES('stmt-1','default','terms',1,1)"
      );
      await addVersion('v1', '20260101');
      await addVersion('v2', '20260201');
      await addVersion('v3', '20260301');
    });
    afterEach(() => fixture.db.close());

    it('sets the first version published as the required one, even without re-consent', async () => {
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v1', { reconsent: false });
      expect(await requiredVersion()).toBe('20260101');
    });

    it('moves the required version to the activated one when re-consent is asked (the default)', async () => {
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v1');
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v2');
      expect(await requiredVersion()).toBe('20260201');
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v3', { reconsent: true });
      expect(await requiredVersion()).toBe('20260301');
    });

    it('leaves the required version where it was when re-consent is not asked', async () => {
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v1');
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v2', { reconsent: false });
      expect(await requiredVersion()).toBe('20260101');
      const current = await fixture.adapter.queryOne<{ version: string }>(
        "SELECT version FROM consent_statement_versions WHERE statement_id='stmt-1' AND is_current=1"
      );
      expect(current?.version).toBe('20260201');
    });

    it('refuses, without re-consent, a version older than the required one', async () => {
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v2');
      await expect(
        activateVersion(fixture.adapter, 'default', 'stmt-1', 'v1', { reconsent: false })
      ).rejects.toThrow('version_older_than_required_consent_version');
      expect(await requiredVersion()).toBe('20260201');
      // Asking again moves the required version back with it.
      await activateVersion(fixture.adapter, 'default', 'stmt-1', 'v1', { reconsent: true });
      expect(await requiredVersion()).toBe('20260101');
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

  describe('processConsentItemDecisions (real SQLite)', () => {
    let fixture: ReturnType<typeof sqliteAdapter>;
    beforeEach(async () => {
      fixture = sqliteAdapter('core');
      await fixture.adapter.execute(
        "INSERT INTO consent_statements(id,tenant_id,slug,record_retention_days,reconsent_interval_days,created_at,updated_at) VALUES('stmt-1','default','terms',365,180,1,1)"
      );
      await fixture.adapter.execute(
        "INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,content_hash,created_at,updated_at) VALUES('ver-1','default','stmt-1','20250206',1,'active',1,?,1,1)",
        ['b'.repeat(64)]
      );
    });
    afterEach(() => fixture.db.close());
    const decide = (decision: 'granted' | 'denied') =>
      processConsentItemDecisions(
        singleDatabaseStatementConsent(fixture.adapter),
        'default',
        'user-1',
        { 'stmt-1': decision },
        { client_id: 'client-1' }
      );
    const row = () =>
      fixture.adapter.queryOne<Record<string, unknown>>('SELECT * FROM user_consent_records');

    it('inserts a grant with hash and retention snapshots', async () => {
      await decide('granted');
      expect(await row()).toMatchObject({
        status: 'granted',
        content_hash: 'b'.repeat(64),
        record_retention_days_snapshot: 365,
        reconsent_interval_days_snapshot: 180,
      });
      expect(
        await fixture.adapter.queryOne('SELECT action,content_hash_after FROM consent_item_history')
      ).toEqual({ action: 'granted', content_hash_after: 'b'.repeat(64) });
    });
    it('records an idempotent grant without another history or revision', async () => {
      await decide('granted');
      const before = await row();
      await decide('granted');
      expect(await row()).toEqual(before);
      expect(
        await fixture.adapter.queryOne('SELECT revision FROM statement_consent_key_states')
      ).toEqual({ revision: 1 });
      expect(await fixture.adapter.query('SELECT id FROM consent_item_history')).toHaveLength(1);
    });
    it('inserts a refusal', async () => {
      await decide('denied');
      expect(await row()).toMatchObject({ status: 'denied', expires_at: null });
    });
    it('saves a supplied fixed active version', async () => {
      await fixture.adapter.execute(
        "INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,content_hash,created_at,updated_at) VALUES('fixed-ver','default','stmt-1','20250101',1,'active',0,?,1,1)",
        ['c'.repeat(64)]
      );
      await processConsentItemDecisions(
        singleDatabaseStatementConsent(fixture.adapter),
        'default',
        'user-1',
        { 'stmt-1': 'granted' },
        {},
        undefined,
        { 'stmt-1': { version_id: 'fixed-ver', version: '20250101' } }
      );
      expect(await row()).toMatchObject({
        version_id: 'fixed-ver',
        version: '20250101',
        content_hash: 'c'.repeat(64),
      });
    });
    it('enforces metadata withdrawal settings even without a target', async () => {
      await decide('granted');
      await fixture.adapter.execute('UPDATE consent_statements SET withdrawal_allowed=0');
      await decide('denied');
      expect(await row()).toMatchObject({ status: 'granted' });
    });
    const publishNewerVersion = async () => {
      await fixture.adapter.execute('UPDATE consent_statement_versions SET is_current=0');
      await fixture.adapter.execute(
        "INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,content_hash,created_at,updated_at) VALUES('ver-2','default','stmt-1','20250301',1,'active',1,?,1,1)",
        ['d'.repeat(64)]
      );
    };
    it('gives an expired agreement of the same version again, with a new expiry', async () => {
      // Legacy evidence predates guard creation, so it is inserted rather than updated.
      await fixture.adapter.execute(
        `INSERT INTO user_consent_records
          (id,tenant_id,user_id,statement_id,version_id,version,status,granted_at,expires_at,client_id,
           created_at,updated_at,retain_until,consent_settings_snapshot_at,
           record_retention_days_snapshot,reconsent_interval_days_snapshot,content_hash)
         VALUES('legacy-record','default','user-1','stmt-1','ver-1','20250206','granted',1,2,'client-1',1,1,?,1,365,180,?)`,
        [1 + 365 * 24 * 60 * 60 * 1000, 'b'.repeat(64)]
      );
      await decide('granted');
      const current = await row();
      expect(current).toMatchObject({ status: 'granted', version_id: 'ver-1' });
      expect(Number(current?.granted_at)).toBeGreaterThan(1);
      expect(Number(current?.expires_at)).toBeGreaterThan(Date.now());
    });
    it('records the refusal of a newer version over a refusal of an earlier one', async () => {
      await decide('denied');
      await publishNewerVersion();
      await decide('denied');
      expect(await row()).toMatchObject({
        status: 'denied',
        version_id: 'ver-2',
        version: '20250301',
        content_hash: 'd'.repeat(64),
      });
    });
    it('does not record a refusal of the same version twice', async () => {
      await decide('denied');
      await decide('denied');
      expect(await fixture.adapter.query('SELECT id FROM consent_item_history')).toHaveLength(1);
    });
    it('ends an agreement to an earlier version with a withdrawal recorded at the newer version', async () => {
      await decide('granted');
      await publishNewerVersion();
      await decide('denied');
      expect(await row()).toMatchObject({
        status: 'withdrawn',
        version_id: 'ver-2',
        version: '20250301',
        content_hash: 'd'.repeat(64),
      });
    });
    it('keeps the version agreed to when the withdrawal is of that same version', async () => {
      await decide('granted');
      await decide('denied');
      expect(await row()).toMatchObject({ status: 'withdrawn', version_id: 'ver-1' });
    });
    it('extends prior history retention atomically on withdrawal', async () => {
      // Legacy evidence predates guard creation. An enforced guard must never allow
      // a direct history UPDATE just to prepare this fixture.
      const legacyRetainUntil = 1 + 365 * 24 * 60 * 60 * 1000;
      await fixture.adapter.execute(
        `INSERT INTO user_consent_records
          (id,tenant_id,user_id,statement_id,version_id,version,status,granted_at,client_id,
           created_at,updated_at,retain_until,consent_settings_snapshot_at,
           record_retention_days_snapshot,reconsent_interval_days_snapshot,content_hash)
         VALUES('legacy-record','default','user-1','stmt-1','ver-1','20250206','granted',1,'client-1',1,1,?,1,365,180,?)`,
        [legacyRetainUntil, 'b'.repeat(64)]
      );
      await fixture.adapter.execute(
        `INSERT INTO consent_item_history
          (id,tenant_id,user_id,statement_id,action,version_after,status_after,client_id,
           created_at,version_id_after,granted_at,retain_until,consent_settings_snapshot_at,
           record_retention_days_snapshot,reconsent_interval_days_snapshot,content_hash_after)
         VALUES('legacy-history','default','user-1','stmt-1','granted','20250206','granted','client-1',1,'ver-1',1,?,1,365,180,?)`,
        [legacyRetainUntil, 'b'.repeat(64)]
      );
      await decide('denied');
      const current = await row();
      const histories = await fixture.adapter.query<{ retain_until: number }>(
        'SELECT retain_until FROM consent_item_history'
      );
      expect(histories).toHaveLength(2);
      expect(histories.every((history) => history.retain_until === current?.retain_until)).toBe(
        true
      );
      expect(current?.retain_until).toBeGreaterThan(legacyRetainUntil);
      expect(current?.status).toBe('withdrawn');
      await expect(
        fixture.adapter.execute('UPDATE consent_item_history SET retain_until=1')
      ).rejects.toThrow('statement_consent_consent_item_history_update_guard');
    });
  });
});
