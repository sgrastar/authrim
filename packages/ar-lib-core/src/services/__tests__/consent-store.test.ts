import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { D1OperationError } from '../../utils/d1-retry';
import { upsertOAuthClientConsent } from '../consent-store';

function createConsentAdapter(
  seed?: {
    id: string;
    user_id: string;
    client_id: string;
    tenant_id: string;
    scope: string;
    selected_scopes: string | null;
    granted_at: number;
    expires_at: number | null;
    privacy_policy_version: string | null;
    tos_version: string | null;
    consent_version: number | null;
    created_at: number;
    updated_at: number;
  },
  options: { insertConflict?: boolean; wrapInsertConflict?: boolean } = {}
): DatabaseAdapter & { rows: any[] } {
  const rows = seed ? [seed] : [];
  let conflictThrown = false;

  return {
    rows,
    async query(sql, params = []) {
      if (sql.includes('FROM oauth_client_consents')) {
        const [tenantId, userId, clientId] = params;
        return rows.filter(
          (row) =>
            row.user_id === userId && row.client_id === clientId && row.tenant_id === tenantId
        );
      }
      return [];
    },
    async queryOne(sql, params = []) {
      const result = await this.query(sql, params);
      return result[0] ?? null;
    },
    async execute(sql, params = []) {
      if (sql.startsWith('INSERT INTO oauth_client_consents')) {
        if (options.insertConflict && !conflictThrown) {
          conflictThrown = true;
          rows.push({
            id: 'consent-concurrent',
            user_id: params[1],
            client_id: params[2],
            scope: 'openid',
            selected_scopes: null,
            granted_at: 90,
            expires_at: null,
            privacy_policy_version: null,
            tos_version: null,
            consent_version: 1,
            created_at: 90,
            updated_at: 90,
            tenant_id: params[12],
          });
          const conflict = new Error(
            'D1_ERROR: UNIQUE constraint failed: oauth_client_consents.tenant_id, oauth_client_consents.user_id, oauth_client_consents.client_id'
          );
          throw options.wrapInsertConflict
            ? new D1OperationError('D1Adapter.execute[core]', 1, conflict, false)
            : conflict;
        }
        rows.push({
          id: params[0],
          user_id: params[1],
          client_id: params[2],
          scope: params[3],
          selected_scopes: params[4],
          granted_at: params[5],
          expires_at: params[6],
          privacy_policy_version: params[7],
          tos_version: params[8],
          consent_version: params[9],
          created_at: params[10],
          updated_at: params[11],
          tenant_id: params[12],
        });
      } else if (sql.startsWith('UPDATE oauth_client_consents')) {
        const [
          scope,
          selectedScopes,
          grantedAt,
          expiresAt,
          privacyVersion,
          tosVersion,
          version,
          updatedAt,
          tenantId,
          userId,
          clientId,
        ] = params;
        const row = rows.find(
          (candidate) =>
            candidate.user_id === userId &&
            candidate.client_id === clientId &&
            candidate.tenant_id === tenantId
        );
        if (row) {
          row.scope = scope;
          row.selected_scopes = selectedScopes;
          row.granted_at = grantedAt;
          row.expires_at = expiresAt;
          row.privacy_policy_version = privacyVersion;
          row.tos_version = tosVersion;
          row.consent_version = version;
          row.updated_at = updatedAt;
        }
      }
    },
    async transaction(fn) {
      return fn(this);
    },
    async batch() {
      return [];
    },
  } as DatabaseAdapter & { rows: any[] };
}

describe('upsertOAuthClientConsent', () => {
  it('inserts a new consent row with version 1', async () => {
    const adapter = createConsentAdapter();

    const result = await upsertOAuthClientConsent(adapter, {
      consentId: 'consent-new',
      userId: 'user-1',
      clientId: 'client-1',
      tenantId: 'tenant-a',
      scope: 'openid profile',
      selectedScopesJson: '["openid","profile"]',
      grantedAt: 100,
      expiresAt: 200,
      privacyPolicyVersion: 'privacy-v1',
      tosVersion: 'tos-v1',
      now: 100,
    });

    expect(result.inserted).toBe(true);
    expect(result.id).toBe('consent-new');
    expect(result.consentVersion).toBe(1);
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0].tenant_id).toBe('tenant-a');
    expect(adapter.rows[0].consent_version).toBe(1);
  });

  it('updates an existing consent row and increments version without replacing id', async () => {
    const adapter = createConsentAdapter({
      id: 'consent-existing',
      user_id: 'user-1',
      client_id: 'client-1',
      tenant_id: 'tenant-a',
      scope: 'openid',
      selected_scopes: null,
      granted_at: 50,
      expires_at: null,
      privacy_policy_version: null,
      tos_version: null,
      consent_version: 2,
      created_at: 10,
      updated_at: 50,
    });

    const result = await upsertOAuthClientConsent(adapter, {
      consentId: 'consent-newer',
      userId: 'user-1',
      clientId: 'client-1',
      tenantId: 'tenant-a',
      scope: 'openid email',
      selectedScopesJson: '["openid","email"]',
      grantedAt: 100,
      expiresAt: 200,
      privacyPolicyVersion: 'privacy-v2',
      tosVersion: 'tos-v2',
      now: 100,
    });

    expect(result.inserted).toBe(false);
    expect(result.id).toBe('consent-existing');
    expect(result.consentVersion).toBe(3);
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0].id).toBe('consent-existing');
    expect(adapter.rows[0].scope).toBe('openid email');
    expect(adapter.rows[0].consent_version).toBe(3);
    expect(adapter.rows[0].updated_at).toBe(100);
  });

  it('recovers from a concurrent first-grant unique constraint race', async () => {
    const adapter = createConsentAdapter(undefined, { insertConflict: true });

    const result = await upsertOAuthClientConsent(adapter, {
      consentId: 'consent-loser',
      userId: 'user-1',
      clientId: 'client-1',
      tenantId: 'tenant-a',
      scope: 'openid profile',
      grantedAt: 100,
      now: 100,
    });

    expect(result.inserted).toBe(false);
    expect(result.id).toBe('consent-concurrent');
    expect(result.consentVersion).toBe(2);
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0].scope).toBe('openid profile');
  });

  it('recovers when the adapter preserves a unique conflict as an error cause', async () => {
    const adapter = createConsentAdapter(undefined, {
      insertConflict: true,
      wrapInsertConflict: true,
    });

    const result = await upsertOAuthClientConsent(adapter, {
      consentId: 'consent-loser',
      userId: 'user-1',
      clientId: 'client-1',
      tenantId: 'tenant-a',
      scope: 'openid profile',
      grantedAt: 100,
      now: 100,
    });

    expect(result.inserted).toBe(false);
    expect(result.id).toBe('consent-concurrent');
    expect(result.consentVersion).toBe(2);
    expect(adapter.rows).toHaveLength(1);
  });
});
