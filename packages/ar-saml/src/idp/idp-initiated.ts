/**
 * IdP-Initiated SSO Endpoint
 *
 * Allows the IdP to initiate SSO without receiving an AuthnRequest from the SP.
 * GET /saml/idp/init?sp=<sp_entity_id>
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildUIUrl,
  createConfigurationError,
  usesNakedDomainIssuer,
  getLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  requireAdminDatabaseAdapter,
  filterSamlAttributesByDestinationConsentWithStatus,
  resolveSamlAssertionTtlSeconds,
  RuntimeIdentityMappingReleaseSafetyError,
} from '@authrim/ar-lib-core';
import { getSAMLInteractiveLoginUrlPolicy } from '../common/entity-id';
import { base64Encode, generateSAMLId } from '../common/xml-utils';
import { NAMEID_FORMATS, DEFAULTS, STATUS_CODES } from '../common/constants';
import { buildSAMLResponse } from './assertion';
import { getSPConfig, listSPConfigs } from '../admin/providers';
import { getSamlUserInfoById, type SAMLUserInfo } from '../common/user-store';
import { getSAMLIdPSigningMaterial } from '../common/idp-signing';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import {
  resolveSAMLIdentityMappingFieldMappingBinding,
  MissingRequiredSAMLAttributeError,
  SAMLIdentityMappingRuntimeError,
} from './attributes';
import { applySAMLResponseSigningPolicy } from './signing';
import {
  createSAMLSessionIndex,
  resolveSAMLNameIDValue,
  resolveSAMLPairwiseSecret,
  resolveSAMLPersistentNameIDRegistryStore,
  resolveSAMLTransientNameIDStore,
} from './subject';
import { buildSAMLAssertionTiming, resolveSAMLAuthnInstant } from './assertion-timing';
import { extractAuthrimSessionIdFromCookieHeader } from '../common/session-cookie';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { SAMLAuthnContextPolicyError } from './authn-context';
import { chooseSAMLAuthnContextClassRef, type SAMLClassRefGuard } from './authn-context-assurance';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize, SAMLRelayStateTooLargeError } from '../common/relay-state';
import {
  enforceSAMLAttributeReleaseConsent,
  SAMLAttributeReleaseConsentRequiredError,
} from './attribute-release-consent';
import { checkSAMLIdentityAssurance, withSAMLAssuranceAttributes } from './identity-assurance';
import { resolveSAMLRuntimeIdentityMapping } from './runtime-identity-mapping';
import { checkSAMLAuthnAssurance } from './authn-assurance';
import { scheduleSAMLAttributeWithheldAudit, scheduleSAMLPolicyFailureAudit } from './audit';
import { releaseSAMLAttributesWithInstitution } from './institution-release';
import type { SAMLWithheldScopedValues } from './institution-scope';

interface AuthenticatedSAMLSession {
  userId: string;
  sessionId: string;
  acr?: string;
  amr?: string[];
  /** The session's data: what it records of the authentication (assurance evidence included). */
  data?: Record<string, unknown>;
  /** When the session was created (milliseconds), the last resort for the time of the sign-in. */
  createdAt?: number;
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
    const relayState = c.req.query('relay_state');
    assertSAMLRelayStateSize(relayState);
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

    // Check user authentication
    const authenticatedSession = await checkUserAuthentication(c, env);
    const consentTransactionId = readConsentTransactionId(c.req.query('consent_tx'));
    const consentRetry = c.req.query('consent_retry') === '1';

    // The SP's minimum identity assurance level. No sign-in or consent step can raise a person's
    // IAL, so a session that is already there is judged before it is sent through the consent
    // flow, and again (it is the same check on the same session) before the assertion is built.
    // Without a session the person is not yet known: they are judged when they come back.
    if (authenticatedSession) {
      const refused = await refuseBelowMinimumIdentityAssurance(c, {
        tenantId,
        spConfig,
        userId: authenticatedSession.userId,
        requestId: consentTransactionId ?? 'idp_initiated',
        log,
      });
      if (refused) return refused;
    }

    if (!authenticatedSession || !consentTransactionId) {
      return redirectToIdPInitiatedConsentFlow(c, {
        issuerUrl,
        tenantId,
        spEntityId,
        relayState,
        consentTransactionId: consentTransactionId ?? crypto.randomUUID(),
      });
    }

    // The SP's minimum authentication assurance level. An IdP-initiated sign-in has no AuthnRequest
    // to store a step-up in, nor to answer with NoAuthnContext, so a session below the minimum gets
    // the error page and no assertion is built. Judged here, where the assertion would be built,
    // not before the consent flow, which sends the person to sign in again anyway.
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
        authnRequestId: consentTransactionId,
        failureKind: unavailable ? 'authn_assurance_unavailable' : 'authn_assurance_insufficient',
        policyDetails: unavailable
          ? {}
          : {
              required_aal: authnAssurance.requiredAal,
              ...(authnAssurance.actual ? { actual_aal: authnAssurance.actual } : {}),
            },
      });
      // The page says neither the level the sign-in reached nor the one the SP requires.
      return createErrorResponse(
        c,
        unavailable ? AR_ERROR_CODES.INTERNAL_ERROR : AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS
      );
    }

    // Get user information
    const userInfo = await getUserInfo(env, tenantId, authenticatedSession.userId);
    if (!userInfo) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Generate SAML Response (no InResponseTo since this is IdP-initiated)
    let responseXml: string;
    try {
      responseXml = await generateIdPInitiatedResponse(
        issuerUrl,
        idpEntityId,
        env,
        spConfig,
        userInfo,
        tenantId,
        authenticatedSession,
        consentTransactionId,
        c,
        log,
        authnAssurance.outcome === 'met' ? authnAssurance : undefined,
        (withheld) =>
          scheduleSAMLAttributeWithheldAudit(c, {
            tenantId,
            spEntityId: spConfig.entityId,
            authnRequestId: consentTransactionId,
            withheld,
          })
      );
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
          authnRequestId: consentTransactionId,
          failureKind: 'authn_assurance_insufficient',
          policyDetails: { reason: 'no_class_ref' },
        });
        return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
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
          authnRequestId: consentTransactionId,
          failureKind: 'required_attribute_missing',
          missingAttributes: error.missingAttributes,
          ...(error.withheldScopedValues.length > 0
            ? { policyDetails: { withheld: error.withheldScopedValues } }
            : {}),
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
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
          authnRequestId: consentTransactionId,
          failureKind: 'identity_mapping_failed',
          policyDetails: {
            reason_codes: reasonCodes,
            ...(error instanceof RuntimeIdentityMappingReleaseSafetyError
              ? { field: error.field }
              : {}),
          },
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }
      if (!(error instanceof SAMLAttributeReleaseConsentRequiredError)) throw error;
      if (consentRetry) {
        return c.json(createConfigurationError(), 500);
      }
      await supersedeIdPInitiatedDestinationConsents(env, tenantId, userInfo.id, spConfig.entityId);
      return redirectToIdPInitiatedConsentFlow(c, {
        issuerUrl,
        tenantId,
        spEntityId,
        relayState,
        consentTransactionId: crypto.randomUUID(),
        consentRetry: true,
      });
    }

    // Return auto-submit form
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

