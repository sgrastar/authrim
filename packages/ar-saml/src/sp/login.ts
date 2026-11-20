/**
 * SAML SP Login Initiation Endpoint
 *
 * Starts SP-initiated SSO by generating an AuthnRequest and redirecting to IdP.
 * GET /saml/sp/login?idp=<idp_id>
 */

import {
  isUsableInvitationToken,
  reserveExternalSignupInvitation,
  type ExternalSignupInvitation,
} from '@authrim/ar-lib-core/services/external-signup-invitation';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { consumeLiteSamlStart } from './lite-start';
import type { SAMLIdPConfig, SAMLRequestContext } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildIssuerUrl,
  buildSAMLRequestStoreInstanceName,
  getLogger,
  readAuthorizationChallengeKind,
  readExternalProviderReauthPolicy,
  readExternalProviderUsagePolicy,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveSignInAttemptInteraction,
  assertInteractionAnswersChallenge,
  isInteractionChallengeMismatchError,
  resolveSamlRequestTtlSeconds,
  verifyHumanVerificationWithRunner,
} from '@authrim/ar-lib-core';
import * as pako from 'pako';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import { SAML_NAMESPACES, BINDING_URIS, NAMEID_FORMATS } from '../common/constants';
import {
  createDocument,
  createElement,
  setAttribute,
  setTextContent,
  appendChild,
  addNamespaceDeclarations,
  serializeXml,
  generateSAMLId,
  nowAsDateTime,
  base64Encode,
  base64EncodeBytes,
} from '../common/xml-utils';
import { signRedirectBinding } from '../common/signature';
import { getSAMLSigningMaterial, getSAMLSigningPolicy } from '../common/saml-signing-keys';
import {
  getFederationSourceForLogin,
  getIdPConfig,
  listIdPConfigs,
  resolveFederationIdPForLogin,
} from '../admin/providers';
import { samlUsageUnavailableResponse } from './usage-gate';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize } from '../common/relay-state';
import {
  buildSAMLRequestBindingClearCookie,
  buildSAMLRequestBindingCookie,
  hasSAMLRequestBrowserBinding,
} from './request-browser-binding';

function remoteIp(c: Context<{ Bindings: Env }>): string | undefined {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    undefined
  );
}

/**
 * What a SAML start is for, as the start was asked: `signup` only when asked for exactly that,
 * anything else a sign-in. It decides only which switch the start checks: the ACS checks what the
 * sign-in then does (sign in to an existing account, create one) against that use's own switch.
 */
export function samlStartPurpose(value: unknown): 'login' | 'signup' {
  return value === 'signup' ? 'signup' : 'login';
}

async function verifySPLoginHumanVerification(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  usage: 'login' | 'signup'
): Promise<Response | null> {
  try {
    const result = await verifyHumanVerificationWithRunner(c.env, {
      tenantId,
      // The screen the start was asked from: its token was made for it. A sign-up that finds the
      // account signs in to it, so the sign-in's requirement holds for it too.
      action: usage,
      ...(usage === 'signup' ? { alsoRequiredFor: ['login'] as const } : {}),
      responseToken:
        c.req.query('human_verification_response') ?? c.req.query('cf_turnstile_response'),
      remoteIp: remoteIp(c),
    });
    if (result.verified) return null;
  } catch {
    // Provider, configuration, and Runner failures share the same public denial.
  }

  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field: 'human_verification_response' },
  });
}

/**
 * Handle SP login initiation
 */
/** How much longer than the request itself an invitation reservation lasts (the ACS round trip). */
const SAML_INVITATION_RESERVATION_MARGIN_SECONDS = 60;

/**
 * What a federation start hands on to the institution picker (our own Login UI): the screen's own
 * parameters, bounded. The human-verification token among them is checked, and spent, by the
 * start that follows the pick.
 */
const FEDERATION_PICKER_PARAMS = [
  'return_url',
  'purpose',
  'invite_token',
  'runtime_interaction_id',
  'authorization_challenge_id',
  'human_verification_response',
  'cf_turnstile_response',
] as const;
/** What a start that goes out to an external Discovery Service keeps for its return (server-side). */
const FEDERATION_START_PARAMS = [
  'return_url',
  'purpose',
  'invite_token',
  'runtime_interaction_id',
  'authorization_challenge_id',
] as const;
const FEDERATION_SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const FEDERATION_STATE_ID_PATTERN = /^_[0-9a-f]{32}$/u;
const FEDERATION_ENTITY_ID_MAX_LENGTH = 1024;
const FEDERATION_PARAM_MAX_LENGTH = 2048;

