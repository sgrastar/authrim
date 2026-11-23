/**
 * Issuer Metadata Routes
 *
 * Credential Issuer metadata and the RFC 8414 metadata of the pre-authorized Authorization
 * Server that ar-vc runs at `<issuer>/vci`. The OIDC/FAPI discovery documents served by
 * ar-discovery are not involved.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-12.2
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import { getTenantIdFromContext, loadWalletAllowlist } from '@authrim/ar-lib-core';
import type { Env as CoreEnv } from '@authrim/ar-lib-core';
import { getRequestIssuerUrl } from '../../request-identifiers';
import {
  listCredentialConfigurations,
  toCredentialConfigurationMetadata,
} from '../credential-configurations';

export const PRE_AUTHORIZED_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

/** Identifier of the pre-authorized Authorization Server for a Credential Issuer. */
export function getVciAuthorizationServer(credentialIssuer: string): string {
  return `${credentialIssuer}/vci`;
}

/**
 * GET /.well-known/openid-credential-issuer
 */
export async function issuerMetadataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const baseUrl = getRequestIssuerUrl(c);

  // The Authrim OP is a second authorization server (authorization code flow with PAR and DPoP,
  // clients authenticated by wallet attestation) once the tenant has allowlisted a wallet. It
  // comes after the pre-authorized one, which wallets that read the first entry keep using.
  let opEnabled = false;
  try {
    opEnabled = (
      await loadWalletAllowlist(c.env as unknown as CoreEnv, getTenantIdFromContext(c as never))
    ).entries.some((entry) => entry.enabled && entry.keyAttestationRoots.length > 0);
  } catch {
    // An unreadable allowlist accepts no wallet, so the OP is not advertised.
  }

  const metadata = {
    credential_issuer: baseUrl,
    authorization_servers: opEnabled
      ? [getVciAuthorizationServer(baseUrl), baseUrl]
      : [getVciAuthorizationServer(baseUrl)],
    credential_endpoint: `${baseUrl}/vci/credential`,
    nonce_endpoint: `${baseUrl}/vci/nonce`,
    deferred_credential_endpoint: `${baseUrl}/vci/deferred`,
    display: [{ name: 'Authrim', locale: 'en' }],
    credential_configurations_supported: Object.fromEntries(
      listCredentialConfigurations().map((configuration) => [
        configuration.id,
        toCredentialConfigurationMetadata(configuration, { haip: opEnabled }),
      ])
    ),
  };

  return c.json(metadata);
}

/**
 * GET /.well-known/oauth-authorization-server/vci
 *
 * Pre-authorized-only AS: no authorization endpoint, so `response_types_supported` is omitted
 * (RFC 8414 §3.2 forbids empty arrays; OpenID4VCI §12.2.4 allows the omission).
 */
export async function vciAuthorizationServerMetadataRoute(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const baseUrl = getRequestIssuerUrl(c);
  return c.json({
    issuer: getVciAuthorizationServer(baseUrl),
    token_endpoint: `${baseUrl}/vci/token`,
    grant_types_supported: [PRE_AUTHORIZED_CODE_GRANT],
    token_endpoint_auth_methods_supported: ['none'],
    'pre-authorized_grant_anonymous_access_supported': true,
  });
}
