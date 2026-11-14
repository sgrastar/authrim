/**
 * SAML IdP SSO Endpoint
 *
 * Handles SP-initiated SSO flow:
 * 1. Receive AuthnRequest from SP (POST or Redirect binding)
 * 2. Verify user authentication (via SessionStore)
 * 3. Generate SAML Assertion and Response
 * 4. Return signed Response to SP's ACS URL
 *
 * GET  /saml/idp/sso - HTTP-Redirect Binding
 * POST /saml/idp/sso - HTTP-POST Binding
 */

import type { Context } from 'hono';
import type { Env, NameIDFormat, SAMLAttribute } from '@authrim/ar-lib-core';
import type { SAMLAuthnRequest, SAMLRequestContext, SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  buildSAMLSSOResumePath,
  getSessionStoreBySessionId,
  isShardedSessionId,
  getTenantSettingsDocument,
  getLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  sessionAnswersSAMLRequest,
  resolveSamlAssertionTtlSeconds,
  resolveSamlRequestTtlSeconds,
  RuntimeIdentityMappingReleaseSafetyError,
  hashSAMLLoginNonce,
  isSAMLLoginNonce,
} from '@authrim/ar-lib-core';
import { timingSafeEqual } from '@authrim/ar-lib-core/utils/crypto';
import {
  parseSAMLXml,
  findDirectChildElement,
  getAttribute,
  getTextContent,
  generateSAMLId,
  base64Encode,
  parseXmlBoolean,
} from '../common/xml-utils';
import {
  decodePostBindingMessage,
  inflateRedirectBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../common/message-limits';
import { NAMEID_FORMATS, SAML_NAMESPACES, STATUS_CODES, DEFAULTS } from '../common/constants';
import { buildSAMLResponse } from './assertion';
import { getSPConfig } from '../admin/providers';
import { getSamlUserInfoById, type SAMLUserInfo } from '../common/user-store';
import { getSAMLIdPSigningMaterial } from '../common/idp-signing';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import { MissingRequiredSAMLAttributeError, SAMLIdentityMappingRuntimeError } from './attributes';
import {
  SAMLAuthnRequestSignatureValidationError,
  validateSAMLAuthnRequestSignature,
  type SAMLRedirectSignatureInput,
} from './authn-request-signature';
import { parseRequestedAuthnContext, SAMLAuthnContextPolicyError } from './authn-context';
import { chooseSAMLAuthnContextClassRef, type SAMLClassRefGuard } from './authn-context-assurance';
import { readSAMLAssuranceStepUp, sessionProvenAt } from './authn-assurance';
import { gateSAMLAuthnAssurance } from './sso-authn-assurance-gate';
import {
  carrySAMLRequestContext,
  readSAMLReauthentication,
  completeStoredAuthnRequest,
  readStoredAuthnRequest,
  saveStoredAuthnRequest,
  redirectToSAMLLogin,
  type ResumedSAMLLogin,
} from './sso-stored-request';
import { resolveSAMLAuthnInteraction } from './authn-request-policy';
import {
  InvalidSAMLResponseDestinationError,
  resolveSAMLResponseDestination,
  UnsupportedSAMLResponseBindingError,
  validateSAMLResponseProtocolBinding,
} from './response-destination';
import { applySAMLResponseSigningPolicy, assertSAMLResponseSigningPolicy } from './signing';
import { applySAMLAssertionEncryptionPolicy } from './encryption';
import {
  createSAMLSessionIndex,
  SAMLNameIDPolicyError,
  resolveSAMLNameIDFormat,
  resolveSAMLNameIDValue,
  resolveSAMLPairwiseSecret,
  resolveSAMLPersistentNameIDRegistryStore,
  resolveSAMLTransientNameIDStore,
} from './subject';
import { extractAuthrimSessionIdFromCookieHeader } from '../common/session-cookie';
import {
  applySAMLErrorResponseOverride,
  buildSAMLIdPErrorResponse,
  getSAMLAttributeReleaseFailureStatusMessage,
} from './error-response';
import { resolveSAMLReleaseConsent, samlReleaseConsentStillCurrent } from './release-consent';
import {
  applySAMLReleaseApproval,
  computeSAMLAttributeRelease,
  resolveSAMLMappedNameID,
  samlApprovalNeedsIdentifiers,
} from './release-items';
import { scheduleSAMLAttributeWithheldAudit, scheduleSAMLPolicyFailureAudit } from './audit';
import { checkSAMLIdentityAssurance } from './identity-assurance';
import { buildSAMLAssertionTiming, resolveSAMLAuthnInstant } from './assertion-timing';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize } from '../common/relay-state';
import { isAllowedIdPSSODestination } from './shibboleth-compat';
import { parseRedirectBindingSignatureInput } from '../common/signature';

interface AuthenticatedSAMLSession {
  userId: string;
  sessionId: string;
  acr?: string;
  amr?: string[];
  /** The session's data: what it records of the authentication (assurance evidence included). */
  data?: Record<string, unknown>;
  /** When the session last recorded a proof of authentication (milliseconds). */
  provenAt?: number;
  /** When the session was created (milliseconds), the last resort for the time of the sign-in. */
  createdAt?: number;
}

