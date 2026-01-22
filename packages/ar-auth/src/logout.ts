/**
 * Logout Functionality
 *
 * Implements OpenID Connect logout mechanisms:
 * - Front-channel logout (GET /logout) with Backchannel Logout notification
 * - Back-channel logout (POST /logout/backchannel) - RFC 8725
 *
 * Front-channel: Browser-initiated logout with redirect
 * Back-channel: Server-to-server logout notification
 *
 * Phase A-6: Added Backchannel Logout sender integration
 * - Sends logout notifications to all RPs that have tokens for the session
 * - Uses waitUntil() for non-blocking sends
 * - Configurable via KV settings (LOGOUT_SETTINGS_KEY)
 *
 * @see https://openid.net/specs/openid-connect-rpinitiated-1_0.html
 * @see https://openid.net/specs/openid-connect-backchannel-1_0.html
 */

import { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  timingSafeEqual,
  verifyClientSecretHash,
  validateIdTokenHint,
  validatePostLogoutRedirectUri,
  validateLogoutParameters,
  getSessionStoreBySessionId,
  isShardedSessionId,
  createAuthContextFromHono,
  getTenantIdFromContext,
  createBackchannelLogoutOrchestrator,
  DEFAULT_LOGOUT_CONFIG,
  LOGOUT_SETTINGS_KEY,
  buildFrontchannelLogoutIframes,
  generateFrontchannelLogoutHtml,
  getFrontchannelLogoutConfig,
  BROWSER_STATE_COOKIE_NAME,
  // Native SSO device_secret revocation
  D1Adapter,
  DeviceSecretRepository,
  isNativeSSOEnabled,
  // Simple Logout Webhook (Authrim Extension)
  createLogoutWebhookOrchestrator,
  getLogoutWebhookConfig,
  decryptValue,
  // Event System
  publishEvent,
  USER_EVENTS,
  SESSION_EVENTS,
  type SessionEventData,
  type UserEventData,
  // Logging
  getLogger,
  createLogger,
  // Audit Log
  createAuditLog,
  // Cookie Configuration
  getSessionCookieSameSite,
  getBrowserStateCookieSameSite,
} from '@authrim/ar-lib-core';
import type {
  BackchannelLogoutConfig,
  LogoutSendResult,
  LogoutConfig,
  SessionClientWithWebhook,
  LogoutWebhookSendResult,
} from '@authrim/ar-lib-core';
import { importJWK, jwtVerify, importPKCS8 } from 'jose';
import type { JSONWebKeySet, CryptoKey, JWTPayload } from 'jose';

/**
 * OIDC Back-Channel Logout Token events claim structure
 * @see https://openid.net/specs/openid-connect-backchannel-1_0.html#LogoutToken
 */
interface BackchannelLogoutEvents {
  'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
}

/**
 * Extended JWT Payload for Logout Token with events claim
 */
interface LogoutTokenPayload extends JWTPayload {
  events?: BackchannelLogoutEvents;
}

// ===== Module-level Logger for Helper Functions =====
const moduleLogger = createLogger().module('LOGOUT');

/**
 * Import a PEM-encoded RSA private key for JWT signing
 *
 * @param pem - PEM-encoded private key
 * @returns CryptoKey for signing
 */
async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  return (await importPKCS8(pem, 'RS256')) as CryptoKey;
}

/**
 * Get Logout Configuration
 *
 * Priority: KV → defaults
 *
 * @param env - Environment bindings
 * @returns LogoutConfig
 */
async function getLogoutConfig(env: Env): Promise<LogoutConfig> {
  // Try KV first
  if (env.SETTINGS) {
    try {
      const kvConfig = await env.SETTINGS.get(LOGOUT_SETTINGS_KEY);
      if (kvConfig) {
        const parsed = JSON.parse(kvConfig);
        return {
          backchannel: {
            ...DEFAULT_LOGOUT_CONFIG.backchannel,
            ...(parsed.backchannel || {}),
          },
          frontchannel: {
            ...DEFAULT_LOGOUT_CONFIG.frontchannel,
            ...(parsed.frontchannel || {}),
          },
          session_management: {
            ...DEFAULT_LOGOUT_CONFIG.session_management,
            ...(parsed.session_management || {}),
          },
        };
      }
    } catch {
      // Ignore KV errors, use defaults
    }
  }

  return DEFAULT_LOGOUT_CONFIG;
}

/**
 * Front-channel Logout
 * GET /logout
 *
 * Handles browser-initiated logout requests.
 * Invalidates the user's session and redirects to the post-logout URI.
 *
 * Per OIDC RP-Initiated Logout 1.0:
 * - Session is ALWAYS invalidated when user visits logout endpoint (if session exists)
 * - Redirect to post_logout_redirect_uri only if validation passes
 * - Otherwise redirect to default /logged-out page
 *
 * Query Parameters:
 * - id_token_hint: ID token issued to the RP
 * - post_logout_redirect_uri: Where to redirect after logout
 * - state: Opaque value to maintain state
 */
