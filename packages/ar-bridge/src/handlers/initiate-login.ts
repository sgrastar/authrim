/**
 * OpenID Connect Core 1.0 Third-Party Initiated Login endpoint.
 *
 * The endpoint validates the initiating OP issuer and translates the request
 * into Authrim's existing external-provider start flow. Authrim-specific
 * parameters embedded in the registered initiate_login_uri bind the request to
 * a downstream client and its registered redirect URI.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildIssuerUrl, getTenantIdFromContext } from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';

const FORWARDED_PARAMETERS = [
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'prompt',
  'max_age',
  'acr_values',
] as const;

export interface ThirdPartyInitiatedLoginRequest {
  iss?: string;
  loginHint?: string;
  targetLinkUri?: string;
  parameters: URLSearchParams;
}

function firstNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function validateThirdPartyInitiatedIssuer(
  requestedIssuer: string | undefined,
  configuredIssuer: string | undefined
): string | undefined {
  if (!requestedIssuer) return 'iss is required';

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(requestedIssuer);
  } catch {
    return 'iss must be a valid URL';
  }
  if (issuerUrl.protocol !== 'https:') return 'iss must use https';
  if (issuerUrl.username || issuerUrl.password || issuerUrl.hash) {
    return 'iss must be an issuer URL without userinfo or fragment';
  }
  if (!configuredIssuer || requestedIssuer !== configuredIssuer) {
    return 'iss does not match the configured provider issuer';
  }
  return undefined;
}

export function buildExternalStartUrl(
  issuerBaseUrl: string,
  providerIdentifier: string,
  request: ThirdPartyInitiatedLoginRequest
): URL {
  const startUrl = new URL(
    `/auth/external/${encodeURIComponent(providerIdentifier)}/start`,
    issuerBaseUrl
  );
  for (const parameter of FORWARDED_PARAMETERS) {
    const value = request.parameters.get(parameter);
    if (value !== null) startUrl.searchParams.set(parameter, value);
  }
  if (request.targetLinkUri) {
    startUrl.searchParams.set('redirect_uri', request.targetLinkUri);
  }
  if (request.loginHint) {
    startUrl.searchParams.set('login_hint', request.loginHint);
  }
  return startUrl;
}

async function parseRequest(
  c: Context<{ Bindings: Env }>
): Promise<ThirdPartyInitiatedLoginRequest> {
  const parameters = new URL(c.req.url).searchParams;
  if (c.req.method === 'POST') {
    const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/x-www-form-urlencoded')) {
      throw new TypeError('POST requests must use application/x-www-form-urlencoded');
    }
    const form = await c.req.formData();
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') parameters.set(name, value);
    }
  }

  return {
    iss: firstNonEmpty(parameters.get('iss')),
    loginHint: firstNonEmpty(parameters.get('login_hint')),
    targetLinkUri: firstNonEmpty(parameters.get('target_link_uri')),
    parameters,
  };
}

export async function handleThirdPartyInitiatedLogin(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  let request: ThirdPartyInitiatedLoginRequest;
  try {
    request = await parseRequest(c);
  } catch (error) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: error instanceof Error ? error.message : 'Invalid request',
      },
      400
    );
  }

  const providerIdOrSlug = c.req.param('provider');
  if (!providerIdOrSlug) {
    return c.json({ error: 'invalid_request', error_description: 'Missing provider' }, 400);
  }
  const tenantId = getTenantIdFromContext(c);
  const provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
  if (!provider || !provider.enabled) {
    return c.json(
      { error: 'invalid_request', error_description: 'Unknown or disabled provider' },
      404
    );
  }

  const issuerError = validateThirdPartyInitiatedIssuer(request.iss, provider.issuer);
  if (issuerError) {
    return c.json({ error: 'invalid_request', error_description: issuerError }, 400);
  }

  const clientId = request.parameters.get('client_id');
  const codeChallenge = request.parameters.get('code_challenge');
  if (!clientId || !codeChallenge || request.parameters.get('code_challenge_method') !== 'S256') {
    return c.json(
      {
        error: 'invalid_request',
        error_description:
          'The registered initiate_login_uri must bind an Authrim client_id and PKCE S256 challenge',
      },
      400
    );
  }

  const providerIdentifier = provider.slug || provider.id;
  const location = buildExternalStartUrl(
    buildIssuerUrl(c.env, tenantId),
    providerIdentifier,
    request
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: location.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