/** A pending IdP-initiated sign-in came back to the SP-initiated endpoint (see its use). */
class IdPInitiatedResume extends Error {
  constructor(readonly path: string) {
    super('Stored SAML request is an IdP-initiated sign-in');
  }
}

interface ParsedAuthnRequestInput {
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
  binding: 'redirect' | 'post';
  xml: string;
  storedRequestValidated?: boolean;
  redirectSignature?: SAMLRedirectSignatureInput;
  requestContext?: SAMLRequestContext;
  /** For a resumed request: what its login keeps of the nonce (redirectToSAMLLogin). */
  resumedLogin?: ResumedSAMLLogin;
  /** For a resumed request: the revision it was read at (completed or updated only at it). */
  storedRevision?: number;
}

/**
 * Handle SSO request (both GET and POST)
 */
export async function handleIdPSSO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;
  const log = getLogger(c).module('SAML-IDP');
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { issuerUrl, idpEntityId } = await getSAMLLocalEntityIds(env, tenantId);
  const requestTtlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);

  try {
    // Parse AuthnRequest based on binding
    let parsedInput: ParsedAuthnRequestInput;

    if (method === 'GET') {
      // HTTP-Redirect Binding
      parsedInput = (await parseStoredAuthnRequest(c, tenantId)) ?? (await parseRedirectBinding(c));
    } else {
      // HTTP-POST Binding
      parsedInput = await parsePostBinding(c);
    }

    let { authnRequest } = parsedInput;
    const { relayState } = parsedInput;
    // Every answer to the SP for a stored request uses the request up first, at the revision it
    // was read at: a request answered in another tab, or changed since, is not answered again.
    // A request refused before it is recorded (its signature, ACS or binding failed) is recorded
    // and used up at once too, so the same AuthnRequest sent again is refused.
    const answerSP = async (destination: string, responseXml: string): Promise<Response> => {
      const storedRevision =
        parsedInput.storedRevision ??
        (
          await saveStoredAuthnRequest(env, tenantId, {
            authnRequest,
            relayState,
            // Never resumed, even if it is left waiting (the completion below failed).
            context: { refusedOnArrival: true },
            requestTtlSeconds,
          })
        ).revision;
      await completeStoredAuthnRequest(env, tenantId, authnRequest.id, authnRequest.issuer, {
        expectedRevision: storedRevision,
      });
      return sendSAMLResponse(c, destination, responseXml, relayState);
    };

    // Validate AuthnRequest
    await validateAuthnRequest(authnRequest, issuerUrl, requestTtlSeconds);

    // Get SP configuration
    const spConfig = await getSPConfig(env, tenantId, authnRequest.issuer);
    if (!spConfig) {
      return createErrorResponse(c, 'Unknown Service Provider', STATUS_CODES.REQUEST_DENIED);
    }

    try {
      if (!parsedInput.storedRequestValidated) {
        const verifiedReferences = await validateSAMLAuthnRequestSignature({
          authnRequest,
          spConfig,
          binding: parsedInput.binding,
          xml: parsedInput.xml,
          redirectSignature: parsedInput.redirectSignature,
        });
        if (parsedInput.binding === 'post' && verifiedReferences) {
          const signedRequest = verifiedReferences.find(
            (reference) => reference.uri === `#${authnRequest.id}`
          );
          if (!signedRequest) {
            throw new SAMLAuthnRequestSignatureValidationError(
              'authn_request_invalid_signature',
              'Signed AuthnRequest reference is missing'
            );
          }
          const authenticatedRequest = parseAuthnRequestXml(signedRequest.xml);
          if (
            authenticatedRequest.id !== authnRequest.id ||
            authenticatedRequest.issuer !== authnRequest.issuer
          ) {
            throw new SAMLAuthnRequestSignatureValidationError(
              'authn_request_invalid_signature',
              'Signed AuthnRequest does not match the routed request'
            );
          }
          authnRequest = authenticatedRequest;
          await validateAuthnRequest(authnRequest, issuerUrl, requestTtlSeconds);
        }
      }
      validateSAMLResponseProtocolBinding(authnRequest);
      resolveSAMLResponseDestination(authnRequest, spConfig);
    } catch (error) {
      if (error instanceof SAMLAuthnRequestSignatureValidationError) {
        log.warn('SAML AuthnRequest signature policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: error.failureKind,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: error.failureKind,
          policyDetails: error.details,
        });

        const responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.REQUESTER,
          STATUS_CODES.REQUEST_DENIED,
          'SAML request was rejected by IdP policy',
          error.failureKind
        );
        return answerSP(resolveSAMLResponseDestination(authnRequest, spConfig), responseXml);
      }

      if (error instanceof InvalidSAMLResponseDestinationError) {
        log.warn('SAML AuthnRequest ACS URL policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_invalid_acs_url',
          policyDetails: {
            requested_acs_url: error.requestedAcsUrl,
            allowed_acs_urls: error.allowedAcsUrls,
          },
        });
      }

      if (error instanceof UnsupportedSAMLResponseBindingError) {
        log.warn('SAML AuthnRequest response binding policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          requestedBinding: error.requestedBinding,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_unsupported_response_binding',
          policyDetails: {
            requested_binding: error.requestedBinding,
            supported_bindings: error.supportedBindings,
          },
        });

        const responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.REQUESTER,
          STATUS_CODES.UNSUPPORTED_BINDING,
          'Requested SAML response binding is not supported',
          'authn_request_unsupported_response_binding'
        );
        return answerSP(resolveSAMLResponseDestination(authnRequest, spConfig), responseXml);
      }

      throw error;
    }

    // A request that arrives is recorded once it has passed the checks above, before anything is
    // done for it: the same AuthnRequest sent again, while it could still be accepted, finds its
    // id known and is refused here (no user, NameID or Assertion is touched for it).
    if (parsedInput.storedRevision === undefined) {
      parsedInput.storedRevision = (
        await saveStoredAuthnRequest(env, tenantId, {
          authnRequest,
          relayState,
          context: {},
          requestTtlSeconds,
        })
      ).revision;
    }

    // Check user authentication
    let authenticatedSession = await checkUserAuthentication(c, env);
    // A session made since the person was sent to sign in for this request answers it only if it
    // was made for it: otherwise the person signs in again, under the SP's Flow.
    // A re-authentication or step-up is proven on its own screen, which runs no Flow (its
    // challenge and the proof time hold it to this request instead).
    if (
      authenticatedSession &&
      parsedInput.storedRequestValidated &&
      !readSAMLReauthentication(parsedInput.requestContext) &&
      !readSAMLAssuranceStepUp(parsedInput.requestContext)
    ) {
      try {
        const answers = await sessionAnswersSAMLRequest(
          await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-idp-sign-in-flow', {
            tenantId,
          }),
          tenantId,
          {
            sessionCreatedAt: authenticatedSession.createdAt,
            sessionData: authenticatedSession.data,
            sentToSignInAt: parsedInput.requestContext?.sentToSignInAt,
            requestId: authnRequest.id,
            spEntityId: authnRequest.issuer,
          }
        );
        if (!answers) authenticatedSession = null;
      } catch (error) {
        // The session is not taken: the person is sent to sign in again (the stored request is
        // updated, not used up), rather than answered with an error they could not retry.
        log.warn('SAML sign-in Flow could not be read for the session', {}, error as Error);
        authenticatedSession = null;
      }
    }
    const authnInteraction = resolveSAMLAuthnInteraction(authnRequest, authenticatedSession, {
      reauthentication: readSAMLReauthentication(parsedInput.requestContext),
      returnedFromSignIn: Boolean(
        readSAMLReauthentication(parsedInput.requestContext) ||
        readSAMLAssuranceStepUp(parsedInput.requestContext)
      ),
    });

    if (authnInteraction.action === 'protocol_error') {
      log.warn('SAML AuthnRequest interaction policy failed', {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: authnRequest.id,
        failureKind: authnInteraction.failureKind,
      });
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: authnRequest.id,
        failureKind: authnInteraction.failureKind,
        policyDetails: authnInteraction.policyDetails,
      });

      const responseXml = await generateSAMLProtocolErrorResponse(
        issuerUrl,
        idpEntityId,
        env,
        authnRequest,
        spConfig,
        tenantId,
        authnInteraction.statusCode,
        authnInteraction.secondLevelStatusCode,
        authnInteraction.statusMessage,
        authnInteraction.failureKind
      );
      return answerSP(resolveSAMLResponseDestination(authnRequest, spConfig), responseXml);
    }

    if (authnInteraction.action === 'interactive_login') {
      // User not authenticated, or asked to sign in again (ForceAuthn): the request is stored for
      // when they come back, with the time they were sent when it is a new sign-in they are sent
      // for, so that the sign-in they return from is recognised and they are not sent again.
      const sentAt = Date.now();
      return await redirectToSAMLLogin(c, {
        env,
        tenantId,
        authnRequest,
        relayState,
        forceReauthentication: authnInteraction.forceReauthentication,
        // A person who is signed in is sent to prove themselves again (a challenge for the Login
        // UI); one who is not has to sign in anyway.
        ...(authnInteraction.forceReauthentication && authenticatedSession
          ? { signInAgain: { subjectUserId: authenticatedSession.userId, issuedAt: sentAt } }
          : {}),
        context: {
          ...carrySAMLRequestContext(parsedInput.requestContext),
          ...(authnInteraction.forceReauthentication
            ? { reauthentication: { issuedAt: sentAt } }
            : {}),
        },
        resumedLogin: parsedInput.resumedLogin,
        ...(parsedInput.storedRevision !== undefined
          ? { storedRevision: parsedInput.storedRevision }
          : {}),
      });
    }

    // The SP's minimum identity assurance level. No sign-in or consent step can raise a person's
    // IAL, so this is judged before the user data, the NameID, the attribute release and its
    // consent are touched, and only for a session that is going to be answered (one that a
    // ForceAuthn request sends to sign in again is judged when the request comes back).
    const identityAssurance = await checkSAMLIdentityAssurance(c, {
      env,
      tenantId,
      userId: authnInteraction.session.userId,
      spConfig,
    });
    if (identityAssurance.outcome !== 'allowed') {
      const unavailable = identityAssurance.outcome === 'unavailable';
      if (unavailable) {
        log.error(
          'Failed to read identity assurance evidence',
          { tenantId, spEntityId: spConfig.entityId, authnRequestId: authnRequest.id },
          identityAssurance.error instanceof Error
            ? identityAssurance.error
            : new Error(String(identityAssurance.error))
        );
      } else {
        log.info('SAML sign-in refused: identity assurance level not met', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
        });
      }
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: authnRequest.id,
        failureKind: unavailable
          ? 'identity_assurance_unavailable'
          : 'identity_assurance_insufficient',
        policyDetails: {
          required_ial: identityAssurance.required,
          ...(identityAssurance.outcome === 'insufficient'
            ? { actual_ial: identityAssurance.actual }
            : {}),
        },
      });

      // The answer says neither the level the person holds nor the one the SP requires.
      const responseXml = await generateSAMLProtocolErrorResponse(
        issuerUrl,
        idpEntityId,
        env,
        authnRequest,
        spConfig,
        tenantId,
        STATUS_CODES.RESPONDER,
        unavailable ? undefined : STATUS_CODES.REQUEST_DENIED,
        unavailable
          ? 'The request could not be processed right now'
          : 'SAML request was rejected by IdP policy',
        unavailable ? 'identity_assurance_unavailable' : 'identity_assurance_insufficient'
      );
      return answerSP(resolveSAMLResponseDestination(authnRequest, spConfig), responseXml);
    }

    // The AAL the sign-in must have (the SP's minimum, and what the request's AuthnContext asks
    // for). Judged after the IAL: no sign-in can raise a person's IAL, so one who is refused for
    // it is not sent to authenticate again for nothing; and before the user data and attribute
    // release are touched.
    const assuranceGate = await gateSAMLAuthnAssurance(c, {
      env,
      tenantId,
      authnRequest,
      spConfig,
      session: authnInteraction.session,
      relayState,
      requestContext: parsedInput.requestContext,
      resumedLogin: parsedInput.resumedLogin,
      ...(parsedInput.storedRevision !== undefined
        ? { storedRevision: parsedInput.storedRevision }
        : {}),
      log,
      refuse: async (answer) =>
        answerSP(
          resolveSAMLResponseDestination(authnRequest, spConfig),
          await generateSAMLProtocolErrorResponse(
            issuerUrl,
            idpEntityId,
            env,
            authnRequest,
            spConfig,
            tenantId,
            STATUS_CODES.RESPONDER,
            answer.secondLevelStatusCode,
            answer.statusMessage,
            answer.failureKind
          )
        ),
    });
    if ('response' in assuranceGate) return assuranceGate.response;
    const authnAssurance = assuranceGate.check;

    // Get user information
    const userInfo = await getUserInfo(env, tenantId, authnInteraction.session.userId);
    if (!userInfo) {
      return createErrorResponse(c, 'Authentication failed', STATUS_CODES.UNKNOWN_PRINCIPAL);
    }

    // Generate SAML Response
    let responseXml: string;
    try {
      const refuseRequest = async (
        secondLevelStatusCode: string,
        statusMessage: string,
        failureKind: string
      ) =>
        answerSP(
          resolveSAMLResponseDestination(authnRequest, spConfig),
          await generateSAMLProtocolErrorResponse(
            issuerUrl,
            idpEntityId,
            env,
            authnRequest,
            spConfig,
            tenantId,
            STATUS_CODES.RESPONDER,
            secondLevelStatusCode,
            statusMessage,
            failureKind
          )
        );
      const nameIdFormat = resolveSAMLNameIDFormat(authnRequest, spConfig);
      const releaseInput = {
        env,
        tenantId,
        idpEntityId,
        spConfig,
        userInfo,
        userId: authnInteraction.session.userId,
        requestScope: c,
        onError: (message: string, error: unknown) =>
          log.error(
            message,
            { tenantId, spEntityId: spConfig.entityId, authnRequestId: authnRequest.id },
            error instanceof Error ? error : new Error(String(error))
          ),
      };
      // What the SP would be given, with no identifier made for it yet.
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
        session: authnInteraction.session,
        release,
        nameIdFormat,
        isPassive: authnRequest.isPassive === true,
        requestId: authnRequest.id,
        idpInitiated: false,
        resumePath: buildSAMLSSOResumePath({
          requestId: authnRequest.id,
          spEntityId: authnRequest.issuer,
        }),
        ...(parsedInput.requestContext?.releaseConsent
          ? { pendingChallengeId: parsedInput.requestContext.releaseConsent.challengeId }
          : {}),
        notAfterMs: Date.parse(authnRequest.issueInstant) + requestTtlSeconds * 1000,
        operationId: crypto.randomUUID(),
      });
      if (consent.kind === 'ask') {
        // The request waits for this challenge only: asking again replaces the one before.
        await saveStoredAuthnRequest(env, tenantId, {
          authnRequest,
          relayState,
          context: {
            ...carrySAMLRequestContext({
              ...parsedInput.requestContext,
              // The step-up, with the session it was verified against: the request comes back
              // through the consent screen with that session holding the combined evidence.
              ...(authnAssurance.outcome === 'met' && authnAssurance.assuranceStepUp
                ? { assuranceStepUp: authnAssurance.assuranceStepUp }
                : {}),
            }),
            releaseConsent: { challengeId: consent.challengeId },
          },
          ...(parsedInput.storedRevision !== undefined
            ? { storedRevision: parsedInput.storedRevision }
            : {}),
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
        return consent.kind === 'no_passive'
          ? await refuseRequest(
              STATUS_CODES.NO_PASSIVE,
              'The request needs the user to consent',
              'release_consent_no_passive'
            )
          : await refuseRequest(
              STATUS_CODES.REQUEST_DENIED,
              consent.kind === 'refused'
                ? 'The user did not consent'
                : 'SAML request was rejected by IdP policy',
              `release_consent_${consent.kind}`
            );
      }
      // Identifiers are made only when an approved item needs one.
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
      if (finalRelease.optionalMissingAttributes.length > 0) {
        log.debug('Optional SAML attributes omitted', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          missingAttributes: finalRelease.optionalMissingAttributes,
        });
      }
      responseXml = await generateSAMLResponse(
        idpEntityId,
        env,
        authnRequest,
        spConfig,
        userInfo,
        tenantId,
        authnInteraction.session,
        { attributes: approved.attributes, nameIdFormat },
        log,
        authnAssurance.outcome === 'met' ? authnAssurance : undefined
      );
      // The last check, once the response is built and just before the request is completed and
      // answered: a withdrawal since the decision issues nothing (the person starts again from the
      // service).
      if (
        !(await samlReleaseConsentStillCurrent(env, {
          tenantId,
          userId: authnInteraction.session.userId,
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
        return await refuseRequest(
          STATUS_CODES.REQUEST_DENIED,
          'SAML request was rejected by IdP policy',
          'release_consent_withdrawn'
        );
      }
    } catch (error) {
      if (error instanceof MissingRequiredSAMLAttributeError) {
        log.warn('SAML attribute release policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
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

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.RESPONDER,
          STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE,
          getSAMLAttributeReleaseFailureStatusMessage(
            {
              attributeReleaseFailureUserMessageMode:
                await resolveAttributeReleaseFailureUserMessageMode(env, tenantId, spConfig),
            },
            error.missingAttributes
          ),
          'required_attribute_missing'
        );
      } else if (
        error instanceof SAMLIdentityMappingRuntimeError ||
        error instanceof RuntimeIdentityMappingReleaseSafetyError
      ) {
        // The mapping or the release safety check refused: a field released from a source whose
        // classification is unknown, to a destination less sensitive than its source, or under a
        // name that is not its profile field's. Reason codes and the field name, no value.
        const reasonCodes =
          error instanceof RuntimeIdentityMappingReleaseSafetyError
            ? [`policy.release_${error.reason}`]
            : error.reasons.map((reason) => reason.code);
        log.warn('SAML field mapping set failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
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

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.RESPONDER,
          STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE,
          'SAML field mapping set could not be evaluated',
          'identity_mapping_failed'
        );
      } else if (error instanceof SAMLAuthnContextPolicyError) {
        log.warn('SAML RequestedAuthnContext policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          requestedAuthnContext: error.requestedAuthnContext,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_unsupported_authn_context',
          policyDetails: {
            requested_authn_context: error.requestedAuthnContext,
          },
        });

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.RESPONDER,
          STATUS_CODES.NO_AUTHN_CONTEXT,
          'Requested authentication context could not be satisfied',
          'authn_request_unsupported_authn_context'
        );
      } else if (error instanceof SAMLNameIDPolicyError) {
        log.warn('SAML NameIDPolicy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          details: error.details,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_invalid_nameid_policy',
          policyDetails: error.details,
        });

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.REQUESTER,
          STATUS_CODES.INVALID_NAMEID_POLICY,
          'Requested NameID policy could not be satisfied',
          'authn_request_invalid_nameid_policy'
        );
      } else {
        throw error;
      }
    }

    // Return response based on SP's preferred binding
    return answerSP(resolveSAMLResponseDestination(authnRequest, spConfig), responseXml);
  } catch (error) {
    if (error instanceof IdPInitiatedResume) {
      return c.redirect(new URL(error.path, issuerUrl).toString());
    }
    log.error('SSO Error', { method }, error as Error);
    // SECURITY: Do not expose internal error details in response
    return createErrorResponse(c, 'SSO processing failed', STATUS_CODES.RESPONDER);
  }
}