function readConsentTransactionId(value: string | undefined): string | null {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    return null;
  }
  return value;
}

async function redirectToIdPInitiatedConsentFlow(
  c: Context<{ Bindings: Env }>,
  input: {
    issuerUrl: string;
    tenantId: string;
    spEntityId: string;
    relayState?: string;
    consentTransactionId: string;
    consentRetry?: boolean;
  }
): Promise<Response> {
  const returnUrl = new URL('/saml/idp/init', input.issuerUrl);
  returnUrl.searchParams.set('sp', input.spEntityId);
  if (input.relayState) returnUrl.searchParams.set('relay_state', input.relayState);
  returnUrl.searchParams.set('consent_tx', input.consentTransactionId);
  if (input.consentRetry) returnUrl.searchParams.set('consent_retry', '1');
  const loginParameters = {
    return_to: returnUrl.toString(),
    saml_request_id: input.consentTransactionId,
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

async function supersedeIdPInitiatedDestinationConsents(
  env: Env,
  tenantId: string,
  subjectId: string,
  spEntityId: string
): Promise<void> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'saml-idp-initiated-consent-refresh',
    { tenantId }
  );
  const now = Math.floor(Date.now() / 1000);
  await adapter.execute(
    `UPDATE consent_records
        SET status = 'superseded', updated_at = ?
      WHERE tenant_id = ?
        AND subject_user_id = ?
        AND protocol = 'saml'
        AND recipient_type = 'saml_sp'
        AND recipient_id = ?
        AND binding_type = 'destination_field_mapping_set'
        AND status = 'active'`,
    [now, tenantId, subjectId, spEntityId]
  );
}