function federationParams(
  c: Context<{ Bindings: Env }>,
  names: readonly string[]
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of names) {
    const value = c.req.query(name);
    if (value) params[name] = value.slice(0, FEDERATION_PARAM_MAX_LENGTH);
  }
  return params;
}

/** The store instance a Discovery Service start waits in: one per source, apart from real IdPs. */
function federationStartStoreKey(sourceId: string): string {
  return `urn:authrim:federation-start:${sourceId}`;
}

function newFederationStateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function consumeFederationStart(
  env: Env,
  tenantId: string,
  sourceId: string,
  stateId: string
): Promise<Record<string, string> | null> {
  try {
    const store = env.SAML_REQUEST_STORE.get(
      env.SAML_REQUEST_STORE.idFromName(
        buildSAMLRequestStoreInstanceName(tenantId, 'sp', federationStartStoreKey(sourceId))
      )
    );
    const response = await store.fetch(`https://saml-request-store/consume/${stateId}`, {
      method: 'POST',
    });
    if (!response.ok) return null;
    const stored = await response.json<{ context?: SAMLRequestContext }>();
    return stored.context?.federationStart?.params ?? null;
  } catch {
    return null;
  }
}

/**
 * A start that came back from a Discovery Service spends its state (`fs`) and is done with the
 * cookie that bound it to this browser, whatever the start then answers. The cookie goes on the
 * response itself: setting it on the context would replace the cookies the response sets (the
 * AuthnRequest's) when the framework merges the two.
 */
export async function handleSPLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const response = await startSPLogin(c);
  const stateId = c.req.query('fs');
  if (stateId === undefined || !FEDERATION_STATE_ID_PATTERN.test(stateId)) return response;
  const clear = buildSAMLRequestBindingClearCookie(stateId);
  try {
    response.headers.append('Set-Cookie', clear);
    return response;
  } catch {
    // Headers that cannot be changed (a response taken from a fetch): answer with a copy.
    const copy = new Response(response.body, response);
    copy.headers.append('Set-Cookie', clear);
    return copy;
  }
}

