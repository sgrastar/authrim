import type * as jose from 'jose';
import type { ProviderMetadata, UpstreamProvider } from '../types';
import { decrypt } from '../utils/crypto';

export interface Fapi2ProviderQuirks {
  enabled?: boolean;
  clientAssertionPrivateJwkEncrypted?: string;
  dpopPrivateJwkEncrypted?: string;
  resourceUrl?: string;
  discoveryUrl?: string;
  profile?: 'oidc' | 'plain_oauth';
  messageSigning?: {
    requestObjectSigning?: boolean;
    jarm?: boolean;
    authorizationSignedResponseAlg?: 'ES256' | 'PS256';
  };
}

export interface Fapi2ProviderConfig {
  clientAssertionPrivateJwk: jose.JWK;
  dpopPrivateJwk: jose.JWK;
  resourceUrl?: string;
  discoveryUrl?: string;
  profile: 'oidc' | 'plain_oauth';
  requestObjectSigning: boolean;
  jarm: boolean;
  authorizationSignedResponseAlg: 'ES256' | 'PS256';
}

export function getFapi2ProviderQuirks(
  provider: UpstreamProvider
): Fapi2ProviderQuirks | undefined {
  const value = provider.providerQuirks?.fapi2;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fapi2ProviderQuirks)
    : undefined;
}

export function isFapi2Provider(provider: UpstreamProvider): boolean {
  return getFapi2ProviderQuirks(provider)?.enabled === true;
}

export function validateFapi2ProviderMetadata(
  metadata: ProviderMetadata,
  profile: Fapi2ProviderConfig['profile'],
  messageSigning?: Pick<
    Fapi2ProviderConfig,
    'requestObjectSigning' | 'jarm' | 'authorizationSignedResponseAlg'
  >
): void {
  if (!metadata.pushed_authorization_request_endpoint) {
    throw new Error('FAPI2 provider metadata has no pushed_authorization_request_endpoint');
  }
  if (metadata.require_pushed_authorization_requests !== true) {
    throw new Error('FAPI2 provider metadata does not require pushed authorization requests');
  }
  if (!metadata.token_endpoint_auth_methods_supported?.includes('private_key_jwt')) {
    throw new Error('FAPI2 provider metadata does not support private_key_jwt');
  }
  if (!metadata.token_endpoint_auth_signing_alg_values_supported?.includes('ES256')) {
    throw new Error('FAPI2 provider metadata does not support ES256 client assertions');
  }
  if (!metadata.dpop_signing_alg_values_supported?.includes('ES256')) {
    throw new Error('FAPI2 provider metadata does not support ES256 DPoP proofs');
  }
  if (
    profile === 'oidc' &&
    (!metadata.id_token_signing_alg_values_supported ||
      metadata.id_token_signing_alg_values_supported.length === 0)
  ) {
    throw new Error('FAPI2 OIDC provider metadata has no ID token signing algorithms');
  }
  if (
    messageSigning?.requestObjectSigning &&
    !metadata.request_object_signing_alg_values_supported?.includes('ES256')
  ) {
    throw new Error('FAPI2 Message Signing provider does not support ES256 request objects');
  }
  if (
    messageSigning?.jarm &&
    !metadata.authorization_signing_alg_values_supported?.includes(
      messageSigning.authorizationSignedResponseAlg
    )
  ) {
    throw new Error(
      'FAPI2 Message Signing provider does not support the configured JARM algorithm'
    );
  }
}

function parsePrivateSigningJwk(value: string, field: string): jose.JWK {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JWK object`);
  }
  const jwk = parsed as jose.JWK;
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    jwk.alg !== 'ES256' ||
    jwk.use !== 'sig' ||
    typeof jwk.kid !== 'string' ||
    jwk.kid.length === 0 ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    typeof jwk.d !== 'string'
  ) {
    throw new Error(`${field} must be a private EC P-256 ES256 signing JWK with kid`);
  }
  return jwk;
}

export async function loadFapi2ProviderConfig(
  provider: UpstreamProvider,
  encryptionKey: string
): Promise<Fapi2ProviderConfig> {
  const quirks = getFapi2ProviderQuirks(provider);
  if (quirks?.enabled !== true) throw new Error('FAPI2 is not enabled for this provider');
  if (typeof quirks.clientAssertionPrivateJwkEncrypted !== 'string') {
    throw new Error('FAPI2 client assertion key is not configured');
  }
  if (typeof quirks.dpopPrivateJwkEncrypted !== 'string') {
    throw new Error('FAPI2 DPoP key is not configured');
  }

  const [clientAssertionJson, dpopJson] = await Promise.all([
    decrypt(quirks.clientAssertionPrivateJwkEncrypted, encryptionKey),
    decrypt(quirks.dpopPrivateJwkEncrypted, encryptionKey),
  ]);
  const clientAssertionPrivateJwk = parsePrivateSigningJwk(
    clientAssertionJson,
    'FAPI2 client assertion key'
  );
  const dpopPrivateJwk = parsePrivateSigningJwk(dpopJson, 'FAPI2 DPoP key');
  if (
    clientAssertionPrivateJwk.kid === dpopPrivateJwk.kid ||
    (clientAssertionPrivateJwk.x === dpopPrivateJwk.x &&
      clientAssertionPrivateJwk.y === dpopPrivateJwk.y)
  ) {
    throw new Error('FAPI2 client assertion and DPoP keys must be distinct');
  }
  if (quirks.resourceUrl !== undefined) {
    const resource = new URL(quirks.resourceUrl);
    if (resource.protocol !== 'https:') throw new Error('FAPI2 resource URL must use HTTPS');
  }
  if (quirks.discoveryUrl !== undefined) {
    const discovery = new URL(quirks.discoveryUrl);
    if (discovery.protocol !== 'https:') throw new Error('FAPI2 discovery URL must use HTTPS');
  }
  return {
    clientAssertionPrivateJwk,
    dpopPrivateJwk,
    resourceUrl: quirks.resourceUrl,
    discoveryUrl: quirks.discoveryUrl,
    profile: quirks.profile === 'plain_oauth' ? 'plain_oauth' : 'oidc',
    requestObjectSigning: quirks.messageSigning?.requestObjectSigning === true,
    jarm: quirks.messageSigning?.jarm === true,
    authorizationSignedResponseAlg:
      quirks.messageSigning?.authorizationSignedResponseAlg === 'PS256' ? 'PS256' : 'ES256',
  };
}
