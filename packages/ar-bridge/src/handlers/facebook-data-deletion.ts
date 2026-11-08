/**
 * Facebook Login callbacks
 *
 * POST /auth/external/:provider/data-deletion          - Data Deletion Request Callback
 * POST /auth/external/:provider/deauthorize            - Deauthorize Callback
 * GET  /auth/external/:provider/data-deletion/:code    - The deletion request's status
 *
 * (each also under /api/external). Meta posts a `signed_request` (form field) signed with the
 * app secret; nothing is done for one that does not verify. Both callbacks unlink the person's
 * Facebook identity and erase what was received from Facebook (services/provider-data-deletion);
 * the Authrim account is kept. The deletion callback answers `{ url, confirmation_code }`: the
 * status URL Meta shows the person, public, keyed by the unguessable code, showing only the state.
 *
 * The answer never says whether the person had a link: no link is a completed request too.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  LoginMethodRemovalInProgressError,
  buildIssuerUrl,
  createAuditLog,
  createErrorResponse,
  getLogger,
  getTenantIdFromContext,
  isReplayJtiRecorded,
  recordReplayJti,
} from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';
import { isFacebookLoginProvider } from '../providers/facebook';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';
import {
  FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS,
  verifyFacebookSignedRequest,
} from '../utils/facebook-signed-request';
import {
  CONFIRMATION_CODE_PATTERN,
  createDataDeletionRequest,
  readDataDeletionRequestState,
  resolveSignedRequestMaxAgeSeconds,
  unlinkProviderSubject,
  type DataDeletionRequestState,
  type ProviderDataDeletionResult,
} from '../services/provider-data-deletion';
import { recordSocialAccountActivity } from '../services/link-intent';
import type { UpstreamProvider } from '../types';

type CallbackKind = 'data_deletion' | 'deauthorize';
type ModuleLogger = ReturnType<ReturnType<typeof getLogger>['module']>;

const AUDIT_ACTIONS: Record<CallbackKind, string> = {
  data_deletion: 'external_idp.data_deletion_requested',
  deauthorize: 'external_idp.deauthorized',
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalidRequest(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    { error: 'invalid_request', error_description: 'The signed request could not be verified.' },
    400
  );
}

/** The Facebook Login provider the path names, or null. */
async function resolveFacebookProvider(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<UpstreamProvider | null> {
  const idOrSlug = c.req.param('provider');
  if (!idOrSlug) return null;
  const provider = await getProviderByIdOrSlug(c.env, idOrSlug, tenantId);
  // A disabled provider still takes them: the person removed the app or wants their data gone.
  return provider && isFacebookLoginProvider(provider) ? provider : null;
}

async function readSignedRequest(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const contentType = c.req.header('Content-Type')?.toLowerCase() ?? '';
  if (
    !contentType.startsWith('application/x-www-form-urlencoded') &&
    !contentType.startsWith('multipart/form-data')
  ) {
    return null;
  }
  try {
    const body = await c.req.parseBody();
    const value = body['signed_request'];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

export function handleFacebookDataDeletion(c: Context<{ Bindings: Env }>): Promise<Response> {
  return handleSignedCallback(c, 'data_deletion');
}

export function handleFacebookDeauthorize(c: Context<{ Bindings: Env }>): Promise<Response> {
  return handleSignedCallback(c, 'deauthorize');
}

async function handleSignedCallback(
  c: Context<{ Bindings: Env }>,
  kind: CallbackKind
): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  c.header('Cache-Control', 'no-store');
  const tenantId = getTenantIdFromContext(c);

  let provider: UpstreamProvider | null;
  try {
    provider = await resolveFacebookProvider(c, tenantId);
  } catch (error) {
    log.error('Facebook callback: provider lookup failed', { kind }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  if (!provider) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  const signedRequest = await readSignedRequest(c);
  if (!signedRequest) return invalidRequest(c);

  let appSecret: string;
  try {
    const key = getEncryptionKeyOrUndefined(c.env);
    if (!key || !provider.clientSecretEncrypted) throw new Error('app_secret_unavailable');
    appSecret = await decrypt(provider.clientSecretEncrypted, key);
  } catch (error) {
    // Without the app secret nothing can be verified: never act on an unverified request.
    log.error('Facebook callback: app secret unavailable', {
      kind,
      providerId: provider.id,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const maxAgeSeconds = await resolveSignedRequestMaxAgeSeconds(c.env, tenantId);
  const verified = await verifyFacebookSignedRequest(signedRequest, appSecret, {
    nowSeconds: Math.floor(Date.now() / 1000),
    maxAgeSeconds,
  });
  if (!verified.ok) {
    log.warn('Facebook callback: signed request rejected', {
      kind,
      providerId: provider.id,
      reason: verified.error,
    });
    return invalidRequest(c);
  }

  // Each signed request is acted on once: a copy sent again within its max age (after the person
  // linked Facebook again, say) is refused. It is recorded only once processed, so a request
  // answered "retry" (503) can be sent again. Two copies at once both run the same idempotent
  // unlink (the saga's operation id is the link's).
  // Keyed on the signed payload as Meta encoded it (padding aside), not the whole string: the
  // signature's encoding can vary without changing what was signed. Each callback answers a
  // payload once (Meta may send the same one to both); the unlink is done once per payload,
  // whichever callback did it.
  const payloadDigest = await sha256Hex(
    signedRequest.slice(signedRequest.indexOf('.') + 1).replace(/=+$/u, '')
  );
  const replay = {
    tenantId,
    shardKey: provider.id,
    jti: `facebook-${kind}:${provider.id}:${payloadDigest}`,
  };
  const unlinkDone = {
    tenantId,
    shardKey: provider.id,
    jti: `facebook-unlink:${provider.id}:${payloadDigest}`,
  };
  let mayRemoveLink: boolean;
  try {
    if (await isReplayJtiRecorded(c.env, replay)) {
      log.warn('Facebook callback: signed request replayed', { kind, providerId: provider.id });
      return invalidRequest(c);
    }
    mayRemoveLink = !(await isReplayJtiRecorded(c.env, unlinkDone));
  } catch (error) {
    log.error('Facebook callback: replay store unavailable', { kind }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  let result: ProviderDataDeletionResult;
  try {
    result = await unlinkProviderSubject(c.env, {
      tenantId,
      providerId: provider.id,
      providerUserId: verified.userId,
      requestIssuedAt: verified.issuedAt,
      mayRemoveLink,
      payloadGuard: {
        alreadyRemoved: () => isReplayJtiRecorded(c.env, unlinkDone),
        markRemoved: async () => {
          await recordReplayJti(c.env, {
            ...unlinkDone,
            issuedAt: verified.issuedAt,
            ttlSeconds: maxAgeSeconds + FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS,
          }).catch((error: unknown) => {
            // The link is removed: the answer stands; only a later copy is less guarded.
            log.error('Facebook callback: unlink record failed', { kind }, error as Error);
          });
        },
      },
    });
  } catch (error) {
    if (
      error instanceof LoginMethodRemovalInProgressError ||
      (error instanceof Error && error.message === 'login_method_removal_in_progress')
    ) {
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Another change to the account is in progress; retry shortly.',
        },
        503
      );
    }
    log.error(
      'Facebook callback: unlink failed',
      { kind, providerId: provider.id },
      error as Error
    );
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  if (result.outcome === 'account_inactive') {
    // Suspended, locked or being deleted: the unlink cannot run, and nothing was erased. Never
    // answered as done. A retry must come within the signed request's max age (a later one needs
    // a new signed request), so the retry delay stays well inside the shortest allowed (60 s).
    await recordCallbackAudit(c, log, { tenantId, kind, provider, result });
    c.header('Retry-After', '30');
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The request cannot be processed now; retry later.',
      },
      503
    );
  }

  let confirmationCode: string | undefined;
  let state: DataDeletionRequestState | undefined;
  if (kind === 'data_deletion') {
    try {
      ({ confirmationCode, state } = await createDataDeletionRequest(c.env, {
        tenantId,
        providerId: provider.id,
        result,
      }));
    } catch (error) {
      // The unlink stands; a repeated request finds no link and is recorded then.
      log.error(
        'Facebook callback: status record failed',
        { providerId: provider.id },
        error as Error
      );
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  }

  try {
    const ttl = {
      issuedAt: verified.issuedAt,
      ttlSeconds: maxAgeSeconds + FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS,
    };
    // A hold kept the link: a copy after the hold is released may still remove it.
    if (result.outcome !== 'retained') await recordReplayJti(c.env, { ...unlinkDone, ...ttl });
    await recordReplayJti(c.env, { ...replay, ...ttl });
  } catch (error) {
    // Processed already: the answer stands (a copy sent again repeats an idempotent unlink).
    log.error('Facebook callback: replay record failed', { kind }, error as Error);
  }
  await recordCallbackAudit(c, log, { tenantId, kind, provider, result, confirmationCode, state });
  if (result.linkedIdentityId && result.userId && result.outcome !== 'retained') {
    await recordSocialAccountActivity(c, result.userId, 'account.social_account.unlinked', {
      linkedIdentityId: result.linkedIdentityId,
      providerId: provider.id,
      reason: kind === 'data_deletion' ? 'provider_data_deletion' : 'provider_deauthorize',
    });
  }

  log.info('Facebook callback processed', {
    kind,
    providerId: provider.id,
    outcome: result.outcome,
  });
  if (!confirmationCode) return new Response(null, { status: 200 });
  return c.json({
    url: dataDeletionStatusUrl(c.env, tenantId, provider, confirmationCode),
    confirmation_code: confirmationCode,
  });
}

function dataDeletionStatusUrl(
  env: Env,
  tenantId: string,
  provider: UpstreamProvider,
  confirmationCode: string
): string {
  return `${buildIssuerUrl(env, tenantId)}/auth/external/${encodeURIComponent(
    provider.slug || provider.id
  )}/data-deletion/${confirmationCode}`;
}

/**
 * The request in the tenant's audit log: who it concerned (the account's user id, never the
 * Facebook id), what was done, and the confirmation code to match the person's enquiry.
 */
async function recordCallbackAudit(
  c: Context<{ Bindings: Env }>,
  log: ModuleLogger,
  input: {
    tenantId: string;
    kind: CallbackKind;
    provider: UpstreamProvider;
    result: ProviderDataDeletionResult;
    confirmationCode?: string;
    state?: DataDeletionRequestState;
  }
): Promise<void> {
  const { result } = input;
  try {
    await createAuditLog(c.env, {
      tenantId: input.tenantId,
      // A server-to-server notice from the provider: no user request applies.
      userId: 'system',
      action: AUDIT_ACTIONS[input.kind],
      resource: 'upstream_provider',
      resourceId: input.provider.id,
      ipAddress: '',
      userAgent: '',
      metadata: JSON.stringify({
        provider_id: input.provider.id,
        outcome: result.outcome,
        ...(result.userId ? { user_id: result.userId } : {}),
        ...(result.linkedIdentityId ? { linked_identity_id: result.linkedIdentityId } : {}),
        ...(result.unlinkOperationId ? { unlink_operation_id: result.unlinkOperationId } : {}),
        ...(result.attention ? { attention: result.attention } : {}),
        // A digest, not the code: whoever reads the audit log cannot use it at the status URL,
        // and a code a person quotes is matched by hashing it (SHA-256, hex).
        ...(input.confirmationCode
          ? {
              confirmation_code_sha256: await sha256Hex(input.confirmationCode),
              status: input.state,
            }
          : {}),
      }),
      // Data the person asked to have erased is kept (a hold, an inactive account, a stopped
      // unlink), or a hold was placed while it was erased: the administrator decides.
      severity:
        result.outcome === 'retained' || result.outcome === 'account_inactive' || result.attention
          ? 'warning'
          : 'info',
    });
  } catch (error) {
    log.error(
      'Facebook callback: audit log failed',
      { kind: input.kind, outcome: result.outcome },
      error as Error
    );
  }
}

// =============================================================================
// Status
// =============================================================================

/**
 * The state the public status shows. A request a legal hold keeps (`retained`) shows a neutral
 * state that gives no reason: whether a hold exists, and why, is for the operator to tell.
 */
export type PublicDataDeletionStatus = 'pending' | 'completed' | 'operator_action_required';

export function publicDataDeletionStatus(
  state: DataDeletionRequestState
): PublicDataDeletionStatus {
  return state === 'retained' ? 'operator_action_required' : state;
}

const STATUS_MESSAGES: Record<PublicDataDeletionStatus, string> = {
  pending: 'Your request is being processed. The data received from Facebook is being removed.',
  completed:
    'Your request is complete. The data received from Facebook has been deleted, and Facebook is no longer linked for signing in.',
  operator_action_required:
    'This request requires individual handling by the service operator. Contact the service operator for details.',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function wantsJson(c: Context<{ Bindings: Env }>): boolean {
  const accept = c.req.header('Accept')?.toLowerCase() ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

/** GET /auth/external/:provider/data-deletion/:code */
export async function handleFacebookDataDeletionStatus(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
  const tenantId = getTenantIdFromContext(c);
  const code = c.req.param('code') ?? '';
  if (!CONFIRMATION_CODE_PATTERN.test(code)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  let state: DataDeletionRequestState | null;
  try {
    const provider = await resolveFacebookProvider(c, tenantId);
    state = provider
      ? await readDataDeletionRequestState(c.env, {
          tenantId,
          providerId: provider.id,
          confirmationCode: code,
        })
      : null;
  } catch (error) {
    log.error('Facebook data deletion status lookup failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  if (!state) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  const status = publicDataDeletionStatus(state);
  if (wantsJson(c)) return c.json({ confirmation_code: code, status });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Data deletion request</title>
</head>
<body>
<main>
<h1>Data deletion request</h1>
<p>Confirmation code: <code>${escapeHtml(code)}</code></p>
<p>Status: <strong>${escapeHtml(status.replace(/_/gu, ' '))}</strong></p>
<p>${escapeHtml(STATUS_MESSAGES[status])}</p>
</main>
</body>
</html>`;
  return c.html(html);
}