async function startSPLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-SP');

  try {
    // Get IdP ID from query parameter
    const requestedIdpId = c.req.query('idp');
    // A start through a federation source: `federation` names the source, `entityID` the IdP the
    // user picked from its inventory. Without `entityID` this is only the hop to the picker (or
    // to the source's Discovery Service), which starts nothing. `fs` is the state a start that
    // went out to a Discovery Service waits in; it comes back with the Discovery Service's answer.
    const federationId = c.req.query('federation');
    const federationEntityId = c.req.query('entityID');
    const federationStateId = c.req.query('fs');
    if (
      (federationId !== undefined && requestedIdpId !== undefined) ||
      (federationId !== undefined && !FEDERATION_SOURCE_ID_PATTERN.test(federationId)) ||
      (federationId === undefined && federationEntityId !== undefined) ||
      (federationEntityId !== undefined &&
        (!federationEntityId || federationEntityId.length > FEDERATION_ENTITY_ID_MAX_LENGTH)) ||
      (federationStateId !== undefined &&
        (federationEntityId === undefined || !FEDERATION_STATE_ID_PATTERN.test(federationStateId)))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: federationId === undefined ? 'entityID' : 'federation' },
      });
    }
    const federationHop = federationId !== undefined && federationEntityId === undefined;
    const tenantId = resolveSAMLTenantIdFromContext(c);
    // A tenant in lite mode starts SAML sign-in only from the lite Login UI: by the one-time start
    // grant ar-auth made for this browser's transaction after the page's proof of work. It is
    // consumed before anything else; the start then takes nothing from its query.
    const lite = await consumeLiteSamlStart(c, tenantId, requestedIdpId);
    if (lite && !lite.ok) return lite.response;
    // The start a Discovery Service returned the user to: what the user's screen sent was kept
    // server-side (nothing of it, not the human-verification token, went to the Discovery
    // Service), verified when it was kept, and is used up here, from the browser it was kept for.
    let federationStart: Record<string, string> | null = null;
    if (federationStateId && federationId) {
      if (!hasSAMLRequestBrowserBinding(c.req.header('Cookie'), federationStateId)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'fs' },
        });
      }
      federationStart = await consumeFederationStart(
        env,
        tenantId,
        federationId,
        federationStateId
      );
      if (!federationStart) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'fs' },
        });
      }
    }
    const query = (name: string): string | undefined =>
      lite ? undefined : federationStart ? federationStart[name] : c.req.query(name);
    // What the sign-in is for: a lite start's is its transaction's (server-bound), any other's
    // the one its screen asked for (its human verification token was made for that screen). A
    // re-authentication keeps its own switch, whatever it was asked for.
    const requestedPurpose = samlStartPurpose(lite ? lite.txn.bound.purpose : query('purpose'));
    // Human verification is checked once, by the step that starts something: an ordinary start
    // here; a federation start once the IdP is chosen (below); a start out to a Discovery Service
    // at that hop. A lite start's proof of work was verified (and spent) when its grant was made,
    // and a start a Discovery Service returned was verified when it was kept.
    if (!lite && federationId === undefined) {
      const turnstileError = await verifySPLoginHumanVerification(c, tenantId, requestedPurpose);
      if (turnstileError) return turnstileError;
    }
    const { issuerUrl, spEntityId } = await getSAMLLocalEntityIds(env, tenantId);

    // Determine return URL with UI config fallback. Only local Authrim/Login UI origins are accepted.
    const requestedReturnUrl = query('return_url');
    const uiConfig = await getUIConfig(env, tenantId);
    const defaultReturnUrl = uiConfig?.baseUrl ? `${uiConfig.baseUrl}/` : `${issuerUrl}/`;
    const returnUrl = lite
      ? lite.returnUrl
      : (resolveSafeReturnUrl(env, tenantId, requestedReturnUrl) ?? defaultReturnUrl);

    // The federation hop: send the user to pick an IdP of the source, and nothing else happens.
    if (federationHop && federationId) {
      const source = await getFederationSourceForLogin(env, tenantId, federationId);
      if (!source) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      if (source.idpSelection.mode === 'external_ds' && source.idpSelection.discoveryServiceUrl) {
        // SAML IdP Discovery Protocol: the Discovery Service answers by redirecting back with the
        // chosen entityID in `entityID`. Its address is the stored one, never the request's.
        // The user's screen parameters and the human-verification token must not reach an
        // external party: the token is checked and spent here, the rest is kept server-side
        // under an opaque id, and the id comes back only for this browser (a cookie).
        const turnstileError = await verifySPLoginHumanVerification(c, tenantId, requestedPurpose);
        if (turnstileError) return turnstileError;
        const stateId = newFederationStateId();
        const ttlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);
        await storeAuthnRequest(
          env,
          tenantId,
          stateId,
          spEntityId,
          federationStartStoreKey(federationId),
          '',
          ttlSeconds,
          { federationStart: { params: federationParams(c, FEDERATION_START_PARAMS) } }
        );
        const returnTarget = new URL('/saml/sp/login', issuerUrl);
        returnTarget.searchParams.set('federation', federationId);
        returnTarget.searchParams.set('fs', stateId);
        const discovery = new URL(source.idpSelection.discoveryServiceUrl);
        discovery.searchParams.set('entityID', spEntityId);
        discovery.searchParams.set('return', returnTarget.toString());
        discovery.searchParams.set('returnIDParam', 'entityID');
        if (c.req.query('is_passive') === '1') discovery.searchParams.set('isPassive', 'true');
        const response = c.redirect(discovery.toString(), 302);
        response.headers.append('Set-Cookie', buildSAMLRequestBindingCookie(stateId, ttlSeconds));
        return response;
      }
      // On the issuer's own host (which serves the Login UI), like the start that follows the
      // pick: the browser-bound cookies and the tenant are those of that host.
      const picker = new URL(`/login/federation/${encodeURIComponent(federationId)}`, issuerUrl);
      for (const [name, value] of Object.entries(federationParams(c, FEDERATION_PICKER_PARAMS))) {
        picker.searchParams.set(name, value);
      }
      return c.redirect(picker.toString(), 302);
    }

    // A federation start with an IdP chosen: only an IdP of this source's inventory. An approved
    // explicit provider with the same entityID takes the start over, here (an ordinary start of
    // that provider, whose switches and re-authentication rules then apply).
    let federationLogin: { sourceId: string; config: SAMLIdPConfig } | undefined;
    let explicitProviderId: string | undefined;
    if (federationId && federationEntityId) {
      const source = await getFederationSourceForLogin(env, tenantId, federationId);
      if (!source) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      const resolved = await resolveFederationIdPForLogin(
        env,
        tenantId,
        federationId,
        federationEntityId
      );
      if (!resolved) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      if (resolved.kind === 'explicit') explicitProviderId = resolved.providerId;
      else federationLogin = { sourceId: federationId, config: resolved.config };
      // The IdP is chosen: this is the start, so human verification is checked here (once; a
      // start that came back from a Discovery Service was verified when it went out).
      if (!lite && !federationStart) {
        const turnstileError = await verifySPLoginHumanVerification(c, tenantId, requestedPurpose);
        if (turnstileError) return turnstileError;
      }
    }
    const idpId = requestedIdpId ?? explicitProviderId;

    if (!idpId && !federationLogin) {
      // Return list of available IdPs if no IdP specified
      const idps = await listIdPConfigs(env, tenantId);
      return c.html(
        buildIdPSelectionPage(
          issuerUrl,
          idps,
          returnUrl,
          query('authorization_challenge_id') || undefined,
          query('invite_token'),
          query('runtime_interaction_id'),
          requestedPurpose
        )
      );
    }

    // Get IdP configuration
    const idpConfig = federationLogin
      ? federationLogin.config
      : idpId
        ? await getIdPConfig(env, tenantId, idpId)
        : null;
    if (!idpConfig) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const outboundIdpConfig = withSPInitiatedSsoEndpoint(idpConfig);

    // A sign-in that answers an Authrim re-authentication asks the IdP for a new login
    // (ForceAuthn), and only an IdP the tenant lets re-authenticate is asked.
    let reauthentication: SAMLRequestContext['spReauthentication'];
    const authorizationChallengeId = lite
      ? (lite.txn.bound.challengeId ?? undefined)
      : query('authorization_challenge_id');
    if (authorizationChallengeId) {
      const challengeKind = await readAuthorizationChallengeKind(
        env,
        tenantId,
        authorizationChallengeId
      );
      if (!challengeKind) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'authorization_challenge_id' },
        });
      }
      if (challengeKind === 'reauth') {
        // A lite grant is made only for a sign-in challenge (re-authentication is not lite yet).
        if (lite) {
          return c.json(
            {
              error: 'lite_mode_endpoint_unavailable',
              error_description: 'This tenant starts SAML sign-in from the lite Login UI',
            },
            403
          );
        }
        // A re-authentication asks one known IdP for a new login; a federation start has not
        // chosen one in advance, so it takes no part in it.
        if (!idpId) return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
        const providerIds = [`saml:${idpId}`, idpId];
        const policy = await readExternalProviderReauthPolicy(env, tenantId, {
          providerId: idpId,
          ids: providerIds,
        });
        if (!policy.reauthEnabled) {
          return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
        }
        reauthentication = {
          authorizationChallengeId,
          requestedAt: Date.now(),
          providerId: idpId,
          providerIds,
        };
      }
    }

    // A sign-in starts only with an IdP the tenant lets sign people in, a sign-up only with one
    // it lets sign people up (the screens merely hide the others). A re-authentication has its own
    // switch, checked above.
    if (!reauthentication) {
      let usageEnabled: boolean;
      try {
        // A federation start files its switches under the source (the IdP has no record of its
        // own); defaults are on, as for any IdP without saved switches.
        const usageId = federationLogin ? federationLogin.sourceId : idpId;
        const policy = await readExternalProviderUsagePolicy(env, tenantId, {
          providerId: usageId ?? '',
          ids: federationLogin
            ? [`saml-federation:${federationLogin.sourceId}`, federationLogin.sourceId]
            : [`saml:${idpId}`, idpId ?? ''],
        });
        usageEnabled = requestedPurpose === 'signup' ? policy.signupEnabled : policy.loginEnabled;
      } catch (error) {
        log.warn(
          'SAML IdP usage settings could not be read; refusing the sign-in',
          {},
          error as Error
        );
        return samlUsageUnavailableResponse(c);
      }
      if (!usageEnabled) return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
    }

    // Generate AuthnRequest
    const authnRequestXml = buildAuthnRequest(issuerUrl, spEntityId, outboundIdpConfig, {
      forceAuthn: reauthentication !== undefined,
    });

    // Store request in SAMLRequestStore for later validation
    const requestTtlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);
    const requestId = authnRequestXml.match(/ID="([^"]+)"/)?.[1] || '';
    if (!requestId) {
      throw new Error('Generated SAML AuthnRequest is missing ID');
    }
    // A sign-in started from an invitation reserves one use now, held by this request for as
    // long as the IdP may take to answer it, so the ACS can apply it to the account it creates.
    // A re-authentication creates no account, so it carries no invitation.
    // A lite start's invitation is the one its sign-up's transaction keeps (its grant carries it).
    const inviteToken = lite ? (lite.start.inviteToken ?? undefined) : query('invite_token');
    let invitation: ExternalSignupInvitation | null = null;
    if (inviteToken !== undefined && !reauthentication) {
      if (!isUsableInvitationToken(inviteToken)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'invite_token' },
        });
      }
      invitation = await reserveExternalSignupInvitation(
        await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-invitation', { tenantId }),
        {
          token: inviteToken,
          tenantId,
          holder: `saml:${requestId}`,
          ttlSeconds: requestTtlSeconds + SAML_INVITATION_RESERVATION_MARGIN_SECONDS,
        }
      );
      if (!invitation) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
    }
    // The Flow interaction this sign-in belongs to, once checked a live interaction of the tenant:
    // the ACS records the sign-in's failures with it.
    const requestedInteractionId = lite
      ? (lite.start.interactionId ?? undefined)
      : query('runtime_interaction_id');
    // Its Flow's profiles also hold the sign-in (methods, session): a check that cannot be made
    // refuses the start; one that is not a live interaction of the tenant is left out.
    let attemptInteractionId: string | null = null;
    if (requestedInteractionId) {
      try {
        attemptInteractionId = await resolveSignInAttemptInteraction(
          await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-sign-in-attempt', {
            tenantId,
          }),
          { tenantId, interactionId: requestedInteractionId }
        );
      } catch {
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'The sign-in flow is unavailable.',
          },
          503
        );
      }
    }
    // A sign-in that answers an authorization request may only name an interaction started for
    // it (another request's Flow would lend it its methods and session).
    if (attemptInteractionId && authorizationChallengeId) {
      try {
        await assertInteractionAnswersChallenge(
          await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-sign-in-attempt', {
            tenantId,
          }),
          tenantId,
          attemptInteractionId,
          authorizationChallengeId
        );
      } catch (error) {
        if (isInteractionChallengeMismatchError(error)) {
          return c.json(
            {
              error: 'authorization_challenge_mismatch',
              error_description: 'The sign-in was not started for this authorization request.',
            },
            403
          );
        }
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'The sign-in flow is unavailable.',
          },
          503
        );
      }
    }
    const requestContext: SAMLRequestContext | undefined =
      reauthentication ||
      invitation ||
      attemptInteractionId ||
      authorizationChallengeId ||
      federationLogin ||
      lite
        ? {
            ...(reauthentication ? { spReauthentication: reauthentication } : {}),
            ...(invitation ? { invitation } : {}),
            ...(attemptInteractionId ? { attemptInteractionId } : {}),
            ...(authorizationChallengeId ? { flowChallengeId: authorizationChallengeId } : {}),
            ...(federationLogin ? { federationSourceId: federationLogin.sourceId } : {}),
            ...(lite ? { liteReturn: lite.returnUrl, liteClientId: lite.start.clientId } : {}),
          }
        : undefined;
    await storeAuthnRequest(
      env,
      tenantId,
      requestId,
      spEntityId,
      outboundIdpConfig.entityId,
      returnUrl,
      requestTtlSeconds,
      requestContext
    );

    // RelayState is limited by the SAML bindings; use the opaque request ID, not the return URL.
    const relayState = requestId;
    assertSAMLRelayStateSize(relayState);

    // Redirect to IdP based on preferred binding
    const response = outboundIdpConfig.allowedBindings.includes('redirect')
      ? await redirectToIdP(c, env, outboundIdpConfig, authnRequestXml, relayState)
      : postToIdP(outboundIdpConfig, authnRequestXml, relayState);
    response.headers.append(
      'Set-Cookie',
      buildSAMLRequestBindingCookie(requestId, requestTtlSeconds)
    );
    return response;
  } catch (error) {
    log.error('SP Login Error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function deriveRedirectSsoUrl(ssoUrl: string): string | null {
  try {
    const url = new URL(ssoUrl);
    if (!/\/POST\/SSO\/?$/iu.test(url.pathname)) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/POST\/SSO\/?$/iu, '/Redirect/SSO');
    return url.toString();
  } catch {
    return null;
  }
}

