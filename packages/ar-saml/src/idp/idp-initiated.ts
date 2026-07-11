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
  shouldUseBuiltinForms,
  createConfigurationError,
  usesNakedDomainIssuer,
  getLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveRuntimeIdentityMappingBinding,
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
  buildSAMLAttributesForSP,
  type SAMLIdentityMappingReleaseConfig,
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
import { buildSAMLAssertionTiming } from './assertion-timing';
import { extractAuthrimSessionIdFromCookieHeader } from '../common/session-cookie';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { resolveSAMLAuthnContextClassRef } from './authn-context';
import { getSAMLLocalEntityIds } from '../common/entity-id';

interface AuthenticatedSAMLSession {
  userId: string;
  sessionId: string;
  acr?: string;
  amr?: string[];
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

    // Check user authentication
    const authenticatedSession = await checkUserAuthentication(c, env);

    if (!authenticatedSession) {
      // Redirect to login with return URL
      const returnTo = `${issuerUrl}/saml/idp/init?sp=${encodeURIComponent(spEntityId)}`;

      // Conformance mode: use built-in login path
      if (await shouldUseBuiltinForms(env)) {
        const loginUrl = new URL('/flow/login', issuerUrl);
        loginUrl.searchParams.set('return_to', returnTo);
        return c.redirect(loginUrl.toString());
      }

      // Normal mode: use UI config
      const uiConfig = await getUIConfig(env);
      if (!uiConfig?.baseUrl) {
        return c.json(createConfigurationError(), 500);
      }

      const loginUrlPolicy = await getSAMLInteractiveLoginUrlPolicy(env, tenantId);
      const loginUrl =
        loginUrlPolicy === 'tenant_host'
          ? new URL(uiConfig.paths?.login || '/login', issuerUrl).toString()
          : buildUIUrl(
              uiConfig,
              'login',
              { return_to: returnTo },
              usesNakedDomainIssuer(env, tenantId) ? undefined : tenantId
            );
      if (loginUrlPolicy === 'tenant_host') {
        const tenantLoginUrl = new URL(loginUrl);
        tenantLoginUrl.searchParams.set('return_to', returnTo);
        return c.redirect(tenantLoginUrl.toString());
      }
      return c.redirect(loginUrl);
    }

    // Get user information
    const userInfo = await getUserInfo(env, tenantId, authenticatedSession.userId);
    if (!userInfo) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Generate SAML Response (no InResponseTo since this is IdP-initiated)
    const responseXml = await generateIdPInitiatedResponse(
      issuerUrl,
      idpEntityId,
      env,
      spConfig,
      userInfo,
      tenantId,
      authenticatedSession
    );

    // Return auto-submit form
    return sendSAMLResponse(spConfig, responseXml);
  } catch (error) {
    log.error('IdP-Initiated SSO Error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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

    const session = (await response.json()) as {
      userId?: string;
      data?: { acr?: unknown; amr?: unknown };
    };
    return session.userId
      ? {
          userId: session.userId,
          sessionId,
          acr: typeof session.data?.acr === 'string' ? session.data.acr : undefined,
          amr: Array.isArray(session.data?.amr)
            ? session.data.amr.filter((value): value is string => typeof value === 'string')
            : undefined,
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
  authSession: AuthenticatedSAMLSession
): Promise<string> {
  const { privateKeyPem, certificate } = await getSAMLIdPSigningMaterial(env, {
    tenantId,
    counterpartyEntityId: spConfig.entityId,
    providerPolicy: spConfig.signingKeyPolicy,
  });

  const nameIdFormat = spConfig.nameIdFormat || NAMEID_FORMATS.EMAIL;
  const nameIdValue = await resolveSAMLNameIDValue(userInfo, nameIdFormat, {
    tenantId,
    spEntityId: spConfig.entityId,
    pairwiseSalt: await resolveSAMLPairwiseSecret(env, tenantId),
    persistentRegistry: resolveSAMLPersistentNameIDRegistryStore(env),
    allowCreate: true,
    transientStore: resolveSAMLTransientNameIDStore(env),
    transientTtlSeconds: spConfig.assertionValiditySeconds || DEFAULTS.ASSERTION_VALIDITY_SECONDS,
    sessionId: authSession.sessionId,
  });

  // Build attributes from mapping
  const identityMapping = await resolveSAMLRuntimeIdentityMapping(
    env,
    tenantId,
    idpEntityId,
    spConfig
  );
  const attributes = buildSAMLAttributesForSP(userInfo, {
    ...spConfig,
    localEntityId: idpEntityId,
    identityMapping,
  });
  const timing = buildSAMLAssertionTiming({
    assertionValiditySeconds:
      spConfig.assertionValiditySeconds || DEFAULTS.ASSERTION_VALIDITY_SECONDS,
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
    authnContextClassRef: resolveSAMLAuthnContextClassRef(
      {
        id: responseId,
        issueInstant: timing.issueInstant,
        issuer: spConfig.entityId,
      },
      {
        spConfig,
        session: authSession,
      }
    ),
    attributes,
  });

  // Sign if required
  if (spConfig.signResponses || spConfig.signAssertions) {
    return applySAMLResponseSigningPolicy(responseXml, spConfig, { privateKeyPem, certificate });
  }

  return responseXml;
}

async function resolveSAMLRuntimeIdentityMapping(
  env: Env,
  tenantId: string,
  idpEntityId: string,
  spConfig: SAMLSPConfig
): Promise<SAMLIdentityMappingReleaseConfig | undefined> {
  const configured = spConfig.identityMapping as SAMLIdentityMappingReleaseConfig | undefined;
  if (configured?.catalog || configured?.defaultBinding || configured?.bindings?.length) {
    return configured;
  }

  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-identity-mapping');
  const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
    tenantId,
    protocol: 'saml',
    role: 'idp',
    fieldMappingSetId: configured?.fieldMappingSetId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
  });
  if (!binding) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.missing_identity_mapping_binding',
        severity: 'critical',
      },
    ]);
  }

  return {
    id: binding.id,
    role: 'idp',
    tenantId: binding.tenantId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
    catalog: binding.catalog,
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
    destinationNamespace: configured?.destinationNamespace ?? binding.destinationNamespace,
    attributeDescriptors: configured?.attributeDescriptors,
    fieldMappingSetId: binding.fieldMappingSetId,
    fieldMappingVersionId: binding.fieldMappingVersionId,
    sourceProfileId: configured?.sourceProfileId ?? binding.sourceProfileId,
    destinationProfileId: configured?.destinationProfileId ?? binding.destinationProfileId,
  };
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
