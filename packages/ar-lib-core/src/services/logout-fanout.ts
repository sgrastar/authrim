/**
 * Downstream Logout Fan-out
 *
 * Tells the relying parties signed in through ended sessions that those sessions ended: by OIDC
 * Back-Channel Logout (one logout token per client, with that client's sid) and by the Simple
 * Logout Webhook (Authrim extension).
 *
 * Shared by the user logout (ar-auth) and the upstream IdP back-channel logout (ar-bridge), so a
 * relying party is told the same way whichever side ended the session: same orchestrators, same
 * retries and timeouts, same failure records. Both callers run it after their response
 * (waitUntil); it never throws.
 *
 * @packageDocumentation
 */

import { importPKCS8 } from 'jose';
import type { CryptoKey } from 'jose';
import type { Env } from '../types/env';
import type {
  BackchannelLogoutConfig,
  LogoutSendResult,
  LogoutWebhookConfig,
  LogoutWebhookSendResult,
  SessionClientWithWebhook,
} from '../types/logout';
import type { SessionClientWithDetails } from '../repositories/core/session-client';
import { createLogger, type Logger } from '../utils/logger';
import { buildIssuerUrl } from '../utils/issuer';
import { buildCanonicalTenantIssuerUrl } from './tenant-vanity-domain-resolver';
import { decryptValue } from '../utils/pii-encryption';
import {
  createBackchannelLogoutOrchestrator,
  type BackchannelRetryOptions,
} from './backchannel-logout-sender';
import { createLogoutWebhookOrchestrator } from './logout-webhook-sender';

/**
 * The issuer the logout tokens and webhooks of a tenant carry: the tenant's canonical one (its
 * primary domain, else the configured one), never one made from the host of the request that
 * ended the session. A relying party checks the logout token's iss against the issuer of its ID
 * tokens, and the host of a request (an upstream notice, a user's browser) is not the tenant's to
 * vouch for.
 *
 * Strict: when the primary domain cannot be read, or no issuer is configured, this throws instead
 * of signing with another issuer, and the caller handles it as it handles any failure before
 * sending.
 */
export async function resolveLogoutIssuer(
  env: Parameters<typeof buildCanonicalTenantIssuerUrl>[0],
  tenantId: string
): Promise<string> {
  const issuer = await buildCanonicalTenantIssuerUrl(env, tenantId, buildIssuerUrl(env, tenantId), {
    strict: true,
  });
  if (!issuer) {
    throw new Error('logout_issuer_unavailable');
  }
  return issuer;
}

/** An ended session and the relying parties to tell. */
export interface LogoutFanoutSession {
  sessionId: string;
  userId: string;
  backchannelClients: SessionClientWithDetails[];
  webhookClients: SessionClientWithWebhook[];
}

/** How many notifications were delivered and how many finally failed. */
export interface LogoutFanoutSummary {
  succeeded: number;
  failed: number;
  /**
   * Sessions whose sending broke off with an error before every client of theirs had a result
   * (logged, not in `failed`): a caller that can retry the whole notice does so.
   */
  sessionErrors: number;
}

type FanoutEnv = Pick<
  Env,
  'KEY_MANAGER' | 'SETTINGS' | 'STATE_STORE' | 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY'
>;

const defaultLog = createLogger().module('LOGOUT-FANOUT');

/**
 * How many sessions are notified at once. Each session's clients are sent to together already;
 * running sessions side by side keeps a slow relying party of one session from holding back the
 * first attempts to the others (an upstream logout can end many sessions, and the work after the
 * response has a time limit).
 */
const MAX_CONCURRENT_SESSIONS = 5;

/**
 * Run `task` for every item, at most `limit` at a time. A failing item is reported to `onError`
 * and the others go on: this ends only when every started task has ended, so the work after the
 * response is not given up while sends are still running.
 */
async function forEachConcurrently<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
  onError: (item: T, error: unknown) => void
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch (error) {
        onError(item, error);
      }
    }
  });
  await Promise.all(workers);
}

async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  return importPKCS8(pem, 'RS256');
}

/**
 * Send OIDC Back-Channel Logout tokens for ended sessions. Returns null when nothing was sent
 * (disabled, no signing key, or an error before sending).
 */