function withSPInitiatedSsoEndpoint(idpConfig: SAMLIdPConfig): SAMLIdPConfig {
  if (!idpConfig.allowedBindings.includes('redirect')) {
    return idpConfig;
  }

  const redirectSsoUrl = deriveRedirectSsoUrl(idpConfig.ssoUrl);
  if (!redirectSsoUrl) {
    return idpConfig;
  }

  return {
    ...idpConfig,
    ssoUrl: redirectSsoUrl,
  };
}

/**
 * Build SAML AuthnRequest
 */
function buildAuthnRequest(
  issuerUrl: string,
  spEntityId: string,
  idpConfig: SAMLIdPConfig,
  options: { forceAuthn?: boolean } = {}
): string {
  const acsUrl = `${issuerUrl}/saml/sp/acs`;
  const providerName = idpConfig.providerName?.trim() || 'Authrim';

  const doc = createDocument();

  // Create AuthnRequest element
  const authnRequest = createElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest', 'samlp');
  setAttribute(authnRequest, 'ID', generateSAMLId());
  setAttribute(authnRequest, 'Version', '2.0');
  setAttribute(authnRequest, 'IssueInstant', nowAsDateTime());
  setAttribute(authnRequest, 'Destination', idpConfig.ssoUrl);
  setAttribute(authnRequest, 'AssertionConsumerServiceURL', acsUrl);
  setAttribute(authnRequest, 'ProtocolBinding', BINDING_URIS.HTTP_POST);
  setAttribute(authnRequest, 'ProviderName', providerName);
  if (options.forceAuthn) setAttribute(authnRequest, 'ForceAuthn', 'true');

  // Add namespace declarations
  addNamespaceDeclarations(authnRequest, {
    samlp: SAML_NAMESPACES.SAML2P,
    saml: SAML_NAMESPACES.SAML2,
  });

  // Add Issuer
  const issuerElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
  setTextContent(issuerElement, spEntityId);
  appendChild(authnRequest, issuerElement);

  // Add NameIDPolicy
  const nameIdPolicy = createElement(doc, SAML_NAMESPACES.SAML2P, 'NameIDPolicy', 'samlp');
  setAttribute(nameIdPolicy, 'Format', idpConfig.nameIdFormat || NAMEID_FORMATS.EMAIL);
  setAttribute(nameIdPolicy, 'AllowCreate', 'true');
  appendChild(authnRequest, nameIdPolicy);

  // Append to document and serialize
  appendChild(doc, authnRequest);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}

