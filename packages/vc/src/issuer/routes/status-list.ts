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
import type { JWK } from 'jose';
import type { Env } from '../../types';

/**
 * Status List Credential response format
 */
interface StatusListCredentialPayload {
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
async function getStatusList(env: Env, listId: string): Promise<StatusListData | null> {
  const db = env.DB;
  if (!db) {
    return null;
  }

  const result = await db
    .prepare(
      'SELECT id, tenant_id, purpose, encoded_list, updated_at FROM status_lists WHERE id = ?'
    )
    .bind(listId)
    .first<StatusListData>();

  return result;
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
  const keyManagerId = env.KEY_MANAGER.idFromName('default');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Get active EC key for signing
  const keyResponse = await keyManager.fetch(new Request('https://internal/active-ec-key'));
  if (!keyResponse.ok) {
    throw new Error('Failed to get signing key');
  }

  const keyData = (await keyResponse.json()) as {
    kid: string;
    privateKeyJwk: JWK;
    publicKeyJwk: JWK;
    algorithm: string;
  };

  // Import private key (JWK type from jose is compatible with Web Crypto's JsonWebKey)
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    keyData.privateKeyJwk as unknown as globalThis.JsonWebKey,
    { name: 'ECDSA', namedCurve: (keyData.privateKeyJwk.crv as string) || 'P-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const statusListUri = `${issuerUrl}/vci/status/${listData.id}`;

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

  // Create JWT header
  const header = {
    alg: keyData.algorithm || 'ES256',
    typ: 'statuslist+jwt',
    kid: keyData.kid,
  };

  // Encode and sign
  const encodedHeader = btoa(JSON.stringify(header))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  // Convert signature to base64url
  const signatureArray = new Uint8Array(signature);
  const signatureBase64url = btoa(String.fromCharCode(...signatureArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${signingInput}.${signatureBase64url}`;
}

/**
 * GET /vci/status/:listId
 *
 * Returns a Status List Credential in JWT format.
 * Supports ETag-based caching for efficient status checks.
 */
export async function statusListRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
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

  // Get status list from database
  const listData = await getStatusList(c.env, listId);

  if (!listData) {
    return c.json(
      {
        error: 'not_found',
        error_description: `Status list not found: ${listId}`,
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

  // Determine issuer URL from environment
  // SECURITY: Never trust Host header - always use configured ISSUER_IDENTIFIER
  const issuerUrl = c.env.ISSUER_IDENTIFIER;
  if (!issuerUrl) {
    console.error('[status-list] ISSUER_IDENTIFIER is not configured');
    return c.json(
      { error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable' },
      503
    );
  }

  try {
    // Generate JWT credential
    const jwt = await generateStatusListCredentialJWT(c.env, listData, issuerUrl);

    return c.text(jwt, 200, {
      'Content-Type': 'application/statuslist+jwt',
      'Cache-Control': 'public, max-age=300',
      ETag: etag,
    });
  } catch (err) {
    console.error('[status-list] Error generating credential:', err);
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
 * GET /vci/status/:listId/json
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

  const listData = await getStatusList(c.env, listId);

  if (!listData) {
    return c.json(
      {
        error: 'not_found',
        error_description: `Status list not found: ${listId}`,
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
