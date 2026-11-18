import { resolvePairwiseSector, type AdminStepUpLevel } from '@authrim/ar-lib-core';

/** Legacy enabled clients may keep incomplete settings until their trust changes. */
export function requiresClientConfigurationValidation(
  enabled: boolean,
  trustLevel: AdminStepUpLevel
): boolean {
  return enabled && trustLevel === 'L2';
}

function array(value: unknown, fallback: string[] = []): string[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : fallback;
}

/** Report all missing settings, independently of whether this write needs validation. */
export function clientEnableBlockers(client: object): string[] {
  const value = client as Record<string, unknown>;
  const missing = new Set<string>();
  const grants = array(value.grant_types, ['authorization_code']);
  const responses = array(value.response_types, ['code']);
  const redirects = array(value.redirect_uris);
  const method =
    typeof value.token_endpoint_auth_method === 'string'
      ? value.token_endpoint_auth_method
      : 'client_secret_basic';
  if (grants.some((g) => g === 'authorization_code' || g === 'implicit') && !redirects.length)
    missing.add('redirect_uris');
  if (!grants.length) missing.add('grant_types');
  if (
    grants.includes('implicit') &&
    !responses.some((r) => r.split(' ').some((p) => p === 'token' || p === 'id_token'))
  )
    missing.add('response_types');
  if (method === 'private_key_jwt' && !value.jwks && !value.jwks_uri) missing.add('jwks');
  if (method.startsWith('client_secret_') && !value.client_secret_hash)
    missing.add('client_secret');
  if (method === 'none' && grants.includes('authorization_code') && !value.require_pkce)
    missing.add('require_pkce');
  if (
    method === 'none' &&
    (grants.includes('client_credentials') ||
      grants.includes('urn:openid:params:grant-type:ciba') ||
      value.client_credentials_allowed)
  )
    missing.add('token_endpoint_auth_method');
  if (
    responses.some((r) => r.split(' ').includes('code')) &&
    !grants.includes('authorization_code')
  )
    missing.add('response_types');
  if (
    responses.some((r) => r.split(' ').some((p) => p === 'token' || p === 'id_token')) &&
    !grants.includes('implicit')
  )
    missing.add('response_types');
  if (
    grants.includes('authorization_code') &&
    !responses.some((r) => r.split(' ').includes('code'))
  )
    missing.add('response_types');
  if (
    value.subject_type === 'pairwise' &&
    !resolvePairwiseSector({
      sectorIdentifierUri: value.sector_identifier_uri as string | null,
      redirectUris: redirects,
    })
  )
    missing.add('sector_identifier_uri');
  if (
    grants.includes('urn:openid:params:grant-type:ciba') &&
    (value.backchannel_token_delivery_mode === 'ping' ||
      value.backchannel_token_delivery_mode === 'push') &&
    !value.backchannel_client_notification_endpoint
  )
    missing.add('backchannel_client_notification_endpoint');
  return [...missing];
}