async function resolveAttributeReleaseFailureUserMessageMode(
  env: Env,
  tenantId: string,
  spConfig: SAMLSPConfig
): Promise<SAMLSPConfig['attributeReleaseFailureUserMessageMode']> {
  if (spConfig.attributeReleaseFailureUserMessageMode) {
    return spConfig.attributeReleaseFailureUserMessageMode;
  }

  const authrimSettings = await getTenantSettingsDocument(env, tenantId, 'tenant', {
    // Without the tenant's settings the fallback is at least as strict.
    onUnreadable: 'empty',
  });
  const mode = authrimSettings?.[TENANT_SAML_ATTRIBUTE_RELEASE_FAILURE_MESSAGE_MODE];
  return mode === 'detailed' || mode === 'generic' ? mode : 'generic';
}

/**
 * Parse HTTP-Redirect binding parameters
 */
async function parseRedirectBinding(c: Context<{ Bindings: Env }>): Promise<{
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
  binding: 'redirect';
  xml: string;
  redirectSignature: SAMLRedirectSignatureInput;
}> {
  const url = new URL(c.req.url);
  const samlRequest = url.searchParams.get('SAMLRequest');
  const relayState = url.searchParams.get('RelayState') || undefined;
  assertSAMLRelayStateSize(relayState);

  if (!samlRequest) {
    throw new Error('Missing SAMLRequest parameter');
  }

  // Decode: URL decode -> Base64 decode -> Inflate (deflate decompress)
  const inflated = inflateRedirectBindingMessage(samlRequest, 'SAML AuthnRequest');
  const redirectSignature = parseRedirectBindingSignatureInput(url.search, 'SAMLRequest');

  return {
    authnRequest: parseAuthnRequestXml(inflated),
    relayState,
    binding: 'redirect',
    xml: inflated,
    redirectSignature,
  };
}

