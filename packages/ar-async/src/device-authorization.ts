/**
 * Device Authorization Handler
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata, ClientMetadata } from '@authrim/ar-lib-core';
import {
  generateDeviceCode,
  generateUserCode,
  getVerificationUriComplete,
  resolveDeviceFlowPolicy,
  type DeviceFlowPolicy,
  getClientCached,
  createErrorResponse,
  AR_ERROR_CODES,
  // UI Configuration
  getUIConfig,
  buildRequestIssuerUrl,
  getLogger,
  buildDOInstanceName,
} from '@authrim/ar-lib-core';
import { resolveAsyncTenantId } from './tenant';
import { fal3Refusal } from './assurance';
import {
  authenticateDeviceClient,
  deviceAuthorizationError,
  invalidClientResponse,
  readDeviceAuthorizationForm,
  resolveDeviceScope,
} from './device-authorization-request';
import { spendClientBudget, spendIpBudget } from './device-authorization-rate-limit';

/** Times a user code is drawn before the request gives up (each draw collides with a live code). */
const USER_CODE_ATTEMPTS = 5;

/**
 * POST /device_authorization
 * Device Authorization Endpoint
 *
 * Issues device_code and user_code for device flow
 */
export async function deviceAuthorizationHandler(c: Context<{ Bindings: Env }>) {
  let response: Response;
  try {
    response = await issueDeviceAuthorization(c);
  } catch (error) {
    getLogger(c)
      .module('DEVICE')
      .error('Device authorization error', { action: 'authorization' }, error as Error);
    response = deviceAuthorizationError(
      c,
      'server_error',
      'The request could not be processed.',
      500
    );
  }
  return withNoStore(response);
}

/**
 * Every answer of this endpoint is uncacheable (RFC 8628 section 3.2 and RFC 6749 section 5.1/5.2:
 * the success answer carries the device code, an error may not be replayed either). Set here, on
 * whatever the steps above returned (the rate limits, the FAL3 refusal, an unknown tenant too),
 * so no early answer can miss them.
 */
function withNoStore(response: Response): Response {
  const set = (target: Response) => {
    target.headers.set('Cache-Control', 'no-store');
    target.headers.set('Pragma', 'no-cache');
    return target;
  };
  try {
    return set(response);
  } catch {
    // headers of a response that came from a fetch are immutable: copy it
    return set(new Response(response.body, response));
  }
}