/**
 * Store AuthnRequest for later validation
 */
async function storeAuthnRequest(
  env: Env,
  tenantId: string,
  requestId: string,
  spEntityId: string,
  idpEntityId: string,
  returnUrl: string,
  requestTtlSeconds: number,
  context?: SAMLRequestContext
): Promise<void> {
  const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(
    buildSAMLRequestStoreInstanceName(tenantId, 'sp', idpEntityId)
  );
  const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

  await samlRequestStore.fetch('https://saml-request-store/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      issuer: spEntityId,
      destination: idpEntityId,
      binding: 'post',
      type: 'authn_request',
      relayState: returnUrl,
      ...(context ? { context } : {}),
      expiresAt: Date.now() + requestTtlSeconds * 1000,
    }),
  });
}

/**
 * Redirect to IdP using HTTP-Redirect binding
 */
async function redirectToIdP(
  c: Context<{ Bindings: Env }>,
  env: Env,
  idpConfig: SAMLIdPConfig,
  authnRequestXml: string,
  relayState: string
): Promise<Response> {
  // Deflate and Base64 encode the request
  const deflated = pako.deflateRaw(authnRequestXml);
  const base64Encoded = base64EncodeBytes(deflated);

  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { privateKeyPem } = await getSAMLSigningMaterial(env, {
    tenantId,
    role: 'sp',
    counterpartyEntityId: idpConfig.entityId,
    policy: getSAMLSigningPolicy(idpConfig),
  });
  const { signedUrl } = await signRedirectBinding(
    'SAMLRequest',
    base64Encoded,
    relayState,
    privateKeyPem
  );
  return c.redirect(`${idpConfig.ssoUrl}?${signedUrl}`);
}

