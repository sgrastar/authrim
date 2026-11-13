/**
 * IdP-Initiated SSO Endpoint
 *
 * Allows the IdP to initiate SSO without receiving an AuthnRequest from the SP.
 * GET /saml/idp/init?sp=<sp_entity_id>[&relay_state=...]
 *
 * The first request keeps a pending sign-in on the server (in the SAML request store, as an
 * SP-initiated AuthnRequest is kept): the SP, the RelayState and its own end. The person signs in
 * if they have to and answers the consent screen if it is asked, coming back with the pending
 * sign-in's ID (`pending`); it is answered once (completed before the response is sent), and
 * never through the SP-initiated endpoint.
 */

import type { Context } from 'hono';
import type { Env, SAMLAuthnRequest, SAMLRequestData } from '@authrim/ar-lib-core';
import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildUIUrl,
  createConfigurationError,
  usesNakedDomainIssuer,
  getLogger,
  resolveSamlAssertionTtlSeconds,
  resolveSamlRequestTtlSeconds,
  RuntimeIdentityMappingReleaseSafetyError,
} from '@authrim/ar-lib-core';
import { getSAMLInteractiveLoginUrlPolicy } from '../common/entity-id';
import { base64Encode, generateSAMLId } from '../common/xml-utils';
import { NAMEID_FORMATS, DEFAULTS } from '../common/constants';
import { buildSAMLResponse } from './assertion';
import { getSPConfig, listSPConfigs } from '../admin/providers';
import { getSamlUserInfoById } from '../common/user-store';
import { getSAMLIdPSigningMaterial } from '../common/idp-signing';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import { MissingRequiredSAMLAttributeError, SAMLIdentityMappingRuntimeError } from './attributes';
import { applySAMLResponseSigningPolicy } from './signing';
import {
  createSAMLSessionIndex,
  resolveSAMLNameIDValue,
  resolveSAMLPairwiseSecret,
  resolveSAMLPersistentNameIDRegistryStore,
  resolveSAMLTransientNameIDStore,
} from './subject';
import { buildSAMLAssertionTiming, resolveSAMLAuthnInstant } from './assertion-timing';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { SAMLAuthnContextPolicyError } from './authn-context';
import { chooseSAMLAuthnContextClassRef } from './authn-context-assurance';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize, SAMLRelayStateTooLargeError } from '../common/relay-state';
import { checkSAMLIdentityAssurance } from './identity-assurance';
import { checkSAMLAuthnAssurance } from './authn-assurance';
import { scheduleSAMLAttributeWithheldAudit, scheduleSAMLPolicyFailureAudit } from './audit';
import { checkUserAuthentication } from './sso';
import {
  completeStoredAuthnRequest,
  readStoredAuthnRequest,
  saveStoredAuthnRequest,
} from './sso-stored-request';
import { resolveSAMLReleaseConsent, samlReleaseConsentStillCurrent } from './release-consent';
import {
  applySAMLReleaseApproval,
  computeSAMLAttributeRelease,
  samlApprovalNeedsIdentifiers,
} from './release-items';

/** The ID a pending IdP-initiated sign-in is kept under (never an SP's AuthnRequest ID). */
const PENDING_ID =
  /^_idpinit_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function resumePathOf(spEntityId: string, pendingId: string): string {
  const params = new URLSearchParams({ sp: spEntityId, pending: pendingId });
  return `/saml/idp/init?${params.toString()}`;
}

/**
 * Handle IdP-initiated SSO
 */
