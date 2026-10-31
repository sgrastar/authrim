import { createHash } from 'node:crypto';
import type { StoreCodeRequest } from '@authrim/ar-lib-core/durable-objects/AuthorizationCodeStore';
import type { PostgresQueryClient } from './postgres-transient-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const MAX_CODE_TTL_SECONDS = 3600;
const MAX_JSON_BYTES = 64 * 1024;

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Stores the otherwise unused Direct Auth code emitted by a normal SAML passkey login.
 * This deliberately provides no /token consume operation; exposing OIDC requires a
 * separate atomic redemption implementation and a broader readiness profile.
 */
export class PostgresAuthorizationCodeStore {
  constructor(private readonly db: PostgresQueryClient) {}

  async store(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    const ttlSeconds = positiveIntegerOr(request.ttlSeconds, 60);
    const maxCodesPerUser = positiveIntegerOr(request.maxCodesPerUser, 100);
    if (
      !TENANT.test(request.tenantId) ||
      !UUID.test(request.code) ||
      !request.userId ||
      request.userId.length > 256 ||
      !request.clientId ||
      request.clientId.length > 256 ||
      request.redirectUri !== 'https://authrim.local/direct-auth/callback' ||
      request.codeChallengeMethod !== 'S256' ||
      !request.codeChallenge ||
      request.codeChallenge.length > 256 ||
      (request.authorizationServer !== undefined && request.authorizationServer !== 'default') ||
      (request.subjectType !== undefined && request.subjectType !== 'end_user') ||
      ttlSeconds > MAX_CODE_TTL_SECONDS ||
      maxCodesPerUser > 10_000
    ) {
      throw new Error('aws_authorization_code_profile_unsupported');
    }
    const { code: _code, ...details } = request;
    const payload = JSON.stringify(details);
    if (new TextEncoder().encode(payload).length > MAX_JSON_BYTES) {
      throw new Error('aws_authorization_code_too_large');
    }
    const codeHash = createHash('sha256').update(request.code).digest('hex');
    // The database function counts after acquiring the per-user transaction lock.
    // A duplicate code or exhausted budget fails closed without replacing data.
    const result = await this.db.query<{ expires_at_ms: string | number }>(
      `SELECT authrim_aws_store_authorization_code(
         $1, $2, $3::char(64), $4, $5::jsonb, $6::integer, $7::integer
       ) AS expires_at_ms`,
      [
        request.tenantId,
        request.userId,
        codeHash,
        request.clientId,
        payload,
        ttlSeconds,
        maxCodesPerUser,
      ]
    );
    const value = result.rows[0]?.expires_at_ms;
    if (value === undefined || value === null) {
      throw new Error('aws_authorization_code_unavailable');
    }
    const expiresAt = Number(value);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('aws_authorization_code_expiry_invalid');
    }
    return { success: true, expiresAt };
  }
}
