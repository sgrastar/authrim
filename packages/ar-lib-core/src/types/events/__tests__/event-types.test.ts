/**
 * Event Types Unit Tests
 *
 * Tests for event type definitions and data structures.
 */

import { describe, it, expect } from 'vitest';
import {
  AUTH_EVENTS,
  SESSION_EVENTS,
  TOKEN_EVENTS,
  CONSENT_EVENTS,
  USER_EVENTS,
  CLIENT_EVENTS,
  SECURITY_EVENTS,
  EVENT_TYPES,
  type AuthEventData,
  type SessionEventData,
  type TokenEventData,
  type ConsentEventData,
  type UserEventData,
  type ClientEventData,
  type SecurityEventData,
} from '../event-types';

// =============================================================================
// Event Type Constants Tests
// =============================================================================

describe('Event Type Constants', () => {
  describe('AUTH_EVENTS', () => {
    it('should have correct passkey event types', () => {
      expect(AUTH_EVENTS.PASSKEY_SUCCEEDED).toBe('auth.passkey.succeeded');
      expect(AUTH_EVENTS.PASSKEY_FAILED).toBe('auth.passkey.failed');
    });

    it('should have correct password event types', () => {
      expect(AUTH_EVENTS.PASSWORD_SUCCEEDED).toBe('auth.password.succeeded');
      expect(AUTH_EVENTS.PASSWORD_FAILED).toBe('auth.password.failed');
    });

    it('should have correct directory password event types', () => {
      expect(AUTH_EVENTS.DIRECTORY_PASSWORD_SUCCEEDED).toBe('auth.directory_password.succeeded');
      expect(AUTH_EVENTS.DIRECTORY_PASSWORD_FAILED).toBe('auth.directory_password.failed');
    });

    it('should have correct email code event types', () => {
      expect(AUTH_EVENTS.EMAIL_CODE_SUCCEEDED).toBe('auth.email_code.succeeded');
      expect(AUTH_EVENTS.EMAIL_CODE_FAILED).toBe('auth.email_code.failed');
    });

    it('should have correct TOTP event types', () => {
      expect(AUTH_EVENTS.TOTP_SUCCEEDED).toBe('auth.totp.succeeded');
      expect(AUTH_EVENTS.TOTP_FAILED).toBe('auth.totp.failed');
    });

    it('should have correct magic link event types', () => {
      expect(AUTH_EVENTS.MAGIC_LINK_SUCCEEDED).toBe('auth.magic_link.succeeded');
      expect(AUTH_EVENTS.MAGIC_LINK_FAILED).toBe('auth.magic_link.failed');
    });

    it('should have correct external IdP event types', () => {
      expect(AUTH_EVENTS.EXTERNAL_IDP_SUCCEEDED).toBe('auth.external_idp.succeeded');
      expect(AUTH_EVENTS.EXTERNAL_IDP_FAILED).toBe('auth.external_idp.failed');
    });

    it('should have correct DID event types', () => {
      expect(AUTH_EVENTS.DID_SUCCEEDED).toBe('auth.did.succeeded');
      expect(AUTH_EVENTS.DID_FAILED).toBe('auth.did.failed');
    });

    it('should have correct SAML event types', () => {
      expect(AUTH_EVENTS.SAML_SUCCEEDED).toBe('auth.saml.succeeded');
      expect(AUTH_EVENTS.SAML_FAILED).toBe('auth.saml.failed');
    });

    it('should have correct generic login event types', () => {
      expect(AUTH_EVENTS.LOGIN_SUCCEEDED).toBe('auth.login.succeeded');
      expect(AUTH_EVENTS.LOGIN_FAILED).toBe('auth.login.failed');
    });
  });

  describe('SESSION_EVENTS', () => {
    it('should have correct user session event types', () => {
      expect(SESSION_EVENTS.USER_CREATED).toBe('session.user.created');
      expect(SESSION_EVENTS.USER_DESTROYED).toBe('session.user.destroyed');
      expect(SESSION_EVENTS.USER_REFRESHED).toBe('session.user.refreshed');
    });

    it('should have correct client session event types', () => {
      expect(SESSION_EVENTS.CLIENT_CREATED).toBe('session.client.created');
      expect(SESSION_EVENTS.CLIENT_DESTROYED).toBe('session.client.destroyed');
    });
  });

  describe('TOKEN_EVENTS', () => {
    it('should have correct access token event types', () => {
      expect(TOKEN_EVENTS.ACCESS_ISSUED).toBe('token.access.issued');
      expect(TOKEN_EVENTS.ACCESS_REVOKED).toBe('token.access.revoked');
      expect(TOKEN_EVENTS.ACCESS_INTROSPECTED).toBe('token.access.introspected');
    });

    it('should have correct refresh token event types', () => {
      expect(TOKEN_EVENTS.REFRESH_ISSUED).toBe('token.refresh.issued');
      expect(TOKEN_EVENTS.REFRESH_REVOKED).toBe('token.refresh.revoked');
      expect(TOKEN_EVENTS.REFRESH_ROTATED).toBe('token.refresh.rotated');
    });

    it('should have correct ID token event types', () => {
      expect(TOKEN_EVENTS.ID_ISSUED).toBe('token.id.issued');
    });
  });

  describe('CONSENT_EVENTS', () => {
    it('should have correct consent event types', () => {
      expect(CONSENT_EVENTS.GRANTED).toBe('consent.granted');
      expect(CONSENT_EVENTS.DENIED).toBe('consent.denied');
      expect(CONSENT_EVENTS.REVOKED).toBe('consent.revoked');
    });
  });

  describe('USER_EVENTS', () => {
    it('should have correct user management event types', () => {
      expect(USER_EVENTS.CREATED).toBe('user.created');
      expect(USER_EVENTS.UPDATED).toBe('user.updated');
      expect(USER_EVENTS.DELETED).toBe('user.deleted');
    });

    it('should have correct user action event types', () => {
      expect(USER_EVENTS.PASSWORD_CHANGED).toBe('user.password_changed');
      expect(USER_EVENTS.EMAIL_VERIFIED).toBe('user.email_verified');
      expect(USER_EVENTS.LOGOUT).toBe('user.logout');
    });
  });

  describe('CLIENT_EVENTS', () => {
    it('should have correct client management event types', () => {
      expect(CLIENT_EVENTS.CREATED).toBe('client.created');
      expect(CLIENT_EVENTS.UPDATED).toBe('client.updated');
      expect(CLIENT_EVENTS.DELETED).toBe('client.deleted');
      expect(CLIENT_EVENTS.SECRET_ROTATED).toBe('client.secret_rotated');
    });
  });

  describe('SECURITY_EVENTS', () => {
    it('should have correct rate limiting event types', () => {
      expect(SECURITY_EVENTS.RATE_LIMIT_EXCEEDED).toBe('security.rate_limit.exceeded');
    });

    it('should have correct suspicious activity event types', () => {
      expect(SECURITY_EVENTS.SUSPICIOUS_LOGIN_ATTEMPT).toBe('security.suspicious.login_attempt');
      expect(SECURITY_EVENTS.CREDENTIAL_STUFFING_DETECTED).toBe(
        'security.suspicious.credential_stuffing'
      );
    });

    it('should have correct account security event types', () => {
      expect(SECURITY_EVENTS.ACCOUNT_LOCKED).toBe('security.account.locked');
      expect(SECURITY_EVENTS.ACCOUNT_UNLOCKED).toBe('security.account.unlocked');
    });
  });

  describe('EVENT_TYPES', () => {
    it('should contain all event types from all categories', () => {
      // Verify that EVENT_TYPES contains all events from each category
      // Note: For overlapping keys (CREATED, UPDATED, DELETED), CLIENT_EVENTS overwrites USER_EVENTS
      // because CLIENT_EVENTS is spread after USER_EVENTS
      expect(EVENT_TYPES.PASSKEY_SUCCEEDED).toBe(AUTH_EVENTS.PASSKEY_SUCCEEDED);
      expect(EVENT_TYPES.USER_CREATED).toBe(SESSION_EVENTS.USER_CREATED);
      expect(EVENT_TYPES.ACCESS_ISSUED).toBe(TOKEN_EVENTS.ACCESS_ISSUED);
      expect(EVENT_TYPES.GRANTED).toBe(CONSENT_EVENTS.GRANTED);
      // CLIENT_EVENTS.CREATED overwrites USER_EVENTS.CREATED in EVENT_TYPES
      expect((EVENT_TYPES as Record<string, string>).CREATED).toBe(CLIENT_EVENTS.CREATED);
      expect(EVENT_TYPES.RATE_LIMIT_EXCEEDED).toBe(SECURITY_EVENTS.RATE_LIMIT_EXCEEDED);
    });

    it('should access category-specific events directly when keys overlap', () => {
      // For overlapping keys, use the specific category constants
      expect(USER_EVENTS.CREATED).toBe('user.created');
      expect(USER_EVENTS.UPDATED).toBe('user.updated');
      expect(USER_EVENTS.DELETED).toBe('user.deleted');
      expect(CLIENT_EVENTS.CREATED).toBe('client.created');
      expect(CLIENT_EVENTS.UPDATED).toBe('client.updated');
      expect(CLIENT_EVENTS.DELETED).toBe('client.deleted');
    });
  });
});