export async function handleIdPInitiated(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-IDP');

  try {
    // Get SP entity ID from query parameter
    const spEntityId = c.req.query('sp');
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const { issuerUrl, idpEntityId } = await getSAMLLocalEntityIds(env, tenantId);

    if (!spEntityId) {
      // Return list of available SPs if no SP specified
      const sps = await listSPConfigs(env, tenantId);
      return c.html(buildSPSelectionPage(issuerUrl, sps));
    }

    // Get SP configuration
    const spConfig = await getSPConfig(env, tenantId, spEntityId);
    if (!spConfig) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // The pending sign-in: kept now (a first request), or the one the person comes back with.
    const requestTtlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);
    const presentedPending = c.req.query('pending');
    let pending: SAMLRequestData;
    if (presentedPending === undefined) {
      const relayState = c.req.query('relay_state');
      assertSAMLRelayStateSize(relayState);
      pending = await saveStoredAuthnRequest(env, tenantId, {
        authnRequest: {
          id: `_idpinit_${crypto.randomUUID()}`,
          issueInstant: new Date().toISOString(),
          issuer: spConfig.entityId,
          forceAuthn: false,
          isPassive: false,
        },
        relayState,
        context: { idpInitiated: true },
        requestTtlSeconds,
      });
    } else {
      if (!PENDING_ID.test(presentedPending)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'pending', reason: 'invalid' },
        });
      }
      pending = await readStoredAuthnRequest(env, tenantId, presentedPending, spConfig.entityId);
      if (pending.context?.idpInitiated !== true) {
        throw new Error('Stored SAML request is not an IdP-initiated sign-in');
      }
    }
    const authnRequest = pending.data as SAMLAuthnRequest;
    const relayState = pending.relayState;
    const pendingRevision = pending.revision as number;
    const resumePath = resumePathOf(spConfig.entityId, authnRequest.id);

    // Check user authentication
    const authenticatedSession = await checkUserAuthentication(c, env);
    if (!authenticatedSession) {
      return redirectToIdPInitiatedLogin(c, {
        issuerUrl,
        tenantId,
        spEntityId: spConfig.entityId,
        pendingId: authnRequest.id,
        resumePath,
      });
    }

    // Answering the pending sign-in without an assertion uses it up too (it is not answered again).
    const refuse = async (code: (typeof AR_ERROR_CODES)[keyof typeof AR_ERROR_CODES]) => {
      await completeStoredAuthnRequest(env, tenantId, authnRequest.id, spConfig.entityId, {
        expectedRevision: pendingRevision,
      });
      return createErrorResponse(c, code);
    };

    // The SP's minimum identity assurance level. No sign-in or consent step can raise a person's
    // IAL, so it is judged before anything is released or asked.
    const refused = await refuseBelowMinimumIdentityAssurance(c, {
      tenantId,
      spConfig,
      userId: authenticatedSession.userId,
      requestId: authnRequest.id,
      log,
    });
    if (refused) {
      await completeStoredAuthnRequest(env, tenantId, authnRequest.id, spConfig.entityId, {
        expectedRevision: pendingRevision,
      });
      return refused;
    }

    // The SP's minimum authentication assurance level. An IdP-initiated sign-in has no AuthnRequest
    // to store a step-up in, nor to answer with NoAuthnContext, so a session below the minimum gets
    // the error page and no assertion is built.
    const authnAssurance = await checkSAMLAuthnAssurance({
      env,
      tenantId,
      authnRequest: {},
      spConfig,
      session: authenticatedSession,
      onUnrecorded: () => undefined,
    });
    if (authnAssurance.outcome !== 'not_required' && authnAssurance.outcome !== 'met') {
      const unavailable = authnAssurance.outcome === 'unavailable';
      if (unavailable) {
        log.error(
          'Failed to read assurance settings',
          { tenantId, spEntityId: spConfig.entityId },
          authnAssurance.error instanceof Error
            ? authnAssurance.error
            : new Error(String(authnAssurance.error))
        );
      } else {
        log.info('SAML sign-in refused: authentication assurance level not met', {
          tenantId,
          spEntityId: spConfig.entityId,
        });
      }
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: authnRequest.id,
        failureKind: unavailable ? 'authn_assurance_unavailable' : 'authn_assurance_insufficient',
        policyDetails: unavailable
          ? {}
          : {
              required_aal: authnAssurance.requiredAal,
              ...(authnAssurance.actual ? { actual_aal: authnAssurance.actual } : {}),
            },
      });
      // The page says neither the level the sign-in reached nor the one the SP requires.
      return refuse(
        unavailable ? AR_ERROR_CODES.INTERNAL_ERROR : AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS
      );
    }

    // Get user information
    const userInfo = await getSamlUserInfoById(env, tenantId, authenticatedSession.userId);
    if (!userInfo) {
      return refuse(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    let responseXml: string;
    try {
      const nameIdFormat = spConfig.nameIdFormat || NAMEID_FORMATS.EMAIL;
      const releaseInput = {
        env,
        tenantId,
        idpEntityId,
        spConfig,
        userInfo,
        userId: authenticatedSession.userId,
        requestScope: c,
        onError: (message: string, error: unknown) =>
          log.error(
            message,
            { tenantId, spEntityId: spConfig.entityId },
            error instanceof Error ? error : new Error(String(error))
          ),
      };
      const release = await computeSAMLAttributeRelease({
        ...releaseInput,
        identifiers: 'deferred',
      });
      const consent = await resolveSAMLReleaseConsent({
        c,
        env,
        tenantId,
        spConfig,
        userInfo,
        session: authenticatedSession,
        release,
        nameIdFormat,
        isPassive: false,
        requestId: authnRequest.id,
        idpInitiated: true,
        resumePath,
        ...(pending.context?.releaseConsent
          ? { pendingChallengeId: pending.context.releaseConsent.challengeId }
          : {}),
        notAfterMs: pending.expiresAt,
        operationId: crypto.randomUUID(),
      });
      if (consent.kind === 'ask') {
        await saveStoredAuthnRequest(env, tenantId, {
          authnRequest,
          relayState,
          context: { idpInitiated: true, releaseConsent: { challengeId: consent.challengeId } },
          storedRevision: pendingRevision,
          requestTtlSeconds,
        });
        return c.redirect(consent.consentUrl);
      }
      if (consent.kind !== 'issue') {
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: `release_consent_${consent.kind}` as const,
        });
        return refuse(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
      }
      const finalRelease = samlApprovalNeedsIdentifiers(release, consent.approval)
        ? await computeSAMLAttributeRelease({ ...releaseInput, identifiers: 'made' })
        : release;
      if (finalRelease.withheldScopedValues.length > 0) {
        scheduleSAMLAttributeWithheldAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          withheld: finalRelease.withheldScopedValues,
        });
      }
      const approved = applySAMLReleaseApproval(finalRelease, consent.approval, nameIdFormat);
      if (!approved.ok) {
        throw new MissingRequiredSAMLAttributeError(
          approved.missing.map((name: string) => ({ name, source: 'identity_mapping' as const }))
        );
      }
      responseXml = await generateIdPInitiatedResponse({
        idpEntityId,
        env,
        spConfig,
        userInfo,
        tenantId,
        authSession: authenticatedSession,
        attributes: approved.attributes,
        nameIdFormat,
        log,
        assurance: authnAssurance.outcome === 'met' ? authnAssurance : undefined,
      });
      // The last check, once the response is built and just before the sign-in is completed.
      if (
        !(await samlReleaseConsentStillCurrent(env, {
          tenantId,
          userId: authenticatedSession.userId,
          spEntityId: spConfig.entityId,
          consentGeneration: consent.consentGeneration,
        }))
      ) {
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'release_consent_withdrawn',
        });
        return refuse(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
      }
    } catch (error) {
      if (error instanceof SAMLAuthnContextPolicyError) {
        // The AuthnContext to issue is above what the sign-in reached: no assertion.
        log.info('SAML sign-in refused: authentication context above the level reached', {
          tenantId,
          spEntityId: spConfig.entityId,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_assurance_insufficient',
          policyDetails: { reason: 'no_class_ref' },
        });
        return refuse(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
      }
      if (error instanceof MissingRequiredSAMLAttributeError) {
        // No assertion without a required attribute (there is no SAML error answer to an
        // IdP-initiated sign-in). The administrator gets the attributes, and the scoped values
        // that were withheld on the way (reason and scope, no value).
        log.warn('SAML attribute release policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          missingAttributes: error.missingAttributes,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'required_attribute_missing',
          missingAttributes: error.missingAttributes,
          ...(error.withheldScopedValues.length > 0
            ? { policyDetails: { withheld: error.withheldScopedValues } }
            : {}),
        });
        return refuse(AR_ERROR_CODES.INTERNAL_ERROR);
      }
      if (
        error instanceof SAMLIdentityMappingRuntimeError ||
        error instanceof RuntimeIdentityMappingReleaseSafetyError
      ) {
        // The mapping or the release safety check refused (see handleIdPSSO): the person gets the
        // error page, the administrator the reason codes and the field name (no value).
        const reasonCodes =
          error instanceof RuntimeIdentityMappingReleaseSafetyError
            ? [`policy.release_${error.reason}`]
            : error.reasons.map((reason) => reason.code);
        log.warn('SAML field mapping set failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          reasonCodes,
          ...(error instanceof RuntimeIdentityMappingReleaseSafetyError
            ? { field: error.field }
            : {}),
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'identity_mapping_failed',
          policyDetails: {
            reason_codes: reasonCodes,
            ...(error instanceof RuntimeIdentityMappingReleaseSafetyError
              ? { field: error.field }
              : {}),
          },
        });
        return refuse(AR_ERROR_CODES.INTERNAL_ERROR);
      }
      throw error;
    }

    // Used up before it is sent: the pending sign-in is answered once.
    await completeStoredAuthnRequest(env, tenantId, authnRequest.id, spConfig.entityId, {
      expectedRevision: pendingRevision,
    });
    return sendSAMLResponse(spConfig, responseXml, relayState);
  } catch (error) {
    if (error instanceof SAMLRelayStateTooLargeError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'relay_state', reason: error.message },
      });
    }
    log.error('IdP-Initiated SSO Error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * The error response for a person who may not sign in to the SP on identity assurance, or null.
 * An IdP-initiated request has no AuthnRequest to answer, so the person gets the error page and no
 * assertion is built. A read of the evidence that fails is reported as an error, never as IAL1.
 */
async function refuseBelowMinimumIdentityAssurance(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    spConfig: SAMLSPConfig;
    userId: string;
    requestId: string;
    log: {
      info(message: string, context?: Record<string, unknown>): void;
      error(message: string, context?: Record<string, unknown>, error?: Error): void;
    };
  }
): Promise<Response | null> {
  const check = await checkSAMLIdentityAssurance(c, {
    env: c.env,
    tenantId: input.tenantId,
    userId: input.userId,
    spConfig: input.spConfig,
  });
  if (check.outcome === 'allowed') return null;

  const logContext = { tenantId: input.tenantId, spEntityId: input.spConfig.entityId };
  if (check.outcome === 'unavailable') {
    input.log.error(
      'Failed to read identity assurance evidence',
      logContext,
      check.error instanceof Error ? check.error : new Error(String(check.error))
    );
  } else {
    input.log.info('SAML sign-in refused: identity assurance level not met', {
      ...logContext,
    });
  }
  scheduleSAMLPolicyFailureAudit(c, {
    tenantId: input.tenantId,
    spEntityId: input.spConfig.entityId,
    authnRequestId: input.requestId,
    failureKind:
      check.outcome === 'unavailable'
        ? 'identity_assurance_unavailable'
        : 'identity_assurance_insufficient',
    policyDetails: {
      required_ial: check.required,
      ...(check.outcome === 'insufficient' ? { actual_ial: check.actual } : {}),
    },
  });
  // The page says neither the level the person holds nor the one the SP requires.
  return createErrorResponse(
    c,
    check.outcome === 'unavailable'
      ? AR_ERROR_CODES.INTERNAL_ERROR
      : AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS
  );
}