export async function frontChannelLogoutHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LOGOUT');
  try {
    // Get query parameters
    const idTokenHint = c.req.query('id_token_hint');
    const postLogoutRedirectUri = c.req.query('post_logout_redirect_uri');
    const state = c.req.query('state');

    let userId: string | undefined;
    let clientId: string | undefined;
    let sid: string | undefined;

    // Helper function to get public key from KeyManager via RPC
    // Matches the key by 'kid' from the JWT header
    const getPublicKey = async (): Promise<CryptoKey> => {
      const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
      const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

      const keys = await keyManager.getAllPublicKeysRpc();

      if (!keys || keys.length === 0) {
        throw new Error('No keys in JWKS');
      }

      const jwks = { keys } as JSONWebKeySet;

      // Extract kid from id_token_hint header if available
      let targetKid: string | undefined;
      if (idTokenHint) {
        try {
          const headerPart = idTokenHint.split('.')[0];
          const header = JSON.parse(atob(headerPart.replace(/-/g, '+').replace(/_/g, '/')));
          targetKid = header.kid;
        } catch {
          // If we can't parse the header, fall back to first key
        }
      }

      // Find the matching key by kid, or use the first key as fallback
      let key;
      if (targetKid) {
        key = jwks.keys.find((k) => k.kid === targetKid);
        if (!key) {
          // SECURITY: Do not expose kid value in error to prevent key enumeration
          throw new Error('Key verification failed');
        }
      } else {
        key = jwks.keys[0];
        if (!key) {
          throw new Error('Key verification failed');
        }
      }

      return (await importJWK(key)) as CryptoKey;
    };

    // ========================================
    // Step 1: Validate id_token_hint for session identification
    // ========================================
    // We validate the signature BEFORE using sid for session deletion
    // to prevent attackers from crafting fake tokens to log out other users
    let idTokenValid = false;
    if (idTokenHint) {
      const idTokenResult = await validateIdTokenHint(idTokenHint, getPublicKey, c.env.ISSUER_URL, {
        required: false,
        allowExpired: true, // Allow expired tokens for logout
      });

      if (idTokenResult.valid) {
        userId = idTokenResult.userId;
        clientId = idTokenResult.clientId;
        sid = idTokenResult.sid;
        idTokenValid = true;
      } else {
        log.warn('id_token_hint validation failed', { error: idTokenResult.error });
      }
    }

    // ========================================
    // Step 2: Invalidate sessions and prepare backchannel logout
    // ========================================
    // Per OIDC spec, when user visits logout endpoint, they intend to log out.
    // We delete sessions from:
    // 1. Cookie (always - this is the browser's session)
    // 2. sid from validated id_token_hint (if valid - for server-to-server logout)
    const sessionId = getCookie(c, 'authrim_session');
    const deletedSessions: string[] = [];

    // Get context for repository access
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Collect all data needed for logout **before** deleting the session.
    // Session deletion cascades to session_clients via FK, so we need the client
    // lists upfront to send backchannel/frontchannel/webhook notifications.
    type SessionNotificationTarget = {
      sessionId: string;
      userId: string;
      backchannelClients: Awaited<
        ReturnType<typeof authCtx.repositories.sessionClient.findBackchannelLogoutClients>
      >;
      frontchannelClients: Awaited<
        ReturnType<typeof authCtx.repositories.sessionClient.findFrontchannelLogoutClients>
      >;
      webhookClients: SessionClientWithWebhook[];
    };
    const sessionsToNotify: SessionNotificationTarget[] = [];

    const collectSessionData = async (sessId: string, fallbackUserId?: string) => {
      // Avoid duplicate work if the same session is encountered twice
      if (sessionsToNotify.some((s) => s.sessionId === sessId)) {
        return;
      }

      try {
        // Try to get user_id from D1 session (may not exist since sessions are in Durable Objects)
        let effectiveUserId = fallbackUserId || '';
        try {
          const session = await authCtx.repositories.session.findById(sessId);
          if (session?.user_id) {
            effectiveUserId = session.user_id;
          }
        } catch {
          // Session not in D1, use fallback userId from id_token_hint
          log.debug('Session not in D1, using fallback userId', { sessionId: sessId });
        }

        // Get clients from session_clients table (this works regardless of D1 session)
        const [backchannelClients, frontchannelClients, webhookClients] = await Promise.all([
          authCtx.repositories.sessionClient.findBackchannelLogoutClients(sessId).catch((error) => {
            log.warn('Failed to load backchannel clients', {
              sessionId: sessId,
              error: (error as Error).message,
              action: 'BackchannelLogout',
            });
            return [];
          }),
          authCtx.repositories.sessionClient
            .findFrontchannelLogoutClients(sessId)
            .catch((error) => {
              log.warn('Failed to load frontchannel clients', {
                sessionId: sessId,
                error: (error as Error).message,
                action: 'FrontchannelLogout',
              });
              return [];
            }),
          authCtx.repositories.sessionClient.findWebhookClients(sessId).catch((error) => {
            log.warn('Failed to load webhook clients', {
              sessionId: sessId,
              error: (error as Error).message,
              action: 'LogoutWebhook',
            });
            return [];
          }),
        ]);

        // Only add if we have clients to notify
        if (
          backchannelClients.length > 0 ||
          frontchannelClients.length > 0 ||
          webhookClients.length > 0
        ) {
          log.info('Collected logout clients for session', {
            backchannelCount: backchannelClients.length,
            frontchannelCount: frontchannelClients.length,
            webhookCount: webhookClients.length,
            sessionId: sessId,
          });
          sessionsToNotify.push({
            sessionId: sessId,
            userId: effectiveUserId,
            backchannelClients,
            frontchannelClients,
            webhookClients,
          });
        } else {
          log.debug('No logout clients found for session', { sessionId: sessId });
        }
      } catch (error) {
        log.warn('Failed to load session data', {
          sessionId: sessId,
          error: (error as Error).message,
        });
      }
    };

    // Delete session from cookie if present (only sharded format)
    log.info('Processing logout', {
      cookieSession: sessionId?.substring(0, 30) || 'none',
      sid: sid?.substring(0, 30) || 'none',
      idTokenValid,
    });

    if (sessionId && isShardedSessionId(sessionId)) {
      try {
        // Collect session info before deletion (pass userId from id_token_hint as fallback)
        await collectSessionData(sessionId, userId);

        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
        const deleted = await sessionStore.invalidateSessionRpc(sessionId);

        if (deleted) {
          deletedSessions.push(sessionId);
          log.info('Cookie session deleted', { sessionId: sessionId.substring(0, 30) });
        } else {
          log.warn('Failed to delete cookie session', { sessionId });
        }
      } catch (error) {
        log.warn('Failed to route to session store', {
          sessionId,
          error: (error as Error).message,
        });
      }
    }

    // Also delete session by sid from id_token_hint (only if signature was verified)
    // This ensures logout works even when called without browser cookies
    // Security: We only trust sid from verified tokens to prevent DoS attacks
    if (
      idTokenValid &&
      sid &&
      sid !== sessionId &&
      !deletedSessions.includes(sid) &&
      isShardedSessionId(sid)
    ) {
      try {
        // Collect session info before deletion (pass userId from id_token_hint as fallback)
        if (!sessionsToNotify.some((s) => s.sessionId === sid)) {
          log.info('Collecting session data for sid', { sid: sid.substring(0, 30) });
          await collectSessionData(sid, userId);
        }

        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sid);
        const deleted = await sessionStore.invalidateSessionRpc(sid);

        if (deleted) {
          deletedSessions.push(sid);
          log.info('Session from sid deleted', { sid: sid.substring(0, 30) });
        } else {
          // Session might not exist or already deleted - this is OK
          log.debug('Session from id_token_hint not found or already deleted', { sid });
        }
      } catch (error) {
        log.warn('Failed to route to session store for sid', {
          sid,
          error: (error as Error).message,
        });
      }
    }

    log.info('After processing logout', {
      deletedSessionsCount: deletedSessions.length,
      sessionsToNotifyCount: sessionsToNotify.length,
    });

    // ========================================
    // Step 2.4: Revoke Native SSO device_secrets for deleted sessions
    // ========================================
    // When a session is invalidated, all associated device_secrets should also be revoked
    // to prevent continued Native SSO token exchange from other apps
    if (deletedSessions.length > 0 && c.env.DB) {
      const nativeSSOEnabled = await isNativeSSOEnabled(c.env);
      if (nativeSSOEnabled) {
        try {
          const adapter = new D1Adapter({ db: c.env.DB });
          const deviceSecretRepo = new DeviceSecretRepository(adapter);

          let totalRevoked = 0;
          for (const sessId of deletedSessions) {
            const revokedCount = await deviceSecretRepo.revokeBySessionId(sessId, 'session_logout');
            totalRevoked += revokedCount;
          }

          if (totalRevoked > 0) {
            log.info('Revoked device secrets', {
              revokedCount: totalRevoked,
              sessionCount: deletedSessions.length,
              action: 'NativeSSO',
            });
          }
        } catch (error) {
          // Log but don't fail logout if device_secret revocation fails
          log.error('Failed to revoke device secrets', {}, error as Error);
        }
      }
    }

    // ========================================
    // Step 2.4.1: Publish user.logout and session.user.destroyed events
    // ========================================
    // Publish events for each deleted session (non-blocking)
    for (const deletedSessionId of deletedSessions) {
      const sessionInfo = sessionsToNotify.find((s) => s.sessionId === deletedSessionId);
      const effectiveUserId = sessionInfo?.userId || userId || '';

      // Publish user.logout event
      publishEvent(c, {
        type: USER_EVENTS.LOGOUT,
        tenantId,
        data: {
          sessionId: deletedSessionId,
          userId: effectiveUserId,
          reason: 'logout',
        } satisfies UserEventData,
      }).catch((err) => {
        log.error('Failed to publish user.logout event', { action: 'Event' }, err as Error);
      });

      // Publish session.user.destroyed event
      publishEvent(c, {
        type: SESSION_EVENTS.USER_DESTROYED,
        tenantId,
        data: {
          sessionId: deletedSessionId,
          userId: effectiveUserId,
          reason: 'logout',
        } satisfies SessionEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish session.user.destroyed event',
          { action: 'Event' },
          err as Error
        );
      });

      // Write audit log for user logout (non-blocking)
      const ipAddress =
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        c.req.header('X-Real-IP') ||
        'unknown';
      const userAgent = c.req.header('User-Agent') || 'unknown';

      // Schedule audit log with waitUntil to ensure it completes after response
      const auditPromise = createAuditLog(c.env, {
        tenantId,
        userId: effectiveUserId,
        action: 'user.logout',
        resource: 'session',
        resourceId: deletedSessionId,
        ipAddress,
        userAgent,
        metadata: JSON.stringify({ client_id: clientId, reason: 'frontchannel_logout' }),
        severity: 'info',
      }).catch((err) => {
        log.error('Failed to create audit log for logout', { action: 'audit_log' }, err as Error);
      });
      c.executionCtx?.waitUntil(auditPromise);
    }

    // ========================================
    // Step 2.5: Send Backchannel Logout notifications (async)
    // ========================================
    // Use waitUntil() to send notifications without blocking the response
    // Get logout config for both backchannel and frontchannel
    const logoutConfig = await getLogoutConfig(c.env);

    if (deletedSessions.length > 0 && c.executionCtx) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            if (!logoutConfig.backchannel.enabled) {
              log.debug('Backchannel logout is disabled', { action: 'BackchannelLogout' });
              return;
            }

            // Get signing key for logout tokens
            const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
            const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
            const keys = await keyManager.getAllPublicKeysRpc();

            if (!keys || keys.length === 0) {
              log.error('No signing keys available', { action: 'BackchannelLogout' });
              return;
            }

            // Get the private key from KeyManager
            const activeKey = await keyManager.getActiveKeyWithPrivateRpc();

            if (!activeKey || !activeKey.privatePEM) {
              log.error('No private key available', { action: 'BackchannelLogout' });
              return;
            }

            const kid = activeKey.kid;

            // Import private key for signing
            const privateKey = await importPrivateKeyPem(activeKey.privatePEM);

            // Create orchestrator
            const kv = c.env.SETTINGS || c.env.STATE_STORE;
            const orchestrator = createBackchannelLogoutOrchestrator(kv);

            // Send logout notifications for each deleted session
            const allResults: LogoutSendResult[] = [];

            for (const {
              sessionId: sessId,
              userId: sessUserId,
              backchannelClients,
            } of sessionsToNotify) {
              if (backchannelClients.length === 0) {
                log.debug('No clients to notify for session', {
                  sessionId: sessId,
                  action: 'BackchannelLogout',
                });
                continue;
              }

              log.info('Sending logout notifications', {
                sessionId: sessId,
                clientCount: backchannelClients.length,
                action: 'BackchannelLogout',
              });

              const results = await orchestrator.sendToAll(
                backchannelClients,
                {
                  issuer: c.env.ISSUER_URL,
                  userId: sessUserId,
                  sessionId: sessId,
                  privateKey,
                  kid,
                },
                logoutConfig.backchannel
              );

              allResults.push(...results);
            }

            // Log summary
            const succeeded = allResults.filter((r) => r.success).length;
            const failed = allResults.filter((r) => !r.success).length;
            log.info('Backchannel logout completed', {
              succeeded,
              failed,
              action: 'BackchannelLogout',
            });
          } catch (error) {
            log.error(
              'Error sending notifications',
              { action: 'BackchannelLogout' },
              error as Error
            );
          }
        })()
      );
    }

    // ========================================
    // Step 2.6: Send Simple Logout Webhook notifications (async)
    // ========================================
    // Use waitUntil() to send webhook notifications without blocking the response
    // This is an Authrim extension for clients that don't support OIDC Back-Channel Logout
    if (deletedSessions.length > 0 && c.executionCtx) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            // Get webhook configuration from KV
            const webhookConfig = await getLogoutWebhookConfig(c.env.SETTINGS);

            if (!webhookConfig.enabled) {
              log.debug('Logout webhook is disabled', { action: 'LogoutWebhook' });
              return;
            }

            // Check if we have any webhook clients to notify
            const hasWebhookClients = sessionsToNotify.some((s) => s.webhookClients.length > 0);
            if (!hasWebhookClients) {
              log.debug('No webhook clients to notify', { action: 'LogoutWebhook' });
              return;
            }

            // Get encryption key for decrypting webhook secrets
            const encryptionKey = c.env.RP_TOKEN_ENCRYPTION_KEY || c.env.PII_ENCRYPTION_KEY;
            if (!encryptionKey) {
              log.error('No encryption key for decrypting webhook secrets', {
                action: 'LogoutWebhook',
              });
              return;
            }

            // Create secret decryption function
            // SECURITY: Wrap decryption in try-catch to avoid leaking key info in errors
            const decryptSecret = async (encrypted: string): Promise<string> => {
              try {
                const result = await decryptValue(encrypted, encryptionKey);
                return result.decrypted;
              } catch {
                // SECURITY: Do not expose decryption error details
                log.error('Failed to decrypt webhook secret', { action: 'LogoutWebhook' });
                throw new Error('Decryption failed');
              }
            };

            // Create orchestrator
            const kv = c.env.SETTINGS || c.env.STATE_STORE;
            const orchestrator = createLogoutWebhookOrchestrator(kv);

            // Send webhook notifications for each deleted session
            const allResults: LogoutWebhookSendResult[] = [];

            for (const {
              sessionId: sessId,
              userId: sessUserId,
              webhookClients,
            } of sessionsToNotify) {
              if (webhookClients.length === 0) {
                continue;
              }

              log.info('Sending webhook notifications', {
                sessionId: sessId,
                clientCount: webhookClients.length,
                action: 'LogoutWebhook',
              });

              const results = await orchestrator.sendToAll(
                webhookClients,
                {
                  issuer: c.env.ISSUER_URL,
                  userId: sessUserId,
                  sessionId: sessId,
                },
                webhookConfig,
                decryptSecret
              );

              allResults.push(...results);
            }

            // Log summary
            const succeeded = allResults.filter((r) => r.success).length;
            const failed = allResults.filter((r) => !r.success).length;
            log.info('Logout webhook completed', { succeeded, failed, action: 'LogoutWebhook' });
          } catch (error) {
            log.error('Error sending notifications', { action: 'LogoutWebhook' }, error as Error);
          }
        })()
      );
    }

    // Step 3: Clear session cookies immediately (both session and browser state)
    // SameSite must match the original cookie setting for proper deletion
    setCookie(c, 'authrim_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: 0,
    });
    setCookie(c, BROWSER_STATE_COOKIE_NAME, '', {
      path: '/',
      secure: true,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: 0,
    });

    // ========================================
    // Step 4: Validate parameters for redirect
    // ========================================
    // Even if validation fails, user is already logged out.
    // Validation only determines WHERE to redirect.

    // Track validation state and error reason
    let canRedirectToRequestedUri = true;
    let validationError: string | undefined;

    // Step 4a: Validate parameter combination
    // If post_logout_redirect_uri is provided, id_token_hint is required
    const paramValidation = validateLogoutParameters(postLogoutRedirectUri, idTokenHint, true);
    if (!paramValidation.valid) {
      log.warn('Logout parameter validation failed', { error: paramValidation.error });
      canRedirectToRequestedUri = false;
      validationError = 'id_token_hint_required';
    }

    // Step 4b: Check if id_token_hint was valid (already validated in Step 1)
    // Only treat invalid id_token_hint as an error when post_logout_redirect_uri is provided,
    // since we need to validate the redirect URI against the client's registered URIs.
    // Without post_logout_redirect_uri, invalid id_token_hint just means we can't use sid from it.
    if (canRedirectToRequestedUri && postLogoutRedirectUri && idTokenHint && !idTokenValid) {
      canRedirectToRequestedUri = false;
      validationError = 'invalid_id_token_hint';
    }

    // Step 4c: Validate post_logout_redirect_uri if provided
    if (canRedirectToRequestedUri && postLogoutRedirectUri) {
      if (!clientId) {
        log.warn('Cannot validate post_logout_redirect_uri without valid id_token_hint');
        canRedirectToRequestedUri = false;
        validationError = 'invalid_id_token_hint';
      } else {
        // Get client configuration via Repository (reuse authCtx from Step 2)
        const client = await authCtx.repositories.client.findByClientId(clientId);

        if (!client) {
          log.warn('Client not found for logout', { clientId });
          canRedirectToRequestedUri = false;
          validationError = 'invalid_client';
        } else {
          // Per OIDC RP-Initiated Logout 1.0, only post_logout_redirect_uris should be used
          let registeredUris: string[] = [];
          if (client.post_logout_redirect_uris) {
            registeredUris =
              typeof client.post_logout_redirect_uris === 'string'
                ? JSON.parse(client.post_logout_redirect_uris)
                : client.post_logout_redirect_uris;
          }

          if (registeredUris.length === 0) {
            log.warn('No post_logout_redirect_uris registered for client', { clientId });
            canRedirectToRequestedUri = false;
            validationError = 'unregistered_post_logout_redirect_uri';
          } else {
            const uriValidation = validatePostLogoutRedirectUri(
              postLogoutRedirectUri,
              registeredUris
            );
            if (!uriValidation.valid) {
              log.warn('post_logout_redirect_uri validation failed', {
                error: uriValidation.error,
              });
              canRedirectToRequestedUri = false;
              validationError = 'unregistered_post_logout_redirect_uri';
            }
          }
        }
      }
    }

    // Log the logout event
    log.info('User logged out', {
      userId: userId || 'unknown',
      clientId: clientId || 'unknown',
      cookieSessionId: sessionId || 'none',
      sidFromToken: sid || 'none',
      deletedSessionsCount: deletedSessions.length,
      idTokenValid,
      validationError: validationError || 'none',
    });

    // ========================================
    // Step 5: Build redirect URL
    // ========================================
    let redirectUrl: string;

    if (canRedirectToRequestedUri && postLogoutRedirectUri) {
      // Validation passed - redirect to requested URI
      redirectUrl = postLogoutRedirectUri;
      if (state) {
        const url = new URL(redirectUrl);
        url.searchParams.set('state', state);
        redirectUrl = url.toString();
      }
    } else if (validationError) {
      // Validation failed - redirect to error page
      // Per OIDC spec, OP SHOULD display an error page when validation fails
      const errorUrl = new URL(`${c.env.ISSUER_URL}/logout-error`);
      errorUrl.searchParams.set('error', validationError);
      redirectUrl = errorUrl.toString();
    } else {
      // No URI requested and no error - redirect to default logout success page
      redirectUrl = `${c.env.ISSUER_URL}/logged-out`;
    }

    // ========================================
    // Step 5.5: Check for Frontchannel Logout
    // ========================================
    // If any RP has frontchannel_logout_uri, show a page with iframes
    // before redirecting to post_logout_redirect_uri
    // Note: We check sessionsToNotify instead of deletedSessions because
    // session may not exist in Durable Object (expired) but we still have
    // client registrations to notify.
    if (logoutConfig.frontchannel.enabled && sessionsToNotify.length > 0) {
      // Collect all frontchannel logout clients from sessions
      const frontchannelClients = [];
      // Use session from sessionsToNotify (may include sessions not in deletedSessions)
      const primarySessionId = sessionsToNotify[0]?.sessionId || deletedSessions[0] || sid || '';

      for (const { frontchannelClients: clients } of sessionsToNotify) {
        frontchannelClients.push(...clients);
      }

      if (frontchannelClients.length > 0) {
        log.info('Showing iframe page for frontchannel clients', {
          clientCount: frontchannelClients.length,
          action: 'FrontchannelLogout',
        });

        // Log client details for debugging
        for (const client of frontchannelClients) {
          log.debug('Frontchannel client', {
            clientId: client.client_id,
            uri: client.frontchannel_logout_uri,
            sessionRequired: client.frontchannel_logout_session_required,
            action: 'FrontchannelLogout',
          });
        }

        // Build iframe configurations
        const iframes = buildFrontchannelLogoutIframes(
          frontchannelClients,
          c.env.ISSUER_URL,
          primarySessionId
        );

        // Log generated iframe URLs for debugging
        for (const iframe of iframes) {
          log.debug('Iframe URL', { logoutUri: iframe.logoutUri, action: 'FrontchannelLogout' });
        }

        // Generate HTML page with iframes
        const html = generateFrontchannelLogoutHtml(
          iframes,
          logoutConfig.frontchannel,
          redirectUrl,
          undefined // state already included in redirectUrl
        );

        // Return HTML response with Set-Cookie headers to clear session and browser state
        // SameSite is determined dynamically based on origin configuration
        const sessionSameSite = getSessionCookieSameSite(c.env);
        const browserStateSameSite = getBrowserStateCookieSameSite(c.env);
        const responseHeaders = new Headers({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        // Clear both cookies - need append() for multiple Set-Cookie headers
        responseHeaders.append(
          'Set-Cookie',
          `authrim_session=; Path=/; HttpOnly; Secure; SameSite=${sessionSameSite}; Max-Age=0`
        );
        responseHeaders.append(
          'Set-Cookie',
          `${BROWSER_STATE_COOKIE_NAME}=; Path=/; Secure; SameSite=${browserStateSameSite}; Max-Age=0`
        );
        return new Response(html, {
          status: 200,
          headers: responseHeaders,
        });
      }
    }

    // Step 6: Redirect to post-logout URI (no frontchannel clients)
    // IMPORTANT: Hono's c.redirect() creates a new Response that doesn't include
    // headers set via setCookie(). We need to manually add the Set-Cookie header
    // to ensure the session cookie is properly cleared in the browser.
    const response = c.redirect(redirectUrl, 302);

    // Clone the response and add the Set-Cookie headers (need append for multiple cookies)
    // SameSite is determined dynamically based on origin configuration
    const sessionSameSiteRedirect = getSessionCookieSameSite(c.env);
    const browserStateSameSiteRedirect = getBrowserStateCookieSameSite(c.env);
    const headers = new Headers(response.headers);
    headers.append(
      'Set-Cookie',
      `authrim_session=; Path=/; HttpOnly; Secure; SameSite=${sessionSameSiteRedirect}; Max-Age=0`
    );
    headers.append(
      'Set-Cookie',
      `${BROWSER_STATE_COOKIE_NAME}=; Path=/; Secure; SameSite=${browserStateSameSiteRedirect}; Max-Age=0`
    );

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    log.error('Front-channel logout error', {}, error as Error);
    // Even on error, try to clear session cookies
    setCookie(c, 'authrim_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: 0,
    });
    setCookie(c, BROWSER_STATE_COOKIE_NAME, '', {
      path: '/',
      secure: true,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: 0,
    });
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process logout request',
      },
      500
    );
  }
}

