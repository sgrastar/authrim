import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT, type JWK } from 'jose';
import { resolvePhase1Secret, type Phase1HarnessConfig } from './schemas.js';

export interface Phase1AdminTokenProvider {
  getToken(): Promise<string>;
}

interface MachineTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

function decodePrivateJwk(encoded: string): JWK {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('phase1_admin_machine_private_jwk_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('phase1_admin_machine_private_jwk_invalid');
  }
  const jwk = value as JWK;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    throw new Error('phase1_admin_machine_private_jwk_invalid');
  }
  return jwk;
}

export function createPhase1AdminTokenProvider(input: {
  config: Phase1HarnessConfig;
  environment: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  nowMs?: () => number;
}): Phase1AdminTokenProvider {
  const credentials = input.config.credentials;
  const clientIdEnv = credentials.adminMachineClientIdEnv;
  const kidEnv = credentials.adminMachineKidEnv;
  const privateJwkEnv = credentials.adminMachinePrivateJwkBase64Env;
  if (!clientIdEnv || !kidEnv || !privateJwkEnv) {
    if (!credentials.adminTokenEnv) throw new Error('phase1_admin_auth_configuration_invalid');
    const token = resolvePhase1Secret(input.environment, credentials.adminTokenEnv);
    return { getToken: async () => token };
  }

  const clientId = resolvePhase1Secret(input.environment, clientIdEnv);
  const kid = resolvePhase1Secret(input.environment, kidEnv);
  const privateJwk = decodePrivateJwk(resolvePhase1Secret(input.environment, privateJwkEnv));
  const tokenEndpoint = new URL('/token', input.config.environment.baseUrl).toString();
  const fetcher = input.fetcher ?? fetch;
  const nowMs = input.nowMs ?? Date.now;
  let cached: { token: string; refreshAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  const issue = async (): Promise<string> => {
    const nowSeconds = Math.floor(nowMs() / 1_000);
    const key = await importJWK(privateJwk, 'ES256');
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(tokenEndpoint)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 60)
      .setJti(randomUUID())
      .sign(key);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      audience: 'authrim:admin-api',
      scope: 'admin:users:read admin:users:write',
    });
    const response = await fetcher(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Tenant-Id': input.config.environment.tenantId,
      },
      body: body.toString(),
      redirect: 'error',
    });
    const payload = (await response.json().catch(() => ({}))) as MachineTokenResponse;
    if (
      !response.ok ||
      typeof payload.access_token !== 'string' ||
      !Number.isSafeInteger(payload.expires_in) ||
      Number(payload.expires_in) <= 0
    ) {
      const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`;
      throw new Error(`phase1_admin_machine_token_failed:${code}`);
    }
    const ttlMs = Number(payload.expires_in) * 1_000;
    cached = {
      token: payload.access_token,
      refreshAtMs: nowMs() + Math.max(1_000, ttlMs - 60_000),
    };
    return cached.token;
  };

  return {
    async getToken(): Promise<string> {
      if (cached && nowMs() < cached.refreshAtMs) return cached.token;
      pending ??= issue().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