async function redirectToIdPInitiatedLogin(
  c: Context<{ Bindings: Env }>,
  input: {
    issuerUrl: string;
    tenantId: string;
    spEntityId: string;
    pendingId: string;
    resumePath: string;
  }
): Promise<Response> {
  const loginParameters = {
    return_to: new URL(input.resumePath, input.issuerUrl).toString(),
    saml_request_id: input.pendingId,
    saml_sp_entity_id: input.spEntityId,
  };

  const uiConfig = await getUIConfig(c.env, input.tenantId);
  if (!uiConfig?.baseUrl) return c.json(createConfigurationError(), 500);
  const loginUrlPolicy = await getSAMLInteractiveLoginUrlPolicy(c.env, input.tenantId);
  if (loginUrlPolicy === 'tenant_host') {
    const loginUrl = new URL(uiConfig.paths?.login || '/login', input.issuerUrl);
    for (const [key, value] of Object.entries(loginParameters))
      loginUrl.searchParams.set(key, value);
    return c.redirect(loginUrl.toString());
  }
  return c.redirect(
    buildUIUrl(
      uiConfig,
      'login',
      loginParameters,
      usesNakedDomainIssuer(c.env, input.tenantId) ? undefined : input.tenantId
    )
  );
}

/**
 * Generate SAML Response for IdP-initiated SSO, with the attributes approved for release. The
 * NameID and the session index are made only now.
 */