/**
 * POST to IdP using HTTP-POST binding
 */
function postToIdP(
  idpConfig: SAMLIdPConfig,
  authnRequestXml: string,
  relayState: string
): Response {
  assertSAMLRelayStateSize(relayState);
  // Base64 encode the request (no deflate for POST binding)
  const base64Encoded = base64Encode(authnRequestXml);

  return buildSAMLPostBindingResponse({
    title: 'SAML SSO - Redirecting...',
    actionUrl: idpConfig.ssoUrl,
    fields: [
      { name: 'SAMLRequest', value: base64Encoded },
      { name: 'RelayState', value: relayState },
    ],
    buttonText: 'Continue to Identity Provider',
  });
}

/**
 * Build IdP selection page
 */
function buildIdPSelectionPage(
  issuerUrl: string,
  idps: Array<{ id: string; name: string; entityId: string }>,
  returnUrl: string,
  authorizationChallengeId?: string,
  inviteToken?: string,
  runtimeInteractionId?: string,
  purpose: 'login' | 'signup' = 'login'
): string {
  // A choice answering an authorization challenge (a re-authentication) keeps answering it, a
  // sign-in started from an invitation keeps its invitation, and a sign-up stays one.
  const challenge =
    (authorizationChallengeId
      ? `&authorization_challenge_id=${encodeURIComponent(authorizationChallengeId)}`
      : '') +
    (isUsableInvitationToken(inviteToken)
      ? `&invite_token=${encodeURIComponent(inviteToken)}`
      : '') +
    (purpose === 'signup' ? '&purpose=signup' : '');
  // This is only an opaque navigation hint. The selected provider start checks its tenant,
  // live state and expiry before storing it with the AuthnRequest.
  const interactionId = runtimeInteractionId?.trim();
  const interaction =
    interactionId && /^[A-Za-z0-9_-]{1,128}$/u.test(interactionId)
      ? `&runtime_interaction_id=${encodeURIComponent(interactionId)}`
      : '';
  const idpLinks = idps
    .map(
      (idp) =>
        `<li><a href="${issuerUrl}/saml/sp/login?idp=${encodeURIComponent(idp.id)}&return_url=${encodeURIComponent(returnUrl)}${challenge}${interaction}">${escapeHtml(idp.name)}</a></li>`
    )
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Select Identity Provider</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    ul { list-style: none; padding: 0; }
    li { margin: 10px 0; }
    a { color: #0066cc; text-decoration: none; padding: 10px 15px; display: inline-block; border: 1px solid #ddd; border-radius: 5px; }
    a:hover { background: #f0f0f0; }
  </style>
</head>
<body>
  <h1>Select Identity Provider</h1>
  <p>Choose an identity provider to sign in with:</p>
  <ul>
    ${idpLinks || '<li>No identity providers configured.</li>'}
  </ul>
</body>
</html>
`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function resolveSafeReturnUrl(
  env: Env,
  tenantId: string,
  value: string | undefined
): string | null {
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const allowedOrigins = new Set(
    [
      getUrlOrigin(buildIssuerUrl(env, tenantId)),
      getUrlOrigin((env as unknown as Record<string, unknown>).UI_URL),
    ].filter((origin): origin is string => Boolean(origin))
  );

  return allowedOrigins.has(url.origin) ? url.toString() : null;
}

function getUrlOrigin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
