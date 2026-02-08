/**
 * Handoff Token Verification Handler
 * POST /api/v1/auth/handoff/verify
 *
 * RPがハンドオフトークンを検証し、RP専用のアクセストークンを発行する
 *
 * セキュリティ:
 * - Origin検証（client_idのallowedRedirectUrisからoriginを抽出して照合）
 * - State検証（CSRF対策）
 * - aud検証（トークン再利用防止）
 * - Rate Limiting（brute force対策）
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { Session } from '@authrim/ar-lib-core';
import {
  getChallengeStoreByChallengeId,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isShardedSessionId,
  getTenantIdFromContext,
  createAuthContextFromHono,
  createPIIContextFromHono,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  checkRateLimit,
  type RateLimitConfig,
  isAllowedOriginForClient,
} from '@authrim/ar-lib-core';

export async function handleHandoffVerify(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('HANDOFF');
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown';

  try {
    const body = await c.req.json<{
      handoff_token: string;
      state: string;
      client_id: string;
    }>();

    const { handoff_token, state, client_id } = body;

    if (!handoff_token || !state || !client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'handoff_token, state, client_id' },
      });
    }

    // 0. Rate Limiting（brute force対策）
    const rateLimitKey = `handoff:verify:${client_id}:${clientIp}`;
    const rateLimitConfig: RateLimitConfig = {
      maxRequests: 10, // 10回
      windowSeconds: 60, // 60秒
    };

    try {
      const { allowed } = await checkRateLimit(c.env, rateLimitKey, rateLimitConfig);

      if (!allowed) {
        log.warn('Rate limit exceeded', {
          client_id,
          ip: clientIp,
        });
        return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED);
      }
    } catch (rateLimitError) {
      // Rate limit check failed - log but continue (fail-open for availability)
      log.error('Rate limit check failed', {}, rateLimitError as Error);
    }

    // 1. Origin検証（必須：攻撃防止）
    let origin: string | null = c.req.header('Origin') || null;

    // Originヘッダーがない場合、RefererからoriginToを抽出（try-catchで処理）
    if (!origin) {
      const referer = c.req.header('Referer');
      if (referer) {
        try {
          origin = new URL(referer).origin;
        } catch {
          origin = null;
        }
      }
    }

    if (!origin) {
      log.error('Missing Origin header', {
        client_id,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED);
    }

    // client_idに紐づくallowedRedirectUrisからoriginを抽出して検証
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const client = await authCtx.repositories.client.findByClientId(client_id);

    if (!client) {
      log.error('Client not found', {
        client_id,
        origin,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_CLIENT_NOT_FOUND);
    }

    // Parse redirect_uris from JSON string or plain string
    let redirectUris: string[];
    try {
      // Check if redirect_uris exists
      if (!client.redirect_uris) {
        throw new Error('redirect_uris is missing or null');
      }

      // Check if redirect_uris is already an array (shouldn't happen, but defensive)
      if (Array.isArray(client.redirect_uris)) {
        redirectUris = client.redirect_uris;
      } else if (typeof client.redirect_uris === 'string') {
        // Try to parse as JSON array first
        if (client.redirect_uris.trim().startsWith('[')) {
          redirectUris = JSON.parse(client.redirect_uris);
          if (!Array.isArray(redirectUris)) {
            throw new Error('redirect_uris is not an array after parsing');
          }
        } else {
          // Treat as single URL string (legacy format or misconfigured client)
          redirectUris = [client.redirect_uris];
        }
      } else {
        throw new Error(`redirect_uris has unexpected type: ${typeof client.redirect_uris}`);
      }
    } catch (parseError) {
      log.error('Invalid redirect_uris format', {
        client_id,
        redirect_uris_type: typeof client.redirect_uris,
        redirect_uris_length: client.redirect_uris?.length || 0,
        error: parseError instanceof Error ? parseError.message : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_METADATA_INVALID);
    }

    // Determine if localhost is allowed based on environment
    const allowLocalhost =
      c.env.ENVIRONMENT === 'development' ||
      c.env.ALLOW_LOCALHOST === 'true' ||
      c.env.ALLOW_LOCALHOST === '1';

    // Create client-like object for origin validation
    const clientForValidation = {
      redirect: {
        allowedRedirectUris: redirectUris,
        allowLocalhost,
      },
    };

    if (!isAllowedOriginForClient(clientForValidation, origin)) {
      log.error('Origin not allowed - POTENTIAL ATTACK', {
        client_id,
        origin,
        allowed_redirect_uris: redirectUris,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED);
    }

    // 2. ハンドオフトークンを消費
    const handoffStore = await getChallengeStoreByChallengeId(c.env, handoff_token);

    let handoffData: {
      challenge: string; // sessionId
      userId: string;
      metadata?: {
        client_id: string;
        state: string;
        aud: string;
        created_at: number;
      };
    };

    try {
      handoffData = (await handoffStore.consumeChallengeRpc({
        id: `handoff:${handoff_token}`,
        type: 'handoff',
      })) as typeof handoffData;
    } catch {
      log.warn('Invalid or expired handoff token', {
        client_id,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // 3. aud検証（トークン再利用防止）
    if (handoffData.metadata?.aud !== 'handoff') {
      log.error('Invalid token audience', {
        expected: 'handoff',
        received: handoffData.metadata?.aud,
        client_id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // 4. State検証（CSRF対策）
    if (handoffData.metadata?.state !== state) {
      log.error('State mismatch - POTENTIAL CSRF ATTACK', {
        expected: handoffData.metadata?.state,
        received: state,
        client_id,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // 5. client_id検証
    if (handoffData.metadata?.client_id !== client_id) {
      log.error('Client ID mismatch - POTENTIAL ATTACK', {
        expected: handoffData.metadata?.client_id,
        received: client_id,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // 6. AS SSOセッション検証
    const asSessionId = handoffData.challenge;

    if (!isShardedSessionId(asSessionId)) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const { stub: asSessionStore } = getSessionStoreBySessionId(c.env, asSessionId);
    const asSessionResult = await asSessionStore.getSessionRpc(asSessionId);

    if (!asSessionResult) {
      log.warn('AS SSO session expired', {
        sessionId: asSessionId,
        client_id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Use explicit type annotation after null check
    const asSession: Session = asSessionResult;

    // 7. ユーザー情報取得
    const userCore = await authCtx.repositories.userCore.findById(handoffData.userId);

    if (!userCore || !userCore.is_active) {
      log.warn('User not found or inactive', {
        userId: handoffData.userId,
        client_id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    let userPII: { email: string | null; name: string | null } = { email: null, name: null };
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(handoffData.userId);
      if (piiResult) {
        userPII = { email: piiResult.email, name: piiResult.name || null };
      }
    }

    // 8. RP専用のAccess Token（Session）を新規発行
    // ⚠️ 重要: AS SessionIDを直接返さない（XSS対策）
    const { stub: rpSessionStore, sessionId: rpAccessToken } = await getSessionStoreForNewSession(
      c.env
    );
    const rpTokenTTL = 60 * 60; // 1時間（短命化）

    await rpSessionStore.createSessionRpc(rpAccessToken, handoffData.userId, rpTokenTTL, {
      email: userPII.email,
      name: userPII.name,
      amr: asSession.data?.amr || ['external_idp'],
      acr: asSession.data?.acr || 'urn:mace:incommon:iap:bronze',
      client_id,
      audience: 'rp', // RP用トークンであることを明示
      source_session_id: asSessionId, // AS SessionIDを記録（監査用）
    });

    log.info('Handoff successful', {
      userId: handoffData.userId,
      client_id,
      rpAccessToken,
    });

    // 9. レスポンス返却
    return c.json({
      token_type: 'Bearer',
      access_token: rpAccessToken, // RP専用トークン（AS SessionIDとは別）
      expires_in: rpTokenTTL,
      session: {
        id: rpAccessToken,
        userId: handoffData.userId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + rpTokenTTL * 1000).toISOString(),
      },
      user: {
        id: handoffData.userId,
        email: userPII.email,
        name: userPII.name,
        emailVerified: userCore.email_verified,
      },
    });
  } catch (error) {
    log.error('Handoff verify error', {
      action: 'handoff_verify',
      errorType: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