async function parseStoredAuthnRequest(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<ParsedAuthnRequestInput | null> {
  const url = new URL(c.req.url);
  const requestId = url.searchParams.get('saml_request_id');
  if (!requestId) {
    return null;
  }

  const spEntityId = url.searchParams.get('saml_sp_entity_id');
  if (!spEntityId) {
    throw new Error('Missing saml_sp_entity_id parameter');
  }

  // A resume never issues a nonce. The request keeps the hash it was sent to sign in with (only
  // the browser that was given that nonce can cancel it), and the nonce goes on the login URL only
  // when the one the Login UI presents matches it. A request stored before nonces stays without.
  const presentedNonce = url.searchParams.get('saml_login_nonce') ?? '';
  // Read, not used up: the request is checked again and used up only when the SP is answered.
  const storedRequest = await readStoredAuthnRequest(c.env, tenantId, requestId, spEntityId);
  // One refused as it arrived (it failed its signature, ACS or binding check) is never resumed:
  // a resume would take it as checked.
  if (storedRequest.context?.refusedOnArrival) {
    throw new Error('Stored SAML request was refused');
  }
  // A pending IdP-initiated sign-in is resumed only where it was started (idp-initiated.ts): the
  // Login UI sends every SAML sign-in back here, so it is sent on to that endpoint, which checks
  // it again. Nothing of it is answered here.
  if (storedRequest.context?.idpInitiated) {
    throw new IdPInitiatedResume(
      `/saml/idp/init?${new URLSearchParams({ sp: spEntityId, pending: requestId }).toString()}`
    );
  }
  const held = storedRequest.context?.loginNonceHash;
  const keptHash = typeof held === 'string' && held ? held : null;
  const matched =
    keptHash !== null &&
    isSAMLLoginNonce(presentedNonce) &&
    timingSafeEqual(keptHash, await hashSAMLLoginNonce(presentedNonce));
  return {
    resumedLogin:
      keptHash === null
        ? 'none'
        : matched
          ? { nonce: presentedNonce, hash: keptHash }
          : { hash: keptHash },
    authnRequest: storedRequest.data as SAMLAuthnRequest,
    relayState: storedRequest.relayState,
    binding: storedRequest.binding === 'post' ? 'post' : 'redirect',
    xml: '',
    storedRequestValidated: true,
    requestContext: storedRequest.context,
    storedRevision: storedRequest.revision,
  };
}

/**
 * Parse HTTP-POST binding parameters
 */
async function parsePostBinding(c: Context<{ Bindings: Env }>): Promise<{
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
  binding: 'post';
  xml: string;
}> {
  const formData = await parsePostBindingFormDataWithLimit(c.req);
  const samlRequest = formData.get('SAMLRequest') as string;
  const relayState = (formData.get('RelayState') as string) || undefined;
  assertSAMLRelayStateSize(relayState);

  if (!samlRequest) {
    throw new Error('Missing SAMLRequest parameter');
  }

  // Decode: Base64 decode only (no compression for POST binding)
  const xmlString = decodePostBindingMessage(samlRequest, 'SAML AuthnRequest');

  return {
    authnRequest: parseAuthnRequestXml(xmlString),
    relayState,
    binding: 'post',
    xml: xmlString,
  };
}

/**
 * Parse AuthnRequest XML into structured data
 */
export function parseAuthnRequestXml(xml: string): SAMLAuthnRequest {
  const doc = parseSAMLXml(xml);
  const authnRequestElement = doc.documentElement;

  if (
    !authnRequestElement ||
    authnRequestElement.namespaceURI !== SAML_NAMESPACES.SAML2P ||
    authnRequestElement.localName !== 'AuthnRequest'
  ) {
    throw new Error('Invalid AuthnRequest: missing AuthnRequest element');
  }

  const id = getAttribute(authnRequestElement, 'ID');
  const issueInstant = getAttribute(authnRequestElement, 'IssueInstant');
  const destination = getAttribute(authnRequestElement, 'Destination');
  const assertionConsumerServiceURL = getAttribute(
    authnRequestElement,
    'AssertionConsumerServiceURL'
  );
  const assertionConsumerServiceIndex = parseOptionalNonNegativeInteger(
    getAttribute(authnRequestElement, 'AssertionConsumerServiceIndex')
  );
  const protocolBinding = getAttribute(authnRequestElement, 'ProtocolBinding');
  const forceAuthnAttr = getAttribute(authnRequestElement, 'ForceAuthn');
  const isPassiveAttr = getAttribute(authnRequestElement, 'IsPassive');

  if (!id || !issueInstant) {
    throw new Error('Invalid AuthnRequest: missing required attributes');
  }

  // Parse Issuer
  const issuerElement = findDirectChildElement(
    authnRequestElement,
    SAML_NAMESPACES.SAML2,
    'Issuer'
  );
  const issuer = getTextContent(issuerElement);

  if (!issuer) {
    throw new Error('Invalid AuthnRequest: missing Issuer');
  }

  // Parse NameIDPolicy (optional)
  let nameIdPolicy: SAMLAuthnRequest['nameIdPolicy'] | undefined;
  const nameIdPolicyElement = findDirectChildElement(
    authnRequestElement,
    SAML_NAMESPACES.SAML2P,
    'NameIDPolicy'
  );
  if (nameIdPolicyElement) {
    const format = getAttribute(nameIdPolicyElement, 'Format');
    nameIdPolicy = {
      format: format as NonNullable<SAMLAuthnRequest['nameIdPolicy']>['format'],
      allowCreate: parseXmlBoolean(getAttribute(nameIdPolicyElement, 'AllowCreate')) ?? false,
      spNameQualifier: getAttribute(nameIdPolicyElement, 'SPNameQualifier') || undefined,
    };
  }
  const requestedAuthnContext = parseRequestedAuthnContext(authnRequestElement);

  return {
    id,
    issueInstant,
    destination: destination || undefined,
    assertionConsumerServiceURL: assertionConsumerServiceURL || undefined,
    assertionConsumerServiceIndex: assertionConsumerServiceIndex ?? undefined,
    protocolBinding: protocolBinding as SAMLAuthnRequest['protocolBinding'],
    issuer,
    nameIdPolicy,
    requestedAuthnContext,
    forceAuthn: parseXmlBoolean(forceAuthnAttr) ?? false,
    isPassive: parseXmlBoolean(isPassiveAttr) ?? false,
  };
}

/**
 * Validate AuthnRequest
 */
async function validateAuthnRequest(
  authnRequest: SAMLAuthnRequest,
  issuerUrl: string,
  requestTtlSeconds: number
): Promise<void> {
  // Check request is not expired (allow clock skew)
  const issueInstantMs = Date.parse(authnRequest.issueInstant);
  if (!Number.isFinite(issueInstantMs)) {
    throw new Error('AuthnRequest IssueInstant is invalid');
  }
  const nowMs = Date.now();
  const skewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
  const maxAge = requestTtlSeconds * 1000;

  if (issueInstantMs > nowMs + skewMs) {
    throw new Error('AuthnRequest IssueInstant is in the future');
  }

  if (nowMs - issueInstantMs > maxAge + skewMs) {
    throw new Error('AuthnRequest has expired');
  }

  // Validate Destination if present
  if (authnRequest.destination) {
    if (!isAllowedIdPSSODestination(authnRequest.destination, issuerUrl)) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Destination in SAML AuthnRequest');
    }
  }
}

function parseOptionalNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Check if user is authenticated (sharded)
 */
export async function checkUserAuthentication(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<AuthenticatedSAMLSession | null> {
  // Check for session cookie
  const sessionId = extractAuthrimSessionIdFromCookieHeader(c.req.header('Cookie'));

  if (!sessionId) {
    return null;
  }

  try {
    let session: {
      userId?: string;
      createdAt?: number;
      data?: Record<string, unknown>;
    } | null;
    if (env.SAML_RUNTIME_PORTS) {
      session = await env.SAML_RUNTIME_PORTS.sessions.get({
        tenantId: resolveSAMLTenantIdFromContext(c),
        sessionId,
      });
    } else {
      // Existing Cloudflare sessions are sharded and resolved through SessionStore.
      if (!isShardedSessionId(sessionId)) return null;
      const { stub: sessionStore } = getSessionStoreBySessionId(
        env,
        sessionId,
        resolveSAMLTenantIdFromContext(c)
      );
      const response = await sessionStore.fetch(`https://session-store/session/${sessionId}`, {
        method: 'GET',
      });
      if (!response.ok) return null;
      session = await response.json<{
        userId?: string;
        createdAt?: number;
        data?: Record<string, unknown>;
      }>();
    }
    if (!session) return null;
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
          provenAt: sessionProvenAt(data),
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
 * Generate SAML Response with Assertion
 */
async function generateSAMLResponse(
  idpEntityId: string,
  env: Env,
  authnRequest: SAMLAuthnRequest,
  spConfig: SAMLSPConfig,
  userInfo: SAMLUserInfo,
  tenantId: string,
  authSession: AuthenticatedSAMLSession,
  /** The attributes approved for release, and the NameID format chosen for the request. */
  release: { attributes: SAMLAttribute[]; nameIdFormat: NameIDFormat },
  log?: {
    debug(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>, error?: Error): void;
  },
  /** The class reference chosen for the AAL reached, and what the one issued is checked against. */
  assurance?: { classRef?: string; guard: SAMLClassRefGuard }
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
  const nameIdFormat = release.nameIdFormat;
  // Made only now, once the release is approved: a refused request makes no NameID.
  const nameIdValue = await resolveSAMLNameIDValue(userInfo, nameIdFormat, {
    tenantId,
    spEntityId: spConfig.entityId,
    // The NameID the SP's mapping makes, if it makes one (e.g. the one an earlier IdP issued).
    mappedNameID:
      nameIdFormat === NAMEID_FORMATS.PERSISTENT
        ? await resolveSAMLMappedNameID({ env, tenantId, idpEntityId, spConfig, userInfo })
        : undefined,
    pairwiseSalt: await resolveSAMLPairwiseSecret(env, tenantId),
    persistentRegistry: resolveSAMLPersistentNameIDRegistryStore(env),
    allowCreate: authnRequest.nameIdPolicy?.allowCreate ?? true,
    transientStore: resolveSAMLTransientNameIDStore(env),
    transientTtlSeconds: assertionTtlSeconds,
    sessionId: authSession.sessionId,
  });

  // Determine ACS URL
  const acsUrl = resolveSAMLResponseDestination(authnRequest, spConfig);

  const authnContextClassRef = chooseSAMLAuthnContextClassRef(
    authnRequest,
    {
      spConfig,
      session: {
        acr: authSession.acr,
        amr: authSession.amr,
      },
    },
    assurance
  );
  // AuthnInstant is when the person authenticated (a session reused for single sign-on keeps the
  // time of its sign-in), not the instant the assertion is issued.
  const issuedAt = new Date();
  const authnInstant = resolveSAMLAuthnInstant(authSession.data, {
    createdAt: authSession.createdAt,
    nowMs: issuedAt.getTime(),
  });
  if (authnInstant.source === 'unknown') {
    log?.debug('SAML authentication time unknown, using the issue instant for AuthnInstant', {
      tenantId,
      spEntityId: spConfig.entityId,
      authnRequestId: authnRequest.id,
    });
  }
  const timing = buildSAMLAssertionTiming({
    now: issuedAt,
    authenticatedAtMs: authnInstant.ms,
    assertionValiditySeconds: assertionTtlSeconds,
  });

  // Build SAML Response
  let responseXml = buildSAMLResponse({
    responseId: generateSAMLId(),
    assertionId: generateSAMLId(),
    issueInstant: timing.issueInstant,
    issuer: idpEntityId,
    destination: acsUrl,
    inResponseTo: authnRequest.id,
    recipientUrl: acsUrl,
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
    authnContextClassRef,
    attributes: release.attributes,
  });

  const encryptFullAssertion = Boolean(spConfig.encryptAssertions);
  const encryptNameIdOnly = !encryptFullAssertion && Boolean(spConfig.encryptNameID);

  assertSAMLResponseSigningPolicy(spConfig);

  if (encryptNameIdOnly) {
    responseXml = await applySAMLAssertionEncryptionPolicy(responseXml, spConfig);
  }

  if (spConfig.signAssertions) {
    responseXml = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: true, signResponses: false },
      { privateKeyPem, certificate }
    );
  }

  if (encryptFullAssertion) {
    responseXml = await applySAMLAssertionEncryptionPolicy(responseXml, spConfig);
  }

  if (spConfig.signResponses) {
    responseXml = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: false, signResponses: true },
      { privateKeyPem, certificate }
    );
  }

  return responseXml;
}

