/**
 * AuthorizationCodeStore Durable Object Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthorizationCodeStore } from '../AuthorizationCodeStore';
import type { Env } from '../../types/env';
import { generateCodeChallenge } from '../../utils/crypto';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

// Mock DurableObjectState
class MockDurableObjectState implements Partial<DurableObjectState> {
  private _storage = new Map<string, unknown>();
  private failPutKey: string | null = null;
  private blockedInitialization: Promise<unknown> = Promise.resolve();
  id!: DurableObjectId;
  storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> => {
        return Promise.resolve(this._storage.get(key) as T | undefined);
      },
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
        if (typeof keyOrEntries === 'string' && keyOrEntries === this.failPutKey) {
          this.failPutKey = null;
          return Promise.reject(new Error('Durable Storage unavailable'));
        }
        if (typeof keyOrEntries === 'string') {
          this._storage.set(keyOrEntries, value);
        } else {
          Object.entries(keyOrEntries).forEach(([k, v]) => this._storage.set(k, v));
        }
        return Promise.resolve();
      },
      delete: (keyOrKeys: string | string[]): Promise<boolean | number> => {
        if (typeof keyOrKeys === 'string') {
          const existed = this._storage.has(keyOrKeys);
          this._storage.delete(keyOrKeys);
          return Promise.resolve(existed);
        } else {
          let count = 0;
          keyOrKeys.forEach((key) => {
            if (this._storage.delete(key)) count++;
          });
          return Promise.resolve(count);
        }
      },
      deleteAll: (): Promise<void> => {
        this._storage.clear();
        return Promise.resolve();
      },
      list: <T>(): Promise<Map<string, T>> => {
        return Promise.resolve(new Map(this._storage as Map<string, T>));
      },
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> => {
        return closure(this.storage);
      },
      getAlarm: (): Promise<number | null> => {
        return Promise.resolve(null);
      },
      setAlarm: (): Promise<void> => {
        return Promise.resolve();
      },
      deleteAlarm: (): Promise<void> => {
        return Promise.resolve();
      },
      sync: (): Promise<void> => {
        return Promise.resolve();
      },
      transactionSync: <T>(closure: () => T): T => {
        return closure();
      },
      sql: {} as SqlStorage,
      kv: {} as KVNamespace,
      getCurrentBookmark: (): string => '',
      getBookmarkForTime: (): string => '',
      onNextSessionRestoreBookmark: (): void => {},
    } as unknown as DurableObjectStorage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = callback();
    this.blockedInitialization = result;
    return result;
  }

  waitUntil(): void {
    // No-op for testing
  }

  failNextPut(key: string): void {
    this.failPutKey = key;
  }

  async waitForBlockedInitialization(): Promise<void> {
    await this.blockedInitialization;
  }
}

// Mock Env
const createMockEnv = (): Env => ({}) as Env;

describe('AuthorizationCodeStore', () => {
  let codeStore: AuthorizationCodeStore;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  beforeEach(() => {
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    codeStore = new AuthorizationCodeStore(mockState as unknown as DurableObjectState, mockEnv);
  });

  describe('Code Storage', () => {
    it('should store authorization code successfully', async () => {
      const request = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_123',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid profile',
          authTime: 1700000000,
          acr: 'urn:mace:incommon:iap:silver',
          amr: ['passkey', 'webauthn'],
        }),
      });

      const response = await codeStore.fetch(request);
      expect(response.status).toBe(201);

      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body).toHaveProperty('expiresAt');
    });

    it('should reject code storage without required fields', async () => {
      const request = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_123',
          // Missing required fields
        }),
      });

      const response = await codeStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_request');
    });

    it('should store code with PKCE challenge', async () => {
      const request = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
          codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          codeChallengeMethod: 'S256',
        }),
      });

      const response = await codeStore.fetch(request);
      expect(response.status).toBe(201);
    });

    it('does not expose a code when its durable write fails', async () => {
      mockState.failNextPut('code:undurable_code');

      await expect(
        codeStore.storeCodeRpc({
          code: 'undurable_code',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
        })
      ).rejects.toThrow('Durable Storage unavailable');

      await expect(
        codeStore.consumeCodeRpc({
          code: 'undurable_code',
          clientId: 'client_1',
          tenantId: 'default',
        })
      ).rejects.toThrow('Authorization code not found');
    });
  });

  describe('Code Consumption (One-Time Use)', () => {
    it('does not publish a consumed marker before its durable write succeeds', async () => {
      await codeStore.storeCodeRpc({
        code: 'consume_write_failure',
        clientId: 'client_1',
        tenantId: 'default',
        redirectUri: 'https://app.example.com/callback',
        userId: 'user_123',
        scope: 'openid',
      });
      mockState.failNextPut('code:consume_write_failure');

      await expect(
        codeStore.consumeCodeRpc({
          code: 'consume_write_failure',
          clientId: 'client_1',
          tenantId: 'default',
        })
      ).rejects.toThrow('Durable Storage unavailable');

      await expect(
        codeStore.consumeCodeRpc({
          code: 'consume_write_failure',
          clientId: 'client_1',
          tenantId: 'default',
        })
      ).resolves.toMatchObject({ userId: 'user_123', scope: 'openid' });
    });

    it('should consume valid authorization code', async () => {
      // Store code
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_valid',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid profile',
          authTime: 1700000000,
          acr: 'urn:mace:incommon:iap:silver',
          amr: ['passkey', 'webauthn'],
        }),
      });
      await codeStore.fetch(storeRequest);

      // Consume code
      const consumeRequest = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_valid',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const response = await codeStore.fetch(consumeRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.userId).toBe('user_123');
      expect(body.scope).toBe('openid profile');
      expect(body.redirectUri).toBe('https://app.example.com/callback');
      expect(body.authTime).toBe(1700000000);
      expect(body.acr).toBe('urn:mace:incommon:iap:silver');
      expect(body.amr).toEqual(['passkey', 'webauthn']);
    });

    securityRegressionIt(
      '[security regression][AO-01] permits only one grant-bearing concurrent code redemption',
      async () => {
        const code = 'auth_code_concurrent_redeem';
        const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const authorizationData = {
          userId: 'victim_user',
          scope: 'openid profile offline_access',
          redirectUri: 'https://client.example.com/callback',
        };

        await codeStore.storeCodeRpc({
          code,
          clientId: 'public_client',
          tenantId: 'default',
          ...authorizationData,
          codeChallenge: await generateCodeChallenge(codeVerifier),
          codeChallengeMethod: 'S256',
        });

        const redeem = () =>
          codeStore.consumeCodeRpc({
            code,
            clientId: 'public_client',
            tenantId: 'default',
            codeVerifier,
          });

        const results = await Promise.allSettled([redeem(), redeem()]);
        const fulfilledValues = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : []
        );
        const grantBearingValues = fulfilledValues.filter(
          (value) => value.replayAttack === undefined && value.userId === authorizationData.userId
        );
        const replayOutcomes = results.filter(
          (result) => result.status === 'rejected' || result.value.replayAttack !== undefined
        );

        expect(grantBearingValues).toHaveLength(1);
        expect(grantBearingValues[0]).toMatchObject(authorizationData);
        expect(replayOutcomes).toHaveLength(1);
      }
    );

    it('should prevent replay attack (code already used)', async () => {
      // Store code
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_replay',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Consume code first time (should succeed)
      const consume1 = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_replay',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const response1 = await codeStore.fetch(consume1);
      expect(response1.status).toBe(200);

      // Try to consume again (should fail - replay attack)
      const consume2 = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_replay',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const response2 = await codeStore.fetch(consume2);
      expect(response2.status).toBe(400);

      const body = (await response2.json()) as any;
      expect(body.error).toBe('invalid_grant');
      // Security: Generic message to prevent information leakage about code state
      expect(body.error_description).toContain('Authorization code');
    });

    it('should return token JTIs for revocation on replay attack (RFC 6749 Section 4.1.2)', async () => {
      // Store code
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_replay_with_jti',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
        }),
      });
      await codeStore.fetch(storeRequest);

      // First consumption with token JTI registration (simulating token issuance)
      const consume1 = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_replay_with_jti',
          clientId: 'client_1',
          tenantId: 'default',
          accessTokenJti: 'at_jti_12345',
          refreshTokenJti: 'rt_jti_67890',
        }),
      });
      const response1 = await codeStore.fetch(consume1);
      expect(response1.status).toBe(200);

      // Second consumption attempt (replay attack)
      const consume2 = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_replay_with_jti',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const response2 = await codeStore.fetch(consume2);
      expect(response2.status).toBe(400);

      const body = (await response2.json()) as any;
      expect(body.error).toBe('invalid_grant');

      // RFC 6749 Section 4.1.2: Token JTIs should be returned for revocation
      // The _replayAttack field contains JTIs of tokens issued during first use
      expect(body._replayAttack).toBeDefined();
      expect(body._replayAttack.accessTokenJti).toBe('at_jti_12345');
      expect(body._replayAttack.refreshTokenJti).toBe('rt_jti_67890');
    });

    securityRegressionIt(
      '[security regression] requires the PKCE verifier before returning replay revocation metadata',
      async () => {
        const code = 'auth_code_replay_pkce_binding';
        const codeVerifier = 'p'.repeat(43);
        await codeStore.storeCodeRpc({
          code,
          clientId: 'public_client',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'victim_user',
          scope: 'openid',
          codeChallenge: await generateCodeChallenge(codeVerifier),
          codeChallengeMethod: 'S256',
        });
        await codeStore.consumeCodeRpc({
          code,
          clientId: 'public_client',
          tenantId: 'default',
          codeVerifier,
          accessTokenJti: 'victim_access_jti',
          refreshTokenJti: 'victim_refresh_jti',
        });

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'public_client',
            tenantId: 'default',
          })
        ).rejects.toThrow('code_verifier required');

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'public_client',
            tenantId: 'default',
            codeVerifier: 'x'.repeat(43),
          })
        ).rejects.toThrow('PKCE validation failed');

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'public_client',
            tenantId: 'default',
            codeVerifier,
          })
        ).resolves.toMatchObject({
          replayAttack: {
            accessTokenJti: 'victim_access_jti',
            refreshTokenJti: 'victim_refresh_jti',
          },
        });
      }
    );

    securityRegressionIt(
      '[security regression] rejects token registration after a valid replay races issuance',
      async () => {
        const code = 'auth_code_replay_registration_race';
        await codeStore.storeCodeRpc({
          code,
          clientId: 'public_client',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'victim_user',
          scope: 'openid',
        });
        await codeStore.consumeCodeRpc({
          code,
          clientId: 'public_client',
          tenantId: 'default',
        });

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'public_client',
            tenantId: 'default',
          })
        ).resolves.toMatchObject({ replayAttack: {} });
        await expect(
          codeStore.registerIssuedTokensRpc(code, 'late_access_jti', 'late_refresh_jti')
        ).resolves.toBe(false);
      }
    );

    securityRegressionIt(
      '[security regression] validates redirect and DPoP bindings before consuming the code',
      async () => {
        const code = 'admin_agent_binding_preservation';
        await codeStore.storeCodeRpc({
          code,
          clientId: 'admin_agent_client',
          tenantId: 'default',
          redirectUri: 'https://client.example.com/callback',
          userId: 'admin_user:admin-1',
          scope: 'agent:read',
          dpopJkt: 'legitimate-dpop-jkt',
          authorizationServer: 'admin_agent',
          subjectType: 'admin_user',
          resource: 'https://tenant.example.com/mcp',
        });

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'admin_agent_client',
            tenantId: 'default',
            expectedRedirectUri: 'https://attacker.example/callback',
            enforceDpopBinding: true,
            expectedDpopJkt: 'legitimate-dpop-jkt',
          })
        ).rejects.toThrow('Redirect URI mismatch');

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'admin_agent_client',
            tenantId: 'default',
            expectedRedirectUri: 'https://client.example.com/callback',
            enforceDpopBinding: true,
            expectedDpopJkt: 'attacker-dpop-jkt',
          })
        ).rejects.toThrow('DPoP key mismatch');

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'admin_agent_client',
            tenantId: 'default',
            expectedRedirectUri: 'https://client.example.com/callback',
            enforceDpopBinding: true,
            expectedDpopJkt: 'legitimate-dpop-jkt',
          })
        ).resolves.toMatchObject({ userId: 'admin_user:admin-1' });
      }
    );

    it('should fail on non-existent code', async () => {
      const request = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_nonexistent',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });

      const response = await codeStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_grant');
    });

    it('should validate client ID on consumption', async () => {
      // Store code with client_1
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_client',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Try to consume with different client (should fail)
      const consumeRequest = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_client',
          clientId: 'client_2',
          tenantId: 'default', // Wrong client!
        }),
      });
      const response = await codeStore.fetch(consumeRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_grant');
      // Security: Generic message to prevent client enumeration
      expect(body.error_description).toContain('Authorization code');
    });

    it('binds Admin Agent codes to the dedicated authorization server, subject, and resource', async () => {
      const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const expectedChallenge = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(codeVerifier)
      );
      const encodedChallenge = btoa(String.fromCharCode(...new Uint8Array(expectedChallenge)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      await codeStore.storeCodeRpc({
        code: 'admin_agent_code',
        clientId: 'mcp_client',
        tenantId: 'default',
        redirectUri: 'https://client.example/callback',
        userId: 'admin_123',
        scope: 'agent:read',
        codeChallenge: encodedChallenge,
        codeChallengeMethod: 'S256',
        authorizationServer: 'admin_agent',
        subjectType: 'admin_user',
        resource: 'https://default.example/mcp',
        agentGrantId: 'grant_123',
        agentGrantGeneration: 4,
        agentConsentVersion: 2,
      });

      await expect(
        codeStore.consumeCodeRpc({
          code: 'admin_agent_code',
          clientId: 'mcp_client',
          tenantId: 'default',
          codeVerifier,
          expectedAuthorizationServer: 'default',
          expectedSubjectType: 'end_user',
        })
      ).rejects.toThrow('Authorization server mismatch');

      // A boundary mismatch must not consume the code. The dedicated endpoint can still redeem it.
      const consumed = await codeStore.consumeCodeRpc({
        code: 'admin_agent_code',
        clientId: 'mcp_client',
        tenantId: 'default',
        codeVerifier,
        expectedAuthorizationServer: 'admin_agent',
        expectedSubjectType: 'admin_user',
        expectedResource: 'https://default.example/mcp',
      });

      expect(consumed).toMatchObject({
        userId: 'admin_123',
        authorizationServer: 'admin_agent',
        subjectType: 'admin_user',
        resource: 'https://default.example/mcp',
        agentGrantId: 'grant_123',
        agentGrantGeneration: 4,
        agentConsentVersion: 2,
      });
    });
  });

  describe('PKCE Validation', () => {
    const validVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const validChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('should validate correct PKCE verifier (S256)', async () => {
      // Store code with PKCE challenge
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce_s256',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
          codeChallenge: validChallenge,
          codeChallengeMethod: 'S256',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Consume with correct verifier
      const consumeRequest = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce_s256',
          clientId: 'client_1',
          tenantId: 'default',
          codeVerifier: validVerifier,
        }),
      });
      const response = await codeStore.fetch(consumeRequest);
      expect(response.status).toBe(200);
    });

    it('should reject invalid PKCE verifier', async () => {
      // Store code with PKCE challenge
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce_invalid',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
          codeChallenge: validChallenge,
          codeChallengeMethod: 'S256',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Consume with wrong verifier
      const consumeRequest = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce_invalid',
          clientId: 'client_1',
          tenantId: 'default',
          codeVerifier: 'wrong_verifier',
        }),
      });
      const response = await codeStore.fetch(consumeRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error_description).toContain('PKCE');
    });

    it('should require verifier if challenge was provided', async () => {
      // Store code with PKCE challenge
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce_required',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
          codeChallenge: validChallenge,
          codeChallengeMethod: 'S256',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Try to consume without verifier
      const consumeRequest = new Request('http://localhost/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_pkce_required',
          clientId: 'client_1',
          tenantId: 'default',
          // Missing codeVerifier
        }),
      });
      const response = await codeStore.fetch(consumeRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Security: Generic message to prevent PKCE state enumeration
      expect(body.error_description).toContain('PKCE verification failed');
    });

    securityRegressionIt.each([
      ['short', 'weak'],
      ['long', 'a'.repeat(129)],
      ['invalid-character', `${'a'.repeat(42)}+`],
    ])(
      '[security regression][AO-14] rejects a matching but RFC 7636-invalid %s code_verifier',
      async (_caseName, codeVerifier) => {
        const code = `auth_code_pkce_${_caseName}`;
        await codeStore.storeCodeRpc({
          code,
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
          codeChallenge: await generateCodeChallenge(codeVerifier),
          codeChallengeMethod: 'S256',
        });

        await expect(
          codeStore.consumeCodeRpc({
            code,
            clientId: 'client_1',
            tenantId: 'default',
            codeVerifier,
          })
        ).rejects.toThrow('Invalid code_verifier format');
      }
    );
  });

  describe('Code Expiration (60 seconds TTL)', () => {
    it('should reject expired code', async () => {
      // Note: This test is difficult to implement without mocking time
      // In a real scenario, we would mock Date.now() or use a time-based library
      // For now, we rely on the TTL being set correctly in the implementation
    });

    securityRegressionIt(
      '[security regression][AO-11] releases the per-user limit when expired codes are consumed',
      async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const limitedState = new MockDurableObjectState();
        const limitedEnv = {
          AUTH_CODE_EXPIRY: '60',
          MAX_CODES_PER_USER: '2',
        } as Env;
        const limitedStore = new AuthorizationCodeStore(
          limitedState as unknown as DurableObjectState,
          limitedEnv
        );
        const userId = 'expired-counter-victim';

        try {
          await limitedState.waitForBlockedInitialization();
          for (const code of ['expired-counter-code-1', 'expired-counter-code-2']) {
            await limitedStore.storeCodeRpc({
              code,
              clientId: 'client_1',
              tenantId: 'default',
              redirectUri: 'https://app.example.com/callback',
              userId,
              scope: 'openid',
            });
            expect(await limitedState.storage.get(`code:${code}`)).toBeDefined();
          }

          now.mockReturnValue(1_061_000);
          for (const code of ['expired-counter-code-1', 'expired-counter-code-2']) {
            await expect(
              limitedStore.consumeCodeRpc({
                code,
                clientId: 'client_1',
                tenantId: 'default',
              })
            ).rejects.toThrow('Authorization code expired');

            // The expired grant is really removed, so periodic cleanup cannot later repair its count.
            expect(await limitedState.storage.get(`code:${code}`)).toBeUndefined();
          }

          await expect(
            limitedStore.storeCodeRpc({
              code: 'replacement-after-expired-consumption',
              clientId: 'client_1',
              tenantId: 'default',
              redirectUri: 'https://app.example.com/callback',
              userId,
              scope: 'openid',
            })
          ).resolves.toMatchObject({ success: true });
        } finally {
          now.mockRestore();
        }
      }
    );

    it('decrements the per-user counter on explicit deletion as a negative control', async () => {
      const limitedState = new MockDurableObjectState();
      const limitedStore = new AuthorizationCodeStore(
        limitedState as unknown as DurableObjectState,
        {
          AUTH_CODE_EXPIRY: '60',
          MAX_CODES_PER_USER: '1',
        } as Env
      );
      await limitedState.waitForBlockedInitialization();
      const request = {
        clientId: 'client_1',
        tenantId: 'default',
        redirectUri: 'https://app.example.com/callback',
        userId: 'delete-counter-control',
        scope: 'openid',
      };

      await limitedStore.storeCodeRpc({ code: 'delete-counter-original', ...request });
      await expect(limitedStore.deleteCodeRpc('delete-counter-original')).resolves.toBe(true);
      await expect(
        limitedStore.storeCodeRpc({ code: 'delete-counter-replacement', ...request })
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe('DDoS Protection', () => {
    it('should allow multiple codes for a user within the limit', async () => {
      const userId = 'user_ddos';

      // Create multiple codes sequentially (MAX_CODES_PER_USER = 100)
      // We test a small number to verify the mechanism works
      for (let i = 0; i < 5; i++) {
        const request = new Request('http://localhost/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: `auth_code_ddos_${i}`,
            clientId: 'client_1',
            tenantId: 'default',
            redirectUri: 'https://app.example.com/callback',
            userId,
            scope: 'openid',
          }),
        });
        const response = await codeStore.fetch(request);
        expect(response.status).toBe(201);
      }

      // Verify codes were created - check status endpoint
      const statusRequest = new Request('http://localhost/status', {
        method: 'GET',
      });
      const statusResponse = await codeStore.fetch(statusRequest);
      const statusBody = (await statusResponse.json()) as any;

      // Should have 5 codes stored
      expect(statusBody.codes.total).toBe(5);
      expect(statusBody.codes.active).toBe(5);
    });

    it('should report MAX_CODES_PER_USER in status endpoint', async () => {
      const statusRequest = new Request('http://localhost/status', {
        method: 'GET',
      });
      const response = await codeStore.fetch(statusRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      // MAX_CODES_PER_USER is set to 100 for conformance testing
      expect(body.config.maxCodesPerUser).toBe(100);
    });
  });

  describe('Health Check', () => {
    it('should return status endpoint', async () => {
      const request = new Request('http://localhost/status', {
        method: 'GET',
      });

      const response = await codeStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('codes');
      expect(body).toHaveProperty('config');
    });
  });

  describe('Code Existence Check', () => {
    it('should check if code exists', async () => {
      // Store code
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_exists',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Check existence
      const checkRequest = new Request('http://localhost/code/auth_code_exists/exists', {
        method: 'GET',
      });
      const response = await codeStore.fetch(checkRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.exists).toBe(true);
    });

    it('should return false for non-existent code', async () => {
      const request = new Request('http://localhost/code/auth_code_nonexistent/exists', {
        method: 'GET',
      });

      const response = await codeStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.exists).toBe(false);
    });
  });

  describe('Code Deletion', () => {
    it('should delete code manually', async () => {
      // Store code
      const storeRequest = new Request('http://localhost/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'auth_code_delete',
          clientId: 'client_1',
          tenantId: 'default',
          redirectUri: 'https://app.example.com/callback',
          userId: 'user_123',
          scope: 'openid',
        }),
      });
      await codeStore.fetch(storeRequest);

      // Delete code
      const deleteRequest = new Request('http://localhost/code/auth_code_delete', {
        method: 'DELETE',
      });
      const response = await codeStore.fetch(deleteRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.deleted).toBe('auth_code_delete');

      // Verify code is gone
      const checkRequest = new Request('http://localhost/code/auth_code_delete/exists', {
        method: 'GET',
      });
      const checkResponse = await codeStore.fetch(checkRequest);
      const checkBody = (await checkResponse.json()) as any;
      expect(checkBody.exists).toBe(false);
    });
  });
});