/**
 * Back-channel Logout
 * POST /logout/backchannel
 *
 * Handles server-to-server logout notifications per RFC 8725.
 * Allows an RP to notify the OP that a user has logged out.
 *
 * Request Body (application/x-www-form-urlencoded):
 * - logout_token: JWT containing logout claims
 *
 * Logout Token Claims:
 * - iss: Issuer identifier
 * - sub: Subject identifier (user ID)
 * - aud: Client ID
 * - iat: Issued at
 * - jti: Unique identifier
 * - events: { "http://schemas.openid.net/event/backchannel-logout": {} }
 * - sid: Session ID (optional)
 */
export async function backChannelLogoutHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LOGOUT');
  try {
    // Parse form data
    const body = await c.req.parseBody();
    const logoutToken = body['logout_token'];

    if (!logoutToken || typeof logoutToken !== 'string') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token is required',
        },
        400
      );
    }

    // Validate client authentication (using HTTP Basic Auth or client assertion)
    // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
    const authHeader = c.req.header('Authorization');
    let clientId: string | undefined;

    if (authHeader?.startsWith('Basic ')) {
      // HTTP Basic Authentication
      let id: string;
      let secret: string;

      try {
        const credentials = atob(authHeader.substring(6));
        const colonIndex = credentials.indexOf(':');

        if (colonIndex === -1) {
          return c.json(
            {
              error: 'invalid_client',
              error_description: 'Invalid Authorization header format: missing colon separator',
            },
            401
          );
        }

        // RFC 7617 Section 2: The user-id and password are URL-decoded after Base64 decoding
        id = decodeURIComponent(credentials.substring(0, colonIndex));
        secret = decodeURIComponent(credentials.substring(colonIndex + 1));
      } catch {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Invalid Authorization header format',
          },
          401
        );
      }

      // Verify client credentials via Repository
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);
      const client = await authCtx.repositories.client.findByClientId(id);

      // Verify client secret against stored SHA-256 hash
      if (
        !client ||
        !client.client_secret_hash ||
        !(await verifyClientSecretHash(secret, client.client_secret_hash))
      ) {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          },
          401
        );
      }

      clientId = id;
    } else {
      // For now, allow unauthenticated back-channel logout for testing
      // In production, this should require proper client authentication
      log.warn('Back-channel logout called without client authentication');
    }

    // Verify logout token
    let logoutClaims: LogoutTokenPayload;
    try {
      // Get signing key from KeyManager
      const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
      const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

      const keys = await keyManager.getAllPublicKeysRpc();

      if (!keys || keys.length === 0) {
        throw new Error('No keys in JWKS');
      }

      const jwks = { keys } as JSONWebKeySet;

      // Extract kid from logout token header and find matching key
      let key;
      try {
        const headerPart = logoutToken.split('.')[0];
        const header = JSON.parse(atob(headerPart.replace(/-/g, '+').replace(/_/g, '/')));
        const targetKid = header.kid;

        if (targetKid) {
          key = jwks.keys.find((k) => k.kid === targetKid);
          if (!key) {
            // SECURITY: Do not expose kid value in error to prevent key enumeration
            throw new Error('Key verification failed');
          }
        } else {
          key = jwks.keys[0];
        }
      } catch {
        // If we can't parse the header, fall back to first key
        key = jwks.keys[0];
      }

      if (!key) {
        throw new Error('No keys in JWKS');
      }

      const publicKey = await importJWK(key);

      // Verify JWT
      const { payload } = await jwtVerify(logoutToken, publicKey, {
        issuer: c.env.ISSUER_URL,
        algorithms: ['RS256'],
      });

      logoutClaims = payload as LogoutTokenPayload;
    } catch (error) {
      log.error('Logout token validation error', {}, error as Error);
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid logout_token',
        },
        400
      );
    }

    // Validate logout token claims
    if (!logoutClaims.sub) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token must contain sub claim',
        },
        400
      );
    }

    // Validate events claim
    const events = logoutClaims.events;
    if (!events || !events['http://schemas.openid.net/event/backchannel-logout']) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token must contain backchannel-logout event',
        },
        400
      );
    }

    // Validate that nonce is not present (per spec)
    if (logoutClaims.nonce) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token must not contain nonce claim',
        },
        400
      );
    }

    const userId = logoutClaims.sub as string;
    const sessionId = logoutClaims.sid as string | undefined;

    // Invalidate sessions
    // With sharded SessionStore, we can only delete sessions by specific sessionId
    let sessionDeleted = false;
    if (sessionId && isShardedSessionId(sessionId)) {
      // Invalidate specific session using sharded routing via RPC
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
        const deleted = await sessionStore.invalidateSessionRpc(sessionId);

        if (deleted) {
          sessionDeleted = true;
        } else {
          log.warn('Failed to delete session', { sessionId, action: 'BackchannelLogout' });
        }
      } catch (error) {
        log.warn('Failed to route to session store for back-channel logout', {
          sessionId,
          error: (error as Error).message,
          action: 'BackchannelLogout',
        });
      }
    } else if (sessionId) {
      // Legacy non-sharded session ID - cannot route
      log.warn('Cannot delete legacy session format', { sessionId, action: 'BackchannelLogout' });
    } else {
      // No sessionId provided - "delete all user sessions" is not supported with sharding
      // This would require maintaining a userId -> sessionIds index across all shards
      log.warn('Cannot invalidate all sessions without sessionId', {
        userId,
        action: 'BackchannelLogout',
      });
    }

    // Revoke Native SSO device_secrets for the deleted session
    if (sessionDeleted && sessionId && c.env.DB) {
      const nativeSSOEnabled = await isNativeSSOEnabled(c.env);
      if (nativeSSOEnabled) {
        try {
          const adapter = new D1Adapter({ db: c.env.DB });
          const deviceSecretRepo = new DeviceSecretRepository(adapter);
          const revokedCount = await deviceSecretRepo.revokeBySessionId(
            sessionId,
            'backchannel_logout'
          );
          if (revokedCount > 0) {
            log.info('Revoked device secrets', {
              revokedCount,
              sessionId,
              action: 'BackchannelLogout',
            });
          }
        } catch (error) {
          log.error(
            'Failed to revoke device secrets',
            { action: 'BackchannelLogout' },
            error as Error
          );
        }
      }
    }

    // Publish events for backchannel logout (non-blocking)
    if (sessionDeleted && sessionId) {
      const tenantIdForEvent = getTenantIdFromContext(c);

      // Publish user.logout event
      publishEvent(c, {
        type: USER_EVENTS.LOGOUT,
        tenantId: tenantIdForEvent,
        data: {
          sessionId,
          userId,
          reason: 'logout',
        } satisfies UserEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish user.logout event (backchannel)',
          { action: 'Event' },
          err as Error
        );
      });

      // Publish session.user.destroyed event
      publishEvent(c, {
        type: SESSION_EVENTS.USER_DESTROYED,
        tenantId: tenantIdForEvent,
        data: {
          sessionId,
          userId,
          reason: 'logout',
        } satisfies SessionEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish session.user.destroyed event (backchannel)',
          { action: 'Event' },
          err as Error
        );
      });

      // Write audit log for backchannel logout (non-blocking)
      const ipAddress =
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        c.req.header('X-Real-IP') ||
        'unknown';
      const userAgent = c.req.header('User-Agent') || 'unknown';

      // Schedule audit log with waitUntil to ensure it completes after response
      const auditPromise = createAuditLog(c.env, {
        tenantId: tenantIdForEvent,
        userId,
        action: 'user.logout',
        resource: 'session',
        resourceId: sessionId,
        ipAddress,
        userAgent,
        metadata: JSON.stringify({ client_id: clientId, reason: 'backchannel_logout' }),
        severity: 'info',
      }).catch((err) => {
        log.error(
          'Failed to create audit log for backchannel logout',
          { action: 'audit_log' },
          err as Error
        );
      });
      c.executionCtx?.waitUntil(auditPromise);
    }

    // Log the logout event
    log.info('Back-channel logout completed', {
      userId,
      sessionId: sessionId || 'all',
      clientId: clientId || 'unknown',
      action: 'BackchannelLogout',
    });

    // Return 200 OK (no content)
    return c.body(null, 200);
  } catch (error) {
    log.error('Back-channel logout error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process logout request',
      },
      500
    );
  }
}