export async function sendBackchannelLogoutFanout(
  env: FanoutEnv,
  params: {
    tenantId: string;
    issuer: string;
    sessions: LogoutFanoutSession[];
    config: BackchannelLogoutConfig;
    /** When the background work began: the retry budget counts from it (default: now). */
    startedAt?: number;
    /** Called when a client still fails after its retries and `on_final_failure` is 'alert'. */
    onAlert?: BackchannelRetryOptions['onAlert'];
    log?: Logger;
  }
): Promise<LogoutFanoutSummary | null> {
  // The retry budget counts from here: loading keys uses it too.
  const startedAt = params.startedAt ?? Date.now();
  const log = params.log ?? defaultLog;
  try {
    if (!params.config.enabled) {
      log.debug('Backchannel logout is disabled', { action: 'BackchannelLogout' });
      return null;
    }

    // Get signing key for logout tokens
    const keyManagerId = env.KEY_MANAGER.idFromName(`${params.tenantId}-v3`);
    const keyManager = env.KEY_MANAGER.get(keyManagerId);
    const keys = await keyManager.getAllPublicKeysRpc();

    if (!keys || keys.length === 0) {
      log.error('No signing keys available', { action: 'BackchannelLogout' });
      return null;
    }

    // Get the private key from KeyManager
    const activeKey = await keyManager.getActiveKeyWithPrivateRpc();

    if (!activeKey || !activeKey.privatePEM) {
      log.error('No private key available', { action: 'BackchannelLogout' });
      return null;
    }

    const kid = activeKey.kid;

    // Import private key for signing
    const privateKey = await importPrivateKeyPem(activeKey.privatePEM);

    // Retries follow session.backchannel_retry_*; a final failure with on_failure 'error'
    // (alert) goes to onAlert.
    const kv = env.SETTINGS || env.STATE_STORE;
    const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
      startedAt,
      onAlert: params.onAlert,
    });

    // Send logout notifications for each ended session
    const allResults: LogoutSendResult[] = [];

    // Retries run behind the first attempts: they are waited for even when a send fails.
    let retried: LogoutSendResult[] = [];
    let sessionErrors = 0;
    try {
      await forEachConcurrently(
        params.sessions,
        MAX_CONCURRENT_SESSIONS,
        async ({ sessionId, userId, backchannelClients }) => {
          if (backchannelClients.length === 0) {
            log.debug('No clients to notify for session', {
              sessionId,
              action: 'BackchannelLogout',
            });
            return;
          }

          log.info('Sending logout notifications', {
            sessionId,
            clientCount: backchannelClients.length,
            action: 'BackchannelLogout',
          });

          const results = await orchestrator.sendToAll(
            backchannelClients,
            { issuer: params.issuer, userId, sessionId, privateKey, kid },
            params.config
          );

          allResults.push(...results);
        },
        (session, error) => {
          sessionErrors++;
          log.error(
            'Error sending notifications for session',
            { sessionId: session.sessionId, action: 'BackchannelLogout' },
            error as Error
          );
        }
      );
    } finally {
      retried = await orchestrator.settle();
    }

    const summary = {
      succeeded:
        allResults.filter((r) => r.success).length + retried.filter((r) => r.success).length,
      failed:
        allResults.filter((r) => !r.success && !r.retryScheduled).length +
        retried.filter((r) => !r.success).length,
      sessionErrors,
    };
    log.info('Backchannel logout completed', { ...summary, action: 'BackchannelLogout' });
    return summary;
  } catch (error) {
    log.error('Error sending notifications', { action: 'BackchannelLogout' }, error as Error);
    return null;
  }
}

/**
 * Send Simple Logout Webhook notifications for ended sessions. Returns null when nothing was sent
 * (disabled, no webhook clients, no decryption key, or an error before sending).
 */
export async function sendLogoutWebhookFanout(
  env: FanoutEnv,
  params: {
    issuer: string;
    sessions: LogoutFanoutSession[];
    config: LogoutWebhookConfig;
    log?: Logger;
  }
): Promise<LogoutFanoutSummary | null> {
  const log = params.log ?? defaultLog;
  try {
    if (!params.config.enabled) {
      log.debug('Logout webhook is disabled', { action: 'LogoutWebhook' });
      return null;
    }

    // Check if we have any webhook clients to notify
    if (!params.sessions.some((s) => s.webhookClients.length > 0)) {
      log.debug('No webhook clients to notify', { action: 'LogoutWebhook' });
      return null;
    }

    // Get encryption key for decrypting webhook secrets
    const encryptionKey = env.RP_TOKEN_ENCRYPTION_KEY || env.PII_ENCRYPTION_KEY;
    if (!encryptionKey) {
      log.error('No encryption key for decrypting webhook secrets', { action: 'LogoutWebhook' });
      return null;
    }

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

    const kv = env.SETTINGS || env.STATE_STORE;
    const orchestrator = createLogoutWebhookOrchestrator(kv);

    // Send webhook notifications for each ended session
    const allResults: LogoutWebhookSendResult[] = [];
    let sessionErrors = 0;

    await forEachConcurrently(
      params.sessions,
      MAX_CONCURRENT_SESSIONS,
      async ({ sessionId, webhookClients }) => {
        if (webhookClients.length === 0) {
          return;
        }

        log.info('Sending webhook notifications', {
          sessionId,
          clientCount: webhookClients.length,
          action: 'LogoutWebhook',
        });

        const results = await orchestrator.sendToAll(
          webhookClients,
          { issuer: params.issuer, sessionId },
          params.config,
          decryptSecret
        );

        allResults.push(...results);
      },
      (session, error) => {
        sessionErrors++;
        log.error(
          'Error sending notifications for session',
          { sessionId: session.sessionId, action: 'LogoutWebhook' },
          error as Error
        );
      }
    );

    const summary = {
      succeeded: allResults.filter((r) => r.success).length,
      failed: allResults.filter((r) => !r.success).length,
      sessionErrors,
    };
    log.info('Logout webhook completed', { ...summary, action: 'LogoutWebhook' });
    return summary;
  } catch (error) {
    log.error('Error sending notifications', { action: 'LogoutWebhook' }, error as Error);
    return null;
  }
}