/**
 * Check if user is authenticated (sharded)
 */
async function checkUserAuthentication(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<AuthenticatedSAMLSession | null> {
  const sessionId = extractAuthrimSessionIdFromCookieHeader(c.req.header('Cookie'));

  if (!sessionId) {
    return null;
  }

  // Verify session with SessionStore (sharded)
  if (!isShardedSessionId(sessionId)) {
    return null;
  }

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(
      env,
      sessionId,
      resolveSAMLTenantIdFromContext(c)
    );
    const response = await sessionStore.fetch(`https://session-store/session/${sessionId}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return null;
    }

    const session = await response.json<{
      userId?: string;
      createdAt?: number;
      data?: Record<string, unknown>;
    }>();
    const data =
      session.data && typeof session.data === 'object' && !Array.isArray(session.data)
        ? session.data
        : undefined;
    return session.userId
      ? {
          userId: session.userId,
          sessionId,
          acr: typeof data?.acr === 'string' ? data.acr : undefined,
          amr: Array.isArray(data?.amr)
            ? data.amr.filter((value): value is string => typeof value === 'string')
            : undefined,
          data,
          createdAt: typeof session.createdAt === 'number' ? session.createdAt : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Get user information from database
 */
async function getUserInfo(
  env: Env,
  tenantId: string,
  userId: string
): Promise<SAMLUserInfo | null> {
  return getSamlUserInfoById(env, tenantId, userId);
}

/**
 * Generate SAML Response for IdP-initiated SSO
 */
async function generateIdPInitiatedResponse(
  issuerUrl: string,
  idpEntityId: string,
  env: Env,
  spConfig: SAMLSPConfig,
  userInfo: SAMLUserInfo,
  tenantId: string,
  authSession: AuthenticatedSAMLSession,
  consentTransactionId: string,
  requestScope: object,
  log: {
    debug?(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>, error?: Error): void;
  },
  /** The class reference chosen for the AAL reached, and what the one issued is checked against. */
  assurance?: { classRef?: string; guard: SAMLClassRefGuard },
  /** Told what scoped values the tenant's institution scopes kept out of the assertion. */
  onScopedValuesWithheld?: (withheld: SAMLWithheldScopedValues[]) => void
): Promise<string> {
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
  const nameIdFormat = spConfig.nameIdFormat || NAMEID_FORMATS.EMAIL;
  const nameIdValue = await resolveSAMLNameIDValue(userInfo, nameIdFormat, {
    tenantId,
    spEntityId: spConfig.entityId,
    pairwiseSalt: await resolveSAMLPairwiseSecret(env, tenantId),
    persistentRegistry: resolveSAMLPersistentNameIDRegistryStore(env),
    allowCreate: true,
    transientStore: resolveSAMLTransientNameIDStore(env),
    transientTtlSeconds: assertionTtlSeconds,
    sessionId: authSession.sessionId,
  });

  // Build attributes from mapping
  const identityMapping = await resolveSAMLRuntimeIdentityMapping(
    env,
    tenantId,
    idpEntityId,
    spConfig
  );
  const mappingContext = {
    role: 'idp' as const,
    tenantId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
  };
  const onReadError = (message: string, error: unknown) =>
    log.error(
      message,
      { tenantId, spEntityId: spConfig.entityId },
      error instanceof Error ? error : new Error(String(error))
    );
  // The assurance values a mapping releases come from the person's evidence, read only when
  // one is released. The tenant's institution (the scopes the scoped attributes must be under,
  // and the attributes a mapping may release about it) is applied when the mapping has a use for it.
  const release = await releaseSAMLAttributesWithInstitution({
    env,
    tenantId,
    subject: await withSAMLAssuranceAttributes(userInfo, {
      requestScope,
      env,
      tenantId,
      userId: authSession.userId,
      identityMapping,
      mappingContext,
      onError: onReadError,
    }),
    releaseConfig: {
      ...spConfig,
      tenantId,
      localEntityId: idpEntityId,
      identityMapping,
    },
    onError: onReadError,
  });
  if (release.withheldScopedValues?.length) onScopedValuesWithheld?.(release.withheldScopedValues);
  let attributes = release.attributes;
  let destinationFieldConsentConfirmed: { consentRecordId: string } | undefined;
  if (identityMapping?.destinationProfileId) {
    const destinationRelease = (await filterSamlAttributesByDestinationConsentWithStatus({
      coreAdapter: await resolveAuthCorePersistenceAdapterFromEnv(
        env,
        'saml-idp-initiated-destination-consent',
        { tenantId }
      ),
      adminAdapter: requireAdminDatabaseAdapter(env, 'saml-idp-initiated-destination-consent'),
      tenantId,
      subjectId: userInfo.id,
      samlSpId: spConfig.entityId,
      profileId: identityMapping.destinationProfileId,
      fieldPolicies: identityMapping.destinationFieldPolicies,
      releaseSafetyBinding: resolveSAMLIdentityMappingFieldMappingBinding(identityMapping, {
        role: 'idp',
        tenantId,
        localEntityId: idpEntityId,
        partnerEntityId: spConfig.entityId,
      }),
      attributes,
    })) as {
      attributes: typeof attributes;
      consentApplied: boolean;
      consentRecordId?: string;
      consentEvidence?: Record<string, unknown>;
    };
    attributes = destinationRelease.attributes;
    if (
      destinationRelease.consentApplied &&
      destinationRelease.consentRecordId &&
      destinationRelease.consentEvidence?.saml_request_id === consentTransactionId
    ) {
      destinationFieldConsentConfirmed = {
        consentRecordId: destinationRelease.consentRecordId,
      };
    }
  }
  await enforceSAMLAttributeReleaseConsent({
    env,
    tenantId,
    subjectId: userInfo.id,
    spConfig,
    attributes,
    destinationFieldConsentConfirmed,
  });
  // AuthnInstant is when the person authenticated (a session reused for single sign-on keeps the
  // time of its sign-in), not the instant the assertion is issued.
  const issuedAt = new Date();
  const authnInstant = resolveSAMLAuthnInstant(authSession.data, {
    createdAt: authSession.createdAt,
    nowMs: issuedAt.getTime(),
  });
  if (authnInstant.source === 'unknown') {
    log.debug?.('SAML authentication time unknown, using the issue instant for AuthnInstant', {
      tenantId,
      spEntityId: spConfig.entityId,
    });
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
    issuer: idpEntityId,
    destination: spConfig.acsUrl,
    // No inResponseTo for IdP-initiated
    recipientUrl: spConfig.acsUrl,
    audienceRestriction: spConfig.entityId,
    nameId: nameIdValue,
    nameIdFormat,
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
      assurance
    ),
    attributes,
  });

  const finalResponseXml = applySAMLResponseSigningPolicy(responseXml, spConfig, {
    privateKeyPem,
    certificate,
  });
  if (
    destinationFieldConsentConfirmed &&
    spConfig.attributeReleaseConsent?.enabled === true &&
    spConfig.attributeReleaseConsent.mode === 'every_time'
  ) {
    await consumeIdPInitiatedDestinationConsent(
      env,
      tenantId,
      userInfo.id,
      destinationFieldConsentConfirmed.consentRecordId
    );
  }
  return finalResponseXml;
}

async function consumeIdPInitiatedDestinationConsent(
  env: Env,
  tenantId: string,
  subjectId: string,
  consentRecordId: string
): Promise<void> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'saml-idp-initiated-consent-consume',
    { tenantId }
  );
  await adapter.execute(
    `UPDATE consent_records
        SET status = 'superseded', updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND subject_user_id = ?
        AND protocol = 'saml'
        AND binding_type = 'destination_field_mapping_set'
        AND status = 'active'`,
    [Math.floor(Date.now() / 1000), consentRecordId, tenantId, subjectId]
  );
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