// =============================================================================
// Event Data Types Tests
// =============================================================================

describe('Event Data Types', () => {
  describe('AuthEventData', () => {
    it('should accept valid auth event data for success', () => {
      const data: AuthEventData = {
        userId: 'user-123',
        method: 'passkey',
        clientId: 'client-abc',
        sessionId: 'session-xyz',
      };
      expect(data.userId).toBe('user-123');
      expect(data.method).toBe('passkey');
      expect(data.clientId).toBe('client-abc');
      expect(data.sessionId).toBe('session-xyz');
    });

    it('should accept valid auth event data for failure', () => {
      const data: AuthEventData = {
        method: 'external_idp',
        clientId: 'google',
        errorCode: 'callback_failed',
      };
      expect(data.userId).toBeUndefined();
      expect(data.method).toBe('external_idp');
      expect(data.errorCode).toBe('callback_failed');
    });

    it('should accept all valid method types', () => {
      const methods: AuthEventData['method'][] = [
        'passkey',
        'password',
        'directory_password',
        'email_code',
        'totp',
        'magic_link',
        'external_idp',
        'did',
        'saml',
      ];
      methods.forEach((method) => {
        const data: AuthEventData = { method, clientId: 'test' };
        expect(data.method).toBe(method);
      });
    });
  });

  describe('SessionEventData', () => {
    it('should accept valid session event data', () => {
      const data: SessionEventData = {
        sessionId: 'session-123',
        userId: 'user-456',
        ttlSeconds: 3600,
      };
      expect(data.sessionId).toBe('session-123');
      expect(data.userId).toBe('user-456');
      expect(data.ttlSeconds).toBe(3600);
    });

    it('should accept destruction reason', () => {
      const data: SessionEventData = {
        sessionId: 'session-123',
        userId: 'user-456',
        reason: 'logout',
      };
      expect(data.reason).toBe('logout');
    });
  });

  describe('TokenEventData', () => {
    it('should accept valid token event data', () => {
      const data: TokenEventData = {
        jti: 'token-jti-123',
        clientId: 'client-abc',
        userId: 'user-456',
        scopes: ['openid', 'profile'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        grantType: 'authorization_code',
      };
      expect(data.jti).toBe('token-jti-123');
      expect(data.clientId).toBe('client-abc');
      expect(data.scopes).toEqual(['openid', 'profile']);
      expect(data.grantType).toBe('authorization_code');
    });

    it('should accept ID token event data without jti', () => {
      const data: TokenEventData = {
        clientId: 'client-abc',
        userId: 'user-456',
        grantType: 'authorization_code',
      };
      expect(data.jti).toBeUndefined();
    });
  });

  describe('ConsentEventData', () => {
    it('should accept valid consent event data', () => {
      const data: ConsentEventData = {
        userId: 'user-123',
        clientId: 'client-abc',
        scopes: ['openid', 'profile', 'email'],
      };
      expect(data.userId).toBe('user-123');
      expect(data.clientId).toBe('client-abc');
      expect(data.scopes).toEqual(['openid', 'profile', 'email']);
    });
  });

  describe('UserEventData', () => {
    it('should accept valid user event data', () => {
      const data: UserEventData = {
        userId: 'user-123',
      };
      expect(data.userId).toBe('user-123');
    });

    it('should accept timestamp', () => {
      const data: UserEventData = {
        userId: 'user-123',
        timestamp: Math.floor(Date.now() / 1000),
      };
      expect(data.timestamp).toBeDefined();
    });

    it('should accept logout event data with sessionId and reason', () => {
      const data: UserEventData = {
        userId: 'user-123',
        sessionId: 'session-456',
        reason: 'logout',
      };
      expect(data.userId).toBe('user-123');
      expect(data.sessionId).toBe('session-456');
      expect(data.reason).toBe('logout');
    });

    it('should accept all valid reason types for logout', () => {
      const reasons: UserEventData['reason'][] = ['logout', 'expired', 'revoked', 'security'];
      reasons.forEach((reason) => {
        const data: UserEventData = { userId: 'user-123', reason };
        expect(data.reason).toBe(reason);
      });
    });
  });

  describe('ClientEventData', () => {
    it('should accept valid client event data', () => {
      const data: ClientEventData = {
        clientId: 'client-abc',
      };
      expect(data.clientId).toBe('client-abc');
    });

    it('should accept timestamp', () => {
      const data: ClientEventData = {
        clientId: 'client-abc',
        timestamp: Math.floor(Date.now() / 1000),
      };
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('SecurityEventData', () => {
    it('should accept valid rate limit exceeded event data', () => {
      const data: SecurityEventData = {
        endpoint: '/token',
        clientIpHash: 'abc123def456',
        rateLimit: {
          maxRequests: 100,
          windowSeconds: 60,
          retryAfter: 30,
          endpointClass: 'loginStart',
        },
      };
      expect(data.endpoint).toBe('/token');
      expect(data.clientIpHash).toBe('abc123def456');
      expect(data.rateLimit?.maxRequests).toBe(100);
      expect(data.rateLimit?.endpointClass).toBe('loginStart');
    });

    it('should accept user and client context', () => {
      const data: SecurityEventData = {
        endpoint: '/authorize',
        userId: 'user-123',
        clientId: 'client-abc',
      };
      expect(data.userId).toBe('user-123');
      expect(data.clientId).toBe('client-abc');
    });
  });
});

// =============================================================================
// Event Pattern Tests
// =============================================================================

describe('Event Patterns', () => {
  it('should follow the naming convention: category.subcategory.action', () => {
    // All auth events should follow auth.<method>.<outcome>
    Object.values(AUTH_EVENTS).forEach((event) => {
      expect(event).toMatch(/^auth\.[a-z_]+\.(succeeded|failed)$/);
    });

    // All session events should follow session.<entity>.<action>
    Object.values(SESSION_EVENTS).forEach((event) => {
      expect(event).toMatch(/^session\.[a-z]+\.[a-z]+$/);
    });

    // All token events should follow token.<type>.<action>
    Object.values(TOKEN_EVENTS).forEach((event) => {
      expect(event).toMatch(/^token\.[a-z]+\.[a-z]+$/);
    });

    // All consent events should follow consent.<action>
    Object.values(CONSENT_EVENTS).forEach((event) => {
      expect(event).toMatch(/^consent\.[a-z_]+$/);
    });

    // All user events should follow user.<action>
    Object.values(USER_EVENTS).forEach((event) => {
      expect(event).toMatch(/^user\.[a-z_]+$/);
    });

    // All client events should follow client.<action> or client.<category>.<action>
    Object.values(CLIENT_EVENTS).forEach((event) => {
      expect(event).toMatch(/^client\.[a-z_]+(\.[a-z_]+)?$/);
    });

    // All security events should follow security.<category>.<action>
    Object.values(SECURITY_EVENTS).forEach((event) => {
      expect(event).toMatch(/^security\.[a-z_]+\.[a-z_]+$/);
    });
  });

  it('should have unique event types', () => {
    const allEvents = Object.values(EVENT_TYPES);
    const uniqueEvents = new Set(allEvents);
    expect(uniqueEvents.size).toBe(allEvents.length);
  });
});

// =============================================================================
// Edge Cases and Boundary Value Tests
// =============================================================================

describe('Edge Cases and Boundary Values', () => {
  describe('TokenEventData boundary values', () => {
    it('should accept empty scopes array', () => {
      const data: TokenEventData = {
        clientId: 'client-abc',
        scopes: [],
      };
      expect(data.scopes).toEqual([]);
    });

    it('should accept very long scopes array', () => {
      const manyScopes = Array.from({ length: 100 }, (_, i) => `scope_${i}`);
      const data: TokenEventData = {
        clientId: 'client-abc',
        scopes: manyScopes,
      };
      expect(data.scopes?.length).toBe(100);
    });

    it('should accept expiresAt at epoch zero', () => {
      const data: TokenEventData = {
        clientId: 'client-abc',
        expiresAt: 0,
      };
      expect(data.expiresAt).toBe(0);
    });

    it('should accept expiresAt in far future', () => {
      const farFuture = Math.floor(new Date('2099-12-31').getTime() / 1000);
      const data: TokenEventData = {
        clientId: 'client-abc',
        expiresAt: farFuture,
      };
      expect(data.expiresAt).toBe(farFuture);
    });
  });

  describe('SessionEventData boundary values', () => {
    it('should accept ttlSeconds of zero', () => {
      const data: SessionEventData = {
        sessionId: 'session-123',
        userId: 'user-456',
        ttlSeconds: 0,
      };
      expect(data.ttlSeconds).toBe(0);
    });

    it('should accept very large ttlSeconds', () => {
      const oneYear = 365 * 24 * 60 * 60;
      const data: SessionEventData = {
        sessionId: 'session-123',
        userId: 'user-456',
        ttlSeconds: oneYear,
      };
      expect(data.ttlSeconds).toBe(oneYear);
    });
  });

  describe('SecurityEventData boundary values', () => {
    it('should accept zero values in rateLimit', () => {
      const data: SecurityEventData = {
        endpoint: '/token',
        rateLimit: {
          maxRequests: 0,
          windowSeconds: 0,
          retryAfter: 0,
        },
      };
      expect(data.rateLimit?.maxRequests).toBe(0);
      expect(data.rateLimit?.windowSeconds).toBe(0);
      expect(data.rateLimit?.retryAfter).toBe(0);
    });

    it('should accept very large rateLimit values', () => {
      const data: SecurityEventData = {
        endpoint: '/token',
        rateLimit: {
          maxRequests: 1000000,
          windowSeconds: 86400,
          retryAfter: 3600,
        },
      };
      expect(data.rateLimit?.maxRequests).toBe(1000000);
    });
  });

  describe('String length edge cases', () => {
    it('should accept empty strings where allowed', () => {
      const data: AuthEventData = {
        method: 'passkey',
        clientId: '',
        errorCode: '',
      };
      expect(data.clientId).toBe('');
      expect(data.errorCode).toBe('');
    });

    it('should accept very long userId', () => {
      const longUserId = 'user_' + 'a'.repeat(1000);
      const data: UserEventData = {
        userId: longUserId,
      };
      expect(data.userId.length).toBe(1005);
    });

    it('should accept very long sessionId', () => {
      const longSessionId = 'session_' + 'x'.repeat(500);
      const data: SessionEventData = {
        sessionId: longSessionId,
        userId: 'user-123',
      };
      expect(data.sessionId.length).toBe(508);
    });
  });

  describe('Special characters in strings', () => {
    it('should accept special characters in clientId', () => {
      const data: AuthEventData = {
        method: 'passkey',
        clientId: 'client-with-special-chars_!@#$%',
      };
      expect(data.clientId).toBe('client-with-special-chars_!@#$%');
    });

    it('should accept unicode in errorCode', () => {
      const data: AuthEventData = {
        method: 'passkey',
        clientId: 'client',
        errorCode: 'エラー_認証失敗',
      };
      expect(data.errorCode).toBe('エラー_認証失敗');
    });

    it('should accept URLs in endpoint', () => {
      const data: SecurityEventData = {
        endpoint: '/api/v1/users?filter=active&sort=name',
      };
      expect(data.endpoint).toBe('/api/v1/users?filter=active&sort=name');
    });
  });

  describe('ConsentEventData edge cases', () => {
    it('should accept single scope', () => {
      const data: ConsentEventData = {
        userId: 'user-123',
        clientId: 'client-abc',
        scopes: ['openid'],
      };
      expect(data.scopes.length).toBe(1);
    });

    it('should accept many scopes', () => {
      const data: ConsentEventData = {
        userId: 'user-123',
        clientId: 'client-abc',
        scopes: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
      };
      expect(data.scopes.length).toBe(6);
    });
  });

  describe('BaseEventData timestamp', () => {
    it('should accept timestamp at Unix epoch', () => {
      const data: UserEventData = {
        userId: 'user-123',
        timestamp: 0,
      };
      expect(data.timestamp).toBe(0);
    });

    it('should accept far future timestamp', () => {
      const farFuture = Math.floor(new Date('2099-12-31T23:59:59Z').getTime() / 1000);
      const data: UserEventData = {
        userId: 'user-123',
        timestamp: farFuture,
      };
      expect(data.timestamp).toBe(farFuture);
    });
  });
});