async function issueDeviceAuthorization(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DEVICE');
  const tenantId = resolveAsyncTenantId(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant context' },
    });
  }
  // The per-IP budget comes first: a flood costs no settings read, body parsing or client lookup
  const ipBudget = await spendIpBudget(c, tenantId);
  if ('refusal' in ipBudget) return ipBudget.refusal;
  const assuranceRefusal = await fal3Refusal(c, tenantId);
  if (assuranceRefusal) return assuranceRefusal;

  try {
    const request = await readDeviceAuthorizationForm(c);
    if (!request.ok) return request.response;
    const { clientAuth, clientId: client_id } = request.form;

    // The client must be registered. A client that does not exist and one that fails to
    // authenticate get the same answer.
    const clientMetadata = (await getClientCached(
      c,
      c.env,
      client_id
    )) as unknown as ClientMetadata | null;
    if (!clientMetadata) {
      return invalidClientResponse(c);
    }

    // RFC 8628 section 3.1: a confidential client, or one that was issued credentials,
    // authenticates as it does at the token endpoint; a public client sends its client_id only.
    if (!(await authenticateDeviceClient(c, tenantId, clientMetadata, clientAuth))) {
      log.warn('Device authorization client authentication failed', {
        action: 'client_authentication',
        clientId: client_id,
      });
      return invalidClientResponse(c);
    }

    // Only an authenticated client learns whether it may use the grant
    const grantTypes = clientMetadata.grant_types as string[] | undefined;
    if (grantTypes && !grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return deviceAuthorizationError(
        c,
        'unauthorized_client',
        'The client is not authorized to use this grant type.',
        400
      );
    }

    const clientBudget = await spendClientBudget(c, tenantId, client_id);
    if ('refusal' in clientBudget) return clientBudget.refusal;

    const resolvedScope = resolveDeviceScope(clientMetadata, request.form.scope);
    if (!resolvedScope.ok) {
      return deviceAuthorizationError(c, 'invalid_scope', resolvedScope.description, 400);
    }
    const scope = resolvedScope.scope;

    // The lifetime, polling interval, poll limits and user code format of the tenant and this client. Read only
    // for a client that exists and may use the grant, so a request that names a stranger's
    // client_id cannot probe the settings. Settings that cannot be read stop the request like the
    // assurance settings above.
    let policy: DeviceFlowPolicy;
    try {
      policy = await resolveDeviceFlowPolicy(c.env, tenantId, client_id);
    } catch (error) {
      log.error(
        'Failed to load device flow settings',
        { action: 'device_flow_settings' },
        error as Error
      );
      return deviceAuthorizationError(
        c,
        'temporarily_unavailable',
        'Device flow settings are temporarily unavailable',
        503
      );
    }

    // Generate device code (the user code is generated below, in the tenant's format, and again if
    // it is taken)
    const deviceCode = generateDeviceCode();

    // Create device code metadata
    const now = Date.now();
    const expiresIn = policy.expiresIn;
    const interval = policy.pollInterval;

    // Store in DeviceCodeStore Durable Object
    // NOTE: Currently using global DO. Future: implement region-sharding with
    // KV-based user_code→device_code index for reverse lookups.
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName(
      buildDOInstanceName('device', tenantId)
    );
    const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

    // The store refuses a user code another live device code holds (409): draw another and try
    // again. The retries are bounded; a tenant whose live codes crowd the code space gets a
    // retryable 503 and nothing about the codes it holds.
    let userCode = '';
    let stored = false;
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS && !stored; attempt++) {
      userCode = generateUserCode(policy);
      const metadata: DeviceCodeMetadata = {
        tenant_id: tenantId,
        device_code: deviceCode,
        user_code: userCode,
        client_id,
        scope,
        status: 'pending',
        created_at: now,
        expires_at: now + expiresIn * 1000,
        poll_count: 0,
        // The polling interval is kept on the code: slow_down raises it for this code only
        interval,
        // slow_down can raise this code's interval no higher than the tenant's limit of now
        max_interval: policy.maxInterval,
        // the poll governor reads these from the code, so a poll needs no settings read
        slow_down_increment: policy.slowDownIncrement,
        max_poll_count: policy.maxPollCount,
      };

      const storeResponse = await deviceCodeStore.fetch(
        new Request('https://internal/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenantId },
          body: JSON.stringify(metadata),
        })
      );

      if (storeResponse.status === 409) {
        continue;
      }
      if (!storeResponse.ok) {
        const error = await storeResponse.json();
        log.error(
          'DeviceCodeStore error',
          { action: 'store_device_code' },
          new Error(JSON.stringify(error))
        );
        return deviceAuthorizationError(
          c,
          'server_error',
          'The device code could not be issued.',
          500
        );
      }
      stored = true;
    }

    if (!stored) {
      log.error('No free user code found', {
        action: 'store_device_code',
        attempts: USER_CODE_ATTEMPTS,
      });
      return deviceAuthorizationError(
        c,
        'temporarily_unavailable',
        'The device code could not be issued. Retry shortly.',
        503,
        { 'Retry-After': '1' }
      );
    }

    // Build verification URIs
    // Use UI config if available (for external UI), otherwise fall back to ISSUER_URL
    // tenant_hint is added to verification_uri_complete for UX branding (untrusted, security is via Host header)
    const uiConfig = await getUIConfig(c.env, tenantId);
    let verificationBaseUrl: string;

    if (uiConfig?.baseUrl) {
      // External UI configured - use UI base URL with device path
      const devicePath = uiConfig.paths?.device || '/device';
      verificationBaseUrl = `${uiConfig.baseUrl}${devicePath}`;
    } else {
      // No external UI - use issuer URL (conformance mode or default)
      const issuer = buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
      verificationBaseUrl = `${issuer}/device`;
    }

    const verificationUri = verificationBaseUrl;
    // Add tenant_hint to verification_uri_complete for UI branding (UX only, untrusted)
    const verificationUriComplete = getVerificationUriComplete(
      verificationBaseUrl,
      userCode,
      tenantId
    );

    log.info('Device authorization issued', {
      action: 'device_code_issued',
      clientId: client_id,
      scope,
      expiresIn,
    });

    // Return device authorization response (the codes are secrets: never cached)
    return c.json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: verificationUriComplete,
        expires_in: expiresIn,
        interval,
      },
      200,
      ipBudget.headers
    );
  } catch (error) {
    log.error('Device authorization error', { action: 'authorization' }, error as Error);
    return deviceAuthorizationError(c, 'server_error', 'The request could not be processed.', 500);
  }
}