export async function generateSAMLProtocolErrorResponse(
  issuerUrl: string,
  idpEntityId: string,
  env: Env,
  authnRequest: SAMLAuthnRequest,
  spConfig: SAMLSPConfig,
  tenantId: string,
  statusCode: string,
  secondLevelStatusCode: string | undefined,
  statusMessage: string,
  failureKind?: string
): Promise<string> {
  assertSAMLResponseSigningPolicy(spConfig);
  const signingMaterial = await getSAMLIdPSigningMaterial(env, {
    tenantId,
    counterpartyEntityId: spConfig.entityId,
    providerPolicy: spConfig.signingKeyPolicy,
  });

  const resolvedStatus = applySAMLErrorResponseOverride(spConfig, {
    failureKind,
    statusCode,
    secondLevelStatusCode,
    statusMessage,
  });

  return buildSAMLIdPErrorResponse({
    issuer: idpEntityId,
    destination: resolveSAMLResponseDestination(authnRequest, spConfig),
    inResponseTo: authnRequest.id,
    statusCode: resolvedStatus.statusCode,
    secondLevelStatusCode: resolvedStatus.secondLevelStatusCode,
    statusMessage: resolvedStatus.statusMessage,
    spConfig,
    signingMaterial,
  });
}

/**
 * Send SAML Response to SP's ACS
 */
export function sendSAMLResponse(
  c: Context<{ Bindings: Env }>,
  acsUrl: string,
  responseXml: string,
  relayState?: string
): Response {
  // Encode response as Base64
  const encodedResponse = base64Encode(responseXml);
  const fields = [{ name: 'SAMLResponse', value: encodedResponse }];
  if (relayState) {
    assertSAMLRelayStateSize(relayState);
    fields.push({ name: 'RelayState', value: relayState });
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML SSO',
    actionUrl: acsUrl,
    fields,
    buttonText: 'Continue to Service Provider',
  });
}

/**
 * Create SAML error response
 */
function createErrorResponse(
  c: Context<{ Bindings: Env }>,
  message: string,
  statusCode: string
): Response {
  return c.json(
    {
      error: 'saml_error',
      message,
      status_code: statusCode,
    },
    400
  );
}

const TENANT_SAML_ATTRIBUTE_RELEASE_FAILURE_MESSAGE_MODE =
  'tenant.saml_attribute_release_failure_message_mode';