async function generateIdPInitiatedResponse(input: {
  idpEntityId: string;
  env: Env;
  spConfig: SAMLSPConfig;
  userInfo: NonNullable<Awaited<ReturnType<typeof getSamlUserInfoById>>>;
  tenantId: string;
  authSession: {
    sessionId: string;
    acr?: string;
    amr?: string[];
    data?: Record<string, unknown>;
    createdAt?: number;
  };
  attributes: Awaited<ReturnType<typeof computeSAMLAttributeRelease>>['attributes'];
  nameIdFormat: SAMLSPConfig['nameIdFormat'];
  log: { debug?(message: string, context?: Record<string, unknown>): void };
  assurance?: Parameters<typeof chooseSAMLAuthnContextClassRef>[2];
}): Promise<string> {
  const { env, spConfig, tenantId, authSession } = input;
  const { privateKeyPem, certificate } = await getSAMLIdPSigningMaterial(env, {
    tenantId,
    counterpartyEntityId: spConfig.entityId,
    providerPolicy: spConfig.signingKeyPolicy,
  });

  // The service provider's own assertion lifetime, else the tenant's.
  const assertionTtlSeconds = await resolveSamlAssertionTtlSeconds(
    env,
    tenantId,
    spConfig.assertionValiditySeconds
  );
  const nameIdValue = await resolveSAMLNameIDValue(input.userInfo, input.nameIdFormat, {
    tenantId,
    spEntityId: spConfig.entityId,
    pairwiseSalt: await resolveSAMLPairwiseSecret(env, tenantId),
    persistentRegistry: resolveSAMLPersistentNameIDRegistryStore(env),
    allowCreate: true,
    transientStore: resolveSAMLTransientNameIDStore(env),
    transientTtlSeconds: assertionTtlSeconds,
    sessionId: authSession.sessionId,
  });

  // AuthnInstant is when the person authenticated (a session reused for single sign-on keeps the
  // time of its sign-in), not the instant the assertion is issued.
  const issuedAt = new Date();
  const authnInstant = resolveSAMLAuthnInstant(authSession.data, {
    createdAt: authSession.createdAt,
    nowMs: issuedAt.getTime(),
  });
  if (authnInstant.source === 'unknown') {
    input.log.debug?.(
      'SAML authentication time unknown, using the issue instant for AuthnInstant',
      {
        tenantId,
        spEntityId: spConfig.entityId,
      }
    );
  }
  const timing = buildSAMLAssertionTiming({
    now: issuedAt,
    authenticatedAtMs: authnInstant.ms,
    assertionValiditySeconds: assertionTtlSeconds,
  });

  // Build SAML Response (no InResponseTo for IdP-initiated)
  const responseId = generateSAMLId();
  const responseXml = buildSAMLResponse({
    responseId,
    assertionId: generateSAMLId(),
    issueInstant: timing.issueInstant,
    issuer: input.idpEntityId,
    destination: spConfig.acsUrl,
    // No inResponseTo for IdP-initiated
    recipientUrl: spConfig.acsUrl,
    audienceRestriction: spConfig.entityId,
    nameId: nameIdValue,
    nameIdFormat: input.nameIdFormat,
    authnInstant: timing.authnInstant,
    sessionIndex: await createSAMLSessionIndex(env.STATE_STORE, {
      tenantId,
      spEntityId: spConfig.entityId,
      sessionId: authSession.sessionId,
      ttlSeconds: DEFAULTS.SESSION_VALIDITY_SECONDS,
    }),
    notBefore: timing.notBefore,
    notOnOrAfter: timing.notOnOrAfter,
    authnContextClassRef: chooseSAMLAuthnContextClassRef(
      {
        id: responseId,
        issueInstant: timing.issueInstant,
        issuer: spConfig.entityId,
      },
      {
        spConfig,
        session: authSession,
      },
      input.assurance
    ),
    attributes: input.attributes,
  });

  return applySAMLResponseSigningPolicy(responseXml, spConfig, {
    privateKeyPem,
    certificate,
  });
}

/**
 * Send SAML Response via auto-submit form
 */
function sendSAMLResponse(
  spConfig: SAMLSPConfig,
  responseXml: string,
  relayState?: string
): Response {
  const encodedResponse = base64Encode(responseXml);
  const fields = [{ name: 'SAMLResponse', value: encodedResponse }];
  if (relayState) {
    fields.push({ name: 'RelayState', value: relayState });
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML SSO - Redirecting...',
    actionUrl: spConfig.acsUrl,
    fields,
    buttonText: 'Continue to Service Provider',
  });
}

/**
 * Build SP selection page
 */
function buildSPSelectionPage(
  issuerUrl: string,
  sps: Array<{ id: string; name: string; entityId: string }>
): string {
  const spLinks = sps
    .map(
      (sp) =>
        `<li><a href="${issuerUrl}/saml/idp/init?sp=${encodeURIComponent(sp.entityId)}">${escapeHtml(sp.name)}</a></li>`
    )
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Select Service Provider</title>
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
  <h1>Select Service Provider</h1>
  <p>Choose a service provider to sign in to:</p>
  <ul>
    ${spLinks || '<li>No service providers configured.</li>'}
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
