/**
 * Status List Credential Endpoint
 *
 * Serves Bitstring Status List 2021 credentials for credential revocation/suspension.
 *
 * Features:
 * - ETag-based caching (Cache-Control: public, max-age=300)
 * - If-None-Match support for 304 responses
 * - JWT-formatted status list credentials
 *
 * @see https://w3c-ccg.github.io/vc-status-list-2021/
 */

import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from '../../types';
import {
  getLogger,
  getTenantIdFromContext,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';
import { getRequestIssuerUrl } from '../../request-identifiers';

/**
 * Status List Credential response format
 */
interface StatusListCredentialPayload extends JWTPayload {
  iss: string;
  iat: number;
  exp: number;
  sub: string;
  vc: {
    '@context': string[];
    type: string[];
    credentialSubject: {
      id: string;
      type: 'BitstringStatusList';
      statusPurpose: 'revocation' | 'suspension';
      encodedList: string;
    };
  };
}

/**
 * Mock repository for development/testing
 * In production, this would use D1 database
 */
interface StatusListData {
  id: string;
  tenant_id: string;
  purpose: 'revocation' | 'suspension';
  encoded_list: string;
  updated_at: string;
}

/**
 * Calculate ETag from list data
 */
async function calculateETag(
  listId: string,
  encodedList: string,
  updatedAt: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${listId}:${encodedList}:${updatedAt}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hashHex.substring(0, 16)}"`;
}

/**
 * Get status list from database
 */
async function getStatusList(
  env: Env,
  tenantId: string,
  listId: string
): Promise<StatusListData | null> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'vc-status-list', {
    tenantId,
  });
  return adapter.queryOne<StatusListData>(
    `SELECT public_id AS id, tenant_id, purpose, encoded_list, updated_at
     FROM status_lists
     WHERE tenant_id = ? AND public_id = ?`,
    [tenantId, listId]
  );
}

/**
 * Generate Status List Credential JWT
 */
async function generateStatusListCredentialJWT(
  env: Env,
  listData: StatusListData,
  issuerUrl: string
): Promise<string> {
  // Get signing key from KeyManager
  const keyManagerId = env.KEY_MANAGER.idFromName(`${listData.tenant_id}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const now = Math.floor(Date.now() / 1000);
  const statusListUri = `${issuerUrl}/vci/status-lists/${listData.id}`;

  const payload: StatusListCredentialPayload = {
    iss: `did:web:${new URL(issuerUrl).hostname}`,
    iat: now,
    exp: now + 86400, // 24 hours
    sub: statusListUri,
    vc: {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/vc/status-list/2021/v1',
      ],
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      credentialSubject: {
        id: `${statusListUri}#list`,
        type: 'BitstringStatusList',
        statusPurpose: listData.purpose,
        encodedList: listData.encoded_list,
      },
    },
  };

  const signingStub = keyManager as unknown as {
    signStatusListCredentialRpc(input: JWTPayload): Promise<{ token: string }>;
  };
  return (await signingStub.signStatusListCredentialRpc(payload)).token;
}

/**
 * GET /vci/status-lists/:listId
 *
 * Returns a Status List Credential in JWT format.
 * Supports ETag-based caching for efficient status checks.
 */
export async function statusListRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-ISSUER');
  const listId = c.req.param('listId');

  if (!listId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing list ID',
      },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  // Get status list from database
  const listData = await getStatusList(c.env, tenantId, listId);

  if (!listData) {
    // SECURITY: Do not expose status list ID in error message to prevent enumeration
    return c.json(
      {
        error: 'not_found',
        error_description: 'Status list not found',
      },
      404
    );
  }

  // Calculate ETag
  const etag = await calculateETag(listData.id, listData.encoded_list, listData.updated_at);

  // Check If-None-Match header
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch === etag) {
    return c.body(null, 304, {
      ETag: etag,
      'Cache-Control': 'public, max-age=300',
    });
  }

  const issuerUrl = getRequestIssuerUrl(c);

  try {
    // Generate JWT credential
    const jwt = await generateStatusListCredentialJWT(c.env, listData, issuerUrl);

    return c.text(jwt, 200, {
      'Content-Type': 'application/statuslist+jwt',
      'Cache-Control': 'public, max-age=300',
      ETag: etag,
    });
  } catch (err) {
    log.error('Failed to generate status list credential', {}, err as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to generate status list credential',
      },
      500
    );
  }
}

/**
 * GET /vci/status-lists/:listId/json
 *
 * Returns status list data in JSON format (for debugging/admin).
 */
export async function statusListJsonRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const listId = c.req.param('listId');

  if (!listId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing list ID',
      },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  const listData = await getStatusList(c.env, tenantId, listId);

  if (!listData) {
    // SECURITY: Do not expose status list ID in error message to prevent enumeration
    return c.json(
      {
        error: 'not_found',
        error_description: 'Status list not found',
      },
      404
    );
  }

  return c.json({
    id: listData.id,
    tenant_id: listData.tenant_id,
    purpose: listData.purpose,
    encoded_list: listData.encoded_list,
    updated_at: listData.updated_at,
  });
}
