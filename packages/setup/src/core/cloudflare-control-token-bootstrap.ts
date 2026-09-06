import { createHash } from 'node:crypto';
import { execa } from 'execa';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const TOKEN_ID = /^[0-9a-f]{32}$/u;
const SAFE_ENV = /^[a-z][a-z0-9-]{0,31}$/u;
const ACCOUNT_RESOURCE_PREFIX = 'com.cloudflare.api.account.';
const CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
const CHILD_TOKEN_CREATE_RECONCILIATION_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const CONTROL_SECRET_GENERATION_RECONCILIATION_DELAYS_MS = [100, 250, 500, 1_000] as const;
const CONTROL_SECRET_INVENTORY_RETRY_DELAYS_MS = [100, 250, 500] as const;
const TOKEN_CAPABILITY_PROBE_RETRY_DELAYS_MS = [100, 250, 500] as const;
const DEFAULT_TOKEN_API_ATTEMPT_TIMEOUT_MS = 30_000;
const DEFAULT_TOKEN_API_OPERATION_TIMEOUT_MS = 150_000;
const DEFAULT_WRANGLER_SECRET_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_WRANGLER_SECRET_OPERATION_TIMEOUT_MS = 300_000;
const TOKEN_INVENTORY_PAGE_SIZE = 50;
const MAX_TOKEN_INVENTORY_PAGES = 100;
const MAX_TOKEN_INVENTORY_RECORDS = TOKEN_INVENTORY_PAGE_SIZE * MAX_TOKEN_INVENTORY_PAGES;

interface OperationDeadline {
  readonly expiresAt: number;
}

class OperationDeadlineExceededError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OperationDeadlineExceededError';
  }
}

function requiredTimeoutMs(value: number | undefined, fallback: number): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('cloudflare_token_timeout_invalid');
  }
  return timeoutMs;
}

function createOperationDeadline(timeoutMs: number): OperationDeadline {
  return { expiresAt: Date.now() + timeoutMs };
}

function remainingDeadlineMs(deadline: OperationDeadline): number {
  return Math.max(deadline.expiresAt - Date.now(), 0);
}

async function runWithinDeadline<T>(input: {
  deadline: OperationDeadline;
  attemptTimeoutMs: number;
  timeoutCode: string;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const remainingMs = remainingDeadlineMs(input.deadline);
  if (remainingMs <= 0) throw new OperationDeadlineExceededError(input.timeoutCode);
  const timeoutMs = Math.max(1, Math.min(input.attemptTimeoutMs, remainingMs));
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new OperationDeadlineExceededError(input.timeoutCode));
    }, timeoutMs);
  });
  try {
    return await Promise.race([input.operation(controller.signal), timeout]);
  } catch (error) {
    if (timedOut || remainingDeadlineMs(input.deadline) <= 0) {
      throw new OperationDeadlineExceededError(input.timeoutCode);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function waitWithinDeadline(
  delayMs: number,
  deadline: OperationDeadline,
  timeoutCode: string
): Promise<void> {
  if (delayMs <= 0) {
    if (remainingDeadlineMs(deadline) <= 0) {
      throw new OperationDeadlineExceededError(timeoutCode);
    }
    return;
  }
  // Do not race two timers whose deadlines differ by only one millisecond. Under load the timeout
  // timer can win even though the intended retry delay completed in the same event-loop turn,
  // turning a transient provider response into a false terminal failure. Reserve the delay from
  // the operation deadline first and verify the deadline again after waking.
  if (remainingDeadlineMs(deadline) <= delayMs) {
    throw new OperationDeadlineExceededError(timeoutCode);
  }
  await waitForTokenApiRetry(delayMs);
  if (remainingDeadlineMs(deadline) <= 0) {
    throw new OperationDeadlineExceededError(timeoutCode);
  }
}

async function fetchWithinDeadline<T>(input: {
  fetcher: typeof fetch;
  url: string;
  init?: Parameters<typeof fetch>[1];
  deadline: OperationDeadline;
  attemptTimeoutMs: number;
  timeoutCode: string;
  consume: (response: Response) => Promise<T> | T;
}): Promise<T> {
  return runWithinDeadline({
    deadline: input.deadline,
    attemptTimeoutMs: input.attemptTimeoutMs,
    timeoutCode: input.timeoutCode,
    operation: async (signal) => {
      const response = await input.fetcher(input.url, { ...input.init, signal });
      return input.consume(response);
    },
  });
}

function isRetryableTokenApiStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function waitForTokenApiRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function tokenApiHttpStatus(error: unknown): number | null {
  if (!(error instanceof CloudflareTokenBootstrapError)) return null;
  const match = /^cloudflare_token_api_http_(\d{3})$/u.exec(error.code);
  return match ? Number(match[1]) : null;
}

function isIndeterminateTokenApiError(error: unknown): boolean {
  if (!(error instanceof CloudflareTokenBootstrapError)) return false;
  if (
    error.code === 'cloudflare_token_api_response_lost' ||
    error.code === 'cloudflare_child_token_create_outcome_unconfirmed' ||
    error.code === 'cloudflare_child_token_create_transient'
  ) {
    return true;
  }
  const status = tokenApiHttpStatus(error);
  return status !== null && isRetryableTokenApiStatus(status);
}

export type CloudflareTokenOwnership = 'account' | 'user';
export type ControlTokenResourceClass = 'd1' | 'workers' | 'kv' | 'r2';
type CloudflareTokenCapability = 'allowed' | 'denied';
export type ControlTokenSecretName =
  | 'CLOUDFLARE_D1_API_TOKEN'
  | 'CLOUDFLARE_WORKERS_API_TOKEN'
  | 'CLOUDFLARE_KV_API_TOKEN'
  | 'CLOUDFLARE_R2_API_TOKEN';

export interface CloudflareTokenCapabilityDiagnostic {
  issuedFor: ControlTokenResourceClass;
  probes: Readonly<Record<ControlTokenResourceClass, CloudflareTokenCapability>>;
}

export interface CloudflareTokenPermissionGroup {
  id: string;
  name: string;
  scopes: readonly string[];
}

export interface CloudflareTokenPolicy {
  effect: 'allow' | 'deny';
  permission_groups: readonly { id: string; name?: string }[];
  resources: Readonly<Record<string, string>>;
}

export interface CloudflareTokenRecord {
  id: string;
  name: string;
  status: 'active' | 'disabled' | 'expired';
  policies: readonly CloudflareTokenPolicy[];
  expires_on?: string;
  issued_on?: string;
  not_before?: string;
  value?: string;
}

export interface CloudflareTokenAuthority {
  verifySelf(): Promise<{ id: string; status: 'active' | 'disabled' | 'expired' } | null>;
  getToken(tokenId: string): Promise<CloudflareTokenRecord | null>;
  listTokens(): Promise<readonly CloudflareTokenRecord[]>;
  listPermissionGroups(
    scope?: 'com.cloudflare.api.account' | 'com.cloudflare.api.user'
  ): Promise<readonly CloudflareTokenPermissionGroup[]>;
  createToken(input: {
    name: string;
    policies: readonly CloudflareTokenPolicy[];
  }): Promise<CloudflareTokenRecord>;
  deleteToken(tokenId: string): Promise<void>;
  verifyIssuedToken(
    token: string
  ): Promise<{ id: string; status: 'active' | 'disabled' | 'expired' } | null>;
  probeIssuedToken(
    token: string,
    resourceClass: ControlTokenResourceClass
  ): Promise<CloudflareTokenCapability>;
}

export interface ControlSecretSink {
  putGeneration(
    secrets: Readonly<Partial<Record<ControlTokenSecretName, string>>>,
    generationTag: string
  ): Promise<ControlSecretGenerationReceipt>;
  listNames?(): Promise<readonly string[]>;
  has(secretName: string): Promise<boolean>;
  delete(secretName: string): Promise<void>;
  readActiveGeneration?(): Promise<ControlSecretGenerationReceipt>;
  /** Read-only proof that a checkpointed immutable version is still deployable. */
  canActivateGeneration?(generation: ControlSecretGenerationReceipt): Promise<boolean>;
  /** Restore one exact checkpointed immutable version and confirm it is serving 100% traffic. */
  activateGeneration?(
    generation: ControlSecretGenerationReceipt
  ): Promise<ControlSecretGenerationReceipt>;
}

export interface ControlSecretGenerationReceipt {
  deploymentId: string;
  versionId: string;
}

export interface ControlTokenBootstrapResult {
  ownership: CloudflareTokenOwnership;
  bootstrapTokenId: string;
  bootstrapRevoked: true;
  childTokens: readonly {
    resourceClass: ControlTokenResourceClass;
    tokenId: string;
    tokenName: string;
    secretName: string;
    tokenFingerprint: string;
  }[];
  secretGeneration: ControlSecretGenerationReceipt;
}

export interface DirectControlTokenEvidence {
  ownership: CloudflareTokenOwnership;
  childTokens: readonly {
    resourceClass: 'd1' | 'workers';
    tokenId: string;
    /** An explicit local label; operator-managed token names are not readable through verify. */
    tokenName: string;
    secretName: 'CLOUDFLARE_D1_API_TOKEN' | 'CLOUDFLARE_WORKERS_API_TOKEN';
    tokenFingerprint: string;
  }[];
}

export type ControlTokenBootstrapPreparedResult = Omit<
  ControlTokenBootstrapResult,
  'bootstrapRevoked'
> & {
  bootstrapRevoked: false;
};

export class CloudflareTokenBootstrapError extends Error {
  constructor(
    readonly code: string,
    readonly cleanupRequired: boolean = false,
    readonly capabilityDiagnostic?: CloudflareTokenCapabilityDiagnostic,
    readonly bootstrapRetainedForRetry: boolean = false
  ) {
    super(code);
    this.name = 'CloudflareTokenBootstrapError';
  }
}

function requiredAccountId(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error('cloudflare_bootstrap_account_id_invalid');
  return accountId;
}

function requiredEnvironment(environment: string): string {
  if (!SAFE_ENV.test(environment)) throw new Error('cloudflare_bootstrap_environment_invalid');
  return environment;
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function deterministicTokenName(accountId: string, environment: string, suffix: string): string {
  return `authrim-${requiredEnvironment(environment)}-${requiredAccountId(accountId).slice(0, 8)}-${suffix}`.slice(
    0,
    120
  );
}

export function buildCloudflareBootstrapTokenName(input: {
  accountId: string;
  environment: string;
}): string {
  return deterministicTokenName(input.accountId, input.environment, 'bootstrap');
}

/**
 * Cloudflare token template URLs do not support TTL fields, and Dashboard dates expire at 00:00
 * UTC. Recommend the date after tomorrow so a newly created token has between 24 and 48 hours of
 * fallback lifetime. Setup does not enforce this recommendation and revokes the token after use.
 */
export function buildCloudflareBootstrapTokenEndDate(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('cloudflare_bootstrap_token_end_date_invalid');
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2))
    .toISOString()
    .slice(0, 10);
}

export function buildCloudflareChildTokenName(input: {
  accountId: string;
  environment: string;
  resourceClass: ControlTokenResourceClass;
}): string {
  return deterministicTokenName(
    input.accountId,
    input.environment,
    `control-${input.resourceClass}`
  );
}

export function buildCloudflareBootstrapTemplateUrl(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
}): string {
  const accountId = requiredAccountId(input.accountId);
  const permissionGroupKeys = JSON.stringify([
    {
      key: input.ownership === 'account' ? 'account_api_tokens' : 'api_tokens',
      type: 'edit',
    },
  ]);
  const url = new URL(
    input.ownership === 'account'
      ? 'https://dash.cloudflare.com/'
      : 'https://dash.cloudflare.com/profile/api-tokens'
  );
  if (input.ownership === 'account') {
    url.searchParams.set('to', '/:account/api-tokens');
  } else {
    url.searchParams.set('accountId', accountId);
    url.searchParams.set('zoneId', 'all');
  }
  url.searchParams.set('permissionGroupKeys', permissionGroupKeys);
  url.searchParams.set(
    'name',
    buildCloudflareBootstrapTokenName({ accountId, environment: input.environment })
  );
  return url.toString();
}

async function probeScopedToken(input: {
  fetcher: typeof fetch;
  accountId: string;
  token: string;
  resource: ControlTokenResourceClass;
  deadline?: OperationDeadline;
  tokenApiAttemptTimeoutMs?: number;
  tokenApiOperationTimeoutMs?: number;
}): Promise<CloudflareTokenCapability> {
  const attemptTimeoutMs = requiredTimeoutMs(
    input.tokenApiAttemptTimeoutMs,
    DEFAULT_TOKEN_API_ATTEMPT_TIMEOUT_MS
  );
  const deadline =
    input.deadline ??
    createOperationDeadline(
      requiredTimeoutMs(input.tokenApiOperationTimeoutMs, DEFAULT_TOKEN_API_OPERATION_TIMEOUT_MS)
    );
  const path = {
    d1: `/accounts/${input.accountId}/d1/database?per_page=1`,
    workers: `/accounts/${input.accountId}/workers/scripts?per_page=1`,
    kv: `/accounts/${input.accountId}/storage/kv/namespaces?per_page=1`,
    r2: `/accounts/${input.accountId}/r2/buckets?per_page=1`,
  }[input.resource];
  for (let attempt = 0; ; attempt += 1) {
    let status: number;
    try {
      status = await fetchWithinDeadline({
        fetcher: input.fetcher,
        url: `${API_BASE}${path}`,
        init: {
          headers: { Authorization: `Bearer ${input.token}` },
          redirect: 'error',
        },
        deadline,
        attemptTimeoutMs,
        timeoutCode: 'cloudflare_token_capability_probe_timeout',
        consume: (response) => response.status,
      });
    } catch {
      const delayMs = TOKEN_CAPABILITY_PROBE_RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        try {
          await waitWithinDeadline(delayMs, deadline, 'cloudflare_token_capability_probe_timeout');
          continue;
        } catch {
          // The bounded operation is exhausted and is reported below as unavailable.
        }
      }
      throw new CloudflareTokenBootstrapError('cloudflare_token_capability_probe_unavailable');
    }
    if (status >= 200 && status < 300) return 'allowed';
    if (status === 401 || status === 403) return 'denied';
    const delayMs = TOKEN_CAPABILITY_PROBE_RETRY_DELAYS_MS[attempt];
    if (isRetryableTokenApiStatus(status) && delayMs !== undefined) {
      try {
        await waitWithinDeadline(delayMs, deadline, 'cloudflare_token_capability_probe_timeout');
        continue;
      } catch {
        // The bounded operation is exhausted and is reported below as unavailable.
      }
    }
    throw new CloudflareTokenBootstrapError('cloudflare_token_capability_probe_unavailable');
  }
}

async function inspectCloudflareTokenIdentity(input: {
  accountId: string;
  token: string;
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  requireId: boolean;
  deadline?: OperationDeadline;
  tokenApiAttemptTimeoutMs?: number;
  tokenApiOperationTimeoutMs?: number;
}): Promise<{ ownership: CloudflareTokenOwnership; id: string | null } | null> {
  const accountId = requiredAccountId(input.accountId);
  const token = input.token.trim();
  if (!token) throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_input_invalid');
  const fetcher = input.fetcher ?? fetch;
  const retryDelays = input.retryDelaysMs ?? CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS;
  const attemptTimeoutMs = requiredTimeoutMs(
    input.tokenApiAttemptTimeoutMs,
    DEFAULT_TOKEN_API_ATTEMPT_TIMEOUT_MS
  );
  const deadline =
    input.deadline ??
    createOperationDeadline(
      requiredTimeoutMs(input.tokenApiOperationTimeoutMs, DEFAULT_TOKEN_API_OPERATION_TIMEOUT_MS)
    );
  const verify = async (
    ownership: CloudflareTokenOwnership
  ): Promise<{ active: boolean; id: string | null }> => {
    const path =
      ownership === 'account'
        ? `${API_BASE}/accounts/${accountId}/tokens/verify`
        : `${API_BASE}/user/tokens/verify`;
    for (let attempt = 0; ; attempt += 1) {
      let response: {
        status: number;
        ok: boolean;
        payload?: CloudflareEnvelope<{ id?: unknown; status?: unknown }>;
      };
      try {
        response = await fetchWithinDeadline({
          fetcher,
          url: path,
          init: {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'error',
          },
          deadline,
          attemptTimeoutMs,
          timeoutCode: 'cloudflare_token_ownership_verification_timeout',
          consume: async (result) => ({
            status: result.status,
            ok: result.ok,
            ...(result.ok
              ? {
                  payload: (await result.json()) as CloudflareEnvelope<{
                    id?: unknown;
                    status?: unknown;
                  }>,
                }
              : {}),
          }),
        });
      } catch {
        const delayMs = retryDelays[attempt];
        if (delayMs !== undefined) {
          try {
            await waitWithinDeadline(
              delayMs,
              deadline,
              'cloudflare_token_ownership_verification_timeout'
            );
            continue;
          } catch {
            // The bounded operation is exhausted and is reported below as unavailable.
          }
        }
        throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_verification_failed');
      }
      if (response.status === 401 || response.status === 403) {
        return { active: false, id: null };
      }
      const delayMs = retryDelays[attempt];
      if (isRetryableTokenApiStatus(response.status) && delayMs !== undefined) {
        try {
          await waitWithinDeadline(
            delayMs,
            deadline,
            'cloudflare_token_ownership_verification_timeout'
          );
          continue;
        } catch {
          // The bounded operation is exhausted and is reported below as unavailable.
        }
      }
      if (!response.ok) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_verification_failed');
      }
      const payload = response.payload!;
      if (payload.success !== true || payload.result === undefined) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_verification_failed');
      }
      if (payload.result.status !== 'active') return { active: false, id: null };
      const id = typeof payload.result.id === 'string' ? payload.result.id : null;
      if (input.requireId && (id === null || !TOKEN_ID.test(id))) {
        throw new CloudflareTokenBootstrapError('cloudflare_direct_token_identity_invalid');
      }
      return { active: true, id };
    }
  };
  const [account, user] = await Promise.all([verify('account'), verify('user')]);
  if (account.active === user.active) return null;
  return account.active
    ? { ownership: 'account', id: account.id }
    : { ownership: 'user', id: user.id };
}

export async function detectCloudflareTokenOwnership(input: {
  accountId: string;
  token: string;
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  tokenApiAttemptTimeoutMs?: number;
  tokenApiOperationTimeoutMs?: number;
}): Promise<CloudflareTokenOwnership | null> {
  return (
    (
      await inspectCloudflareTokenIdentity({
        ...input,
        requireId: false,
      })
    )?.ownership ?? null
  );
}

/** Capability-probes advanced direct tokens and returns only non-secret durable evidence. */
export async function validateDirectControlTokensWithEvidence(input: {
  accountId: string;
  d1Token: string;
  workersToken: string;
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  tokenApiAttemptTimeoutMs?: number;
  tokenApiOperationTimeoutMs?: number;
}): Promise<DirectControlTokenEvidence> {
  const accountId = requiredAccountId(input.accountId);
  const d1Token = input.d1Token.trim();
  const workersToken = input.workersToken.trim();
  if (!d1Token || !workersToken || d1Token === workersToken) {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_tokens_not_distinct');
  }
  const fetcher = input.fetcher ?? fetch;
  const tokenApiAttemptTimeoutMs = requiredTimeoutMs(
    input.tokenApiAttemptTimeoutMs,
    DEFAULT_TOKEN_API_ATTEMPT_TIMEOUT_MS
  );
  const deadline = createOperationDeadline(
    requiredTimeoutMs(input.tokenApiOperationTimeoutMs, DEFAULT_TOKEN_API_OPERATION_TIMEOUT_MS)
  );
  const [d1CanD1, d1CanWorkers, workersCanWorkers, workersCanD1, d1Identity, workersIdentity] =
    await Promise.all([
      probeScopedToken({
        fetcher,
        accountId,
        token: d1Token,
        resource: 'd1',
        deadline,
        tokenApiAttemptTimeoutMs,
      }),
      probeScopedToken({
        fetcher,
        accountId,
        token: d1Token,
        resource: 'workers',
        deadline,
        tokenApiAttemptTimeoutMs,
      }),
      probeScopedToken({
        fetcher,
        accountId,
        token: workersToken,
        resource: 'workers',
        deadline,
        tokenApiAttemptTimeoutMs,
      }),
      probeScopedToken({
        fetcher,
        accountId,
        token: workersToken,
        resource: 'd1',
        deadline,
        tokenApiAttemptTimeoutMs,
      }),
      inspectCloudflareTokenIdentity({
        fetcher,
        accountId,
        token: d1Token,
        retryDelaysMs: input.retryDelaysMs,
        requireId: true,
        deadline,
        tokenApiAttemptTimeoutMs,
      }),
      inspectCloudflareTokenIdentity({
        fetcher,
        accountId,
        token: workersToken,
        retryDelaysMs: input.retryDelaysMs,
        requireId: true,
        deadline,
        tokenApiAttemptTimeoutMs,
      }),
    ]);
  if (d1CanD1 !== 'allowed' || d1CanWorkers !== 'denied') {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_d1_token_scope_invalid');
  }
  if (workersCanWorkers !== 'allowed' || workersCanD1 !== 'denied') {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_workers_token_scope_invalid');
  }
  if (
    !d1Identity ||
    !workersIdentity ||
    d1Identity.ownership !== workersIdentity.ownership ||
    d1Identity.id === null ||
    workersIdentity.id === null ||
    d1Identity.id === workersIdentity.id
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_token_ownership_invalid');
  }
  return {
    ownership: d1Identity.ownership,
    childTokens: [
      {
        resourceClass: 'd1',
        tokenId: d1Identity.id,
        tokenName: 'operator-managed-d1',
        secretName: 'CLOUDFLARE_D1_API_TOKEN',
        tokenFingerprint: fingerprintToken(d1Token),
      },
      {
        resourceClass: 'workers',
        tokenId: workersIdentity.id,
        tokenName: 'operator-managed-workers',
        secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
        tokenFingerprint: fingerprintToken(workersToken),
      },
    ],
  };
}

/** Backwards-compatible ownership-only facade; token values are never returned or persisted. */
export async function validateDirectControlTokens(input: {
  accountId: string;
  d1Token: string;
  workersToken: string;
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  tokenApiAttemptTimeoutMs?: number;
  tokenApiOperationTimeoutMs?: number;
}): Promise<CloudflareTokenOwnership> {
  return (await validateDirectControlTokensWithEvidence(input)).ownership;
}

export async function selectPreferredCloudflareTokenOwnership(input: {
  accountId: string;
  wranglerOAuthToken: string;
  fetcher?: typeof fetch;
  tokenApiAttemptTimeoutMs?: number;
  tokenApiOperationTimeoutMs?: number;
}): Promise<CloudflareTokenOwnership> {
  const accountId = requiredAccountId(input.accountId);
  const fetcher = input.fetcher ?? fetch;
  const deadline = createOperationDeadline(
    requiredTimeoutMs(input.tokenApiOperationTimeoutMs, DEFAULT_TOKEN_API_OPERATION_TIMEOUT_MS)
  );
  try {
    const payload = await fetchWithinDeadline({
      fetcher,
      url: `${API_BASE}/memberships?per_page=50`,
      init: { headers: { Authorization: `Bearer ${input.wranglerOAuthToken}` } },
      deadline,
      attemptTimeoutMs: requiredTimeoutMs(
        input.tokenApiAttemptTimeoutMs,
        DEFAULT_TOKEN_API_ATTEMPT_TIMEOUT_MS
      ),
      timeoutCode: 'cloudflare_token_membership_lookup_timeout',
      consume: async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as {
          success?: boolean;
          result?: Array<{
            account?: { id?: string };
            status?: string;
            roles?: Array<{ name?: string }>;
          }>;
        };
      },
    });
    if (!payload) return 'user';
    const membership = payload.result?.find(
      (candidate) => candidate.account?.id === accountId && candidate.status === 'accepted'
    );
    return membership?.roles?.some((role) => role.name === 'Super Administrator - All Privileges')
      ? 'account'
      : 'user';
  } catch {
    return 'user';
  }
}

const CHILD_TOKEN_SPEC = {
  d1: {
    permissionNames: ['D1 Write', 'D1 Edit'],
    secretName: 'CLOUDFLARE_D1_API_TOKEN',
  },
  workers: {
    permissionNames: ['Workers Scripts Write', 'Workers Scripts Edit'],
    secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
  },
  kv: {
    permissionNames: ['Workers KV Storage Write', 'Workers KV Storage Edit'],
    secretName: 'CLOUDFLARE_KV_API_TOKEN',
  },
  r2: {
    permissionNames: ['Workers R2 Storage Write', 'Workers R2 Storage Edit'],
    secretName: 'CLOUDFLARE_R2_API_TOKEN',
  },
} as const;

const CONTROL_TOKEN_RESOURCE_CLASSES: readonly ControlTokenResourceClass[] = [
  'd1',
  'workers',
  'kv',
  'r2',
];

const CHILD_TOKEN_CAPABILITY_STABILIZATION_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
] as const;

function waitForCapabilityStabilization(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function validateIssuedChildCapabilities(input: {
  authority: CloudflareTokenAuthority;
  token: string;
  resourceClass: ControlTokenResourceClass;
  stabilizationDelaysMs?: readonly number[];
}): Promise<void> {
  const delays = input.stabilizationDelaysMs ?? CHILD_TOKEN_CAPABILITY_STABILIZATION_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    let capabilities: Array<{
      resourceClass: ControlTokenResourceClass;
      capability: CloudflareTokenCapability;
    }>;
    try {
      capabilities = await Promise.all(
        CONTROL_TOKEN_RESOURCE_CLASSES.map(async (resourceClass) => ({
          resourceClass,
          capability: await input.authority.probeIssuedToken(input.token, resourceClass),
        }))
      );
    } catch (error) {
      const delayMs = delays[attempt];
      if (
        error instanceof CloudflareTokenBootstrapError &&
        error.code === 'cloudflare_token_capability_probe_unavailable' &&
        delayMs !== undefined
      ) {
        await waitForCapabilityStabilization(delayMs);
        continue;
      }
      throw error;
    }
    const probes = Object.fromEntries(
      capabilities.map(({ resourceClass, capability }) => [resourceClass, capability])
    ) as Record<ControlTokenResourceClass, CloudflareTokenCapability>;
    if (
      capabilities.every(({ resourceClass, capability }) =>
        resourceClass === input.resourceClass ? capability === 'allowed' : capability === 'denied'
      )
    ) {
      return;
    }
    const allDenied = capabilities.every(({ capability }) => capability === 'denied');
    const delayMs = delays[attempt];
    if (allDenied && delayMs !== undefined) {
      await waitForCapabilityStabilization(delayMs);
      continue;
    }
    throw new CloudflareTokenBootstrapError('cloudflare_child_token_capability_invalid', false, {
      issuedFor: input.resourceClass,
      probes,
    });
  }
}

function exactPermissionGroup(
  groups: readonly CloudflareTokenPermissionGroup[],
  names: readonly string[]
): CloudflareTokenPermissionGroup {
  const matches = groups.filter(
    (group) => names.includes(group.name) && group.scopes.includes('com.cloudflare.api.account')
  );
  if (matches.length !== 1) {
    throw new CloudflareTokenBootstrapError('cloudflare_child_permission_group_invalid');
  }
  return matches[0]!;
}

function validateExactChildPolicy(
  token: CloudflareTokenRecord,
  accountId: string,
  permissionGroupId: string
): void {
  const expectedResource = `${ACCOUNT_RESOURCE_PREFIX}${accountId}`;
  if (
    token.status !== 'active' ||
    token.policies.length !== 1 ||
    token.policies[0]?.effect !== 'allow' ||
    token.policies[0]?.permission_groups.length !== 1 ||
    token.policies[0]?.permission_groups[0]?.id !== permissionGroupId ||
    Object.keys(token.policies[0]?.resources ?? {}).length !== 1 ||
    token.policies[0]?.resources[expectedResource] !== '*'
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_child_token_scope_invalid');
  }
}

function validateBootstrapPolicy(
  token: CloudflareTokenRecord,
  ownership: CloudflareTokenOwnership,
  accountId: string
): void {
  const allowedNames =
    ownership === 'account'
      ? ['Account API Tokens Write', 'Account API Tokens Edit']
      : ['API Tokens Write', 'API Tokens Edit'];
  const groups = token.policies.flatMap((policy) => policy.permission_groups);
  const resources = token.policies[0]?.resources ?? {};
  const resourceEntries = Object.entries(resources);
  const expectedAccountResource = `${ACCOUNT_RESOURCE_PREFIX}${requiredAccountId(accountId)}`;
  const hasExactResource =
    resourceEntries.length === 1 &&
    resourceEntries[0]?.[1] === '*' &&
    (ownership === 'account'
      ? resourceEntries[0]?.[0] === expectedAccountResource
      : /^com\.cloudflare\.api\.user\.[A-Za-z0-9_-]{1,128}$/u.test(resourceEntries[0]?.[0] ?? ''));
  if (
    token.status !== 'active' ||
    token.policies.length !== 1 ||
    token.policies[0]?.effect !== 'allow' ||
    groups.length !== 1 ||
    !groups[0]?.name ||
    !allowedNames.includes(groups[0].name) ||
    !hasExactResource
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_scope_invalid');
  }
}

async function reconcileAmbiguousChildTokenCreation(
  authority: CloudflareTokenAuthority,
  tokenName: string,
  preservedTokenIds: ReadonlySet<string>,
  retryDelaysMs: readonly number[]
): Promise<void> {
  const observedTokenIds = new Set<string>();
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    let inventory: readonly CloudflareTokenRecord[];
    try {
      inventory = await authority.listTokens();
    } catch {
      if (attempt === retryDelaysMs.length) {
        throw new CloudflareTokenBootstrapError(
          'cloudflare_child_token_create_outcome_unconfirmed',
          true
        );
      }
      await waitForTokenApiRetry(retryDelaysMs[attempt]!);
      continue;
    }

    const unrecognized = inventory.filter(
      (token) => token.name === tokenName && !preservedTokenIds.has(token.id)
    );
    if (unrecognized.length === 0 && observedTokenIds.size > 0) return;

    for (const token of unrecognized) {
      observedTokenIds.add(token.id);
      try {
        await authority.deleteToken(token.id);
      } catch {
        // Confirm the exact identifier through subsequent full-inventory reads.
      }
    }

    if (attempt < retryDelaysMs.length) {
      await waitForTokenApiRetry(retryDelaysMs[attempt]!);
    }
  }

  if (observedTokenIds.size > 0) {
    try {
      const remaining = await authority.listTokens();
      if (
        !remaining.some((token) => token.name === tokenName && !preservedTokenIds.has(token.id))
      ) {
        return;
      }
    } catch {
      // The outcome remains indeterminate and is reported below without issuing another POST.
    }
  }

  // Never replay an ambiguous create until its exact-name result was observed and removed. A later
  // setup attempt can reconcile the deterministic name without risking a second, late orphan.
  throw new CloudflareTokenBootstrapError(
    'cloudflare_child_token_create_outcome_unconfirmed',
    true
  );
}

async function deleteTokenIdsConfirmed(
  authority: CloudflareTokenAuthority,
  tokenIds: ReadonlySet<string>,
  errorCode: string
): Promise<void> {
  if (tokenIds.size === 0) return;
  for (const tokenId of tokenIds) {
    try {
      await authority.deleteToken(tokenId);
    } catch {
      // A lost delete response is adopted only after inventory reflection below.
    }
  }
  let remaining: readonly CloudflareTokenRecord[];
  try {
    remaining = await authority.listTokens();
  } catch {
    throw new CloudflareTokenBootstrapError(errorCode, true);
  }
  if (remaining.some((token) => tokenIds.has(token.id))) {
    throw new CloudflareTokenBootstrapError(errorCode, true);
  }
}

async function deleteStaleBootstrapTokens(
  authority: CloudflareTokenAuthority,
  tokenName: string,
  activeBootstrapTokenId: string
): Promise<void> {
  const stale = (await authority.listTokens()).filter(
    (token) => token.name === tokenName && token.id !== activeBootstrapTokenId
  );
  for (const token of stale) {
    try {
      await authority.deleteToken(token.id);
    } catch {
      // A lost delete response is adopted only after full-inventory absence reflection below.
    }
  }
  let remaining: readonly CloudflareTokenRecord[];
  try {
    remaining = await authority.listTokens();
  } catch {
    throw new CloudflareTokenBootstrapError('cloudflare_token_cleanup_unconfirmed', true);
  }
  if (remaining.some((token) => token.name === tokenName && token.id !== activeBootstrapTokenId)) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_cleanup_unconfirmed', true);
  }
}

async function createRecoverably(
  authority: CloudflareTokenAuthority,
  input: { name: string; policies: readonly CloudflareTokenPolicy[] },
  reconciliationDelaysMs: readonly number[]
): Promise<{
  token: CloudflareTokenRecord;
  previousTokens: readonly CloudflareTokenRecord[];
}> {
  const previousTokens = (await authority.listTokens()).filter(
    (token) => token.name === input.name
  );
  const preservedTokenIds = new Set(previousTokens.map((token) => token.id));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { token: await authority.createToken(input), previousTokens };
    } catch (error) {
      const status = tokenApiHttpStatus(error);
      if (
        error instanceof CloudflareTokenBootstrapError &&
        error.code !== 'cloudflare_token_api_response_lost' &&
        (status === null || !isRetryableTokenApiStatus(status))
      ) {
        throw new CloudflareTokenBootstrapError('cloudflare_child_token_create_failed');
      }
      await reconcileAmbiguousChildTokenCreation(
        authority,
        input.name,
        preservedTokenIds,
        reconciliationDelaysMs
      );
      if (attempt === 1) {
        throw new CloudflareTokenBootstrapError(
          'cloudflare_child_token_create_transient',
          false,
          undefined,
          true
        );
      }
    }
  }
  throw new CloudflareTokenBootstrapError('cloudflare_child_token_create_failed');
}

async function hasSecretWithRetry(
  sink: ControlSecretSink,
  secretName: ControlTokenSecretName,
  retryDelaysMs: readonly number[]
): Promise<boolean> {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await sink.has(secretName);
    } catch {
      if (attempt === retryDelaysMs.length) {
        throw new CloudflareTokenBootstrapError(
          'cloudflare_control_secret_inventory_unavailable',
          true
        );
      }
      await waitForTokenApiRetry(retryDelaysMs[attempt]!);
    }
  }
  throw new CloudflareTokenBootstrapError('cloudflare_control_secret_inventory_unavailable', true);
}

async function revokeBootstrap(
  authority: CloudflareTokenAuthority,
  bootstrapTokenId: string
): Promise<void> {
  try {
    await authority.deleteToken(bootstrapTokenId);
  } catch (error) {
    throw new CloudflareTokenBootstrapError(
      'cloudflare_bootstrap_revocation_unconfirmed',
      true,
      undefined,
      isIndeterminateTokenApiError(error)
    );
  }
}

/** Revokes a bootstrap credential that was entered before a later setup step failed. */
export async function cleanupCloudflareBootstrapToken(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  bootstrapToken: string;
  fetcher?: typeof fetch;
}): Promise<{ revoked: true }> {
  const authority = new CloudflareTokenAuthorityHttpClient({
    accountId: input.accountId,
    ownership: input.ownership,
    bootstrapToken: input.bootstrapToken,
    fetcher: input.fetcher,
  });
  const self = await authority.verifySelf();
  if (!self || self.status !== 'active') return { revoked: true };
  if (!TOKEN_ID.test(self.id)) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_invalid', true);
  }
  let staleCleanupFailed = false;
  try {
    await deleteStaleBootstrapTokens(
      authority,
      buildCloudflareBootstrapTokenName({
        accountId: input.accountId,
        environment: input.environment,
      }),
      self.id
    );
  } catch {
    staleCleanupFailed = true;
  }
  await revokeBootstrap(authority, self.id);
  if (staleCleanupFailed) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_cleanup_unconfirmed', true);
  }
  return { revoked: true };
}

/** Completes a checkpointed bootstrap-token revocation without creating new child tokens. */
export async function resumeCloudflareBootstrapTokenRevocation(input: {
  accountId: string;
  ownership: CloudflareTokenOwnership;
  expectedBootstrapTokenId: string;
  authority: CloudflareTokenAuthority;
}): Promise<{ revoked: true }> {
  if (!TOKEN_ID.test(input.expectedBootstrapTokenId)) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_invalid');
  }
  let self: Awaited<ReturnType<CloudflareTokenAuthority['verifySelf']>>;
  try {
    self = await input.authority.verifySelf();
  } catch (error) {
    if (isIndeterminateTokenApiError(error) && error instanceof CloudflareTokenBootstrapError) {
      throw new CloudflareTokenBootstrapError(error.code, false, undefined, true);
    }
    throw error;
  }
  // Cloudflare does not contractually define 401/403 from the verification endpoint as proof of
  // revocation. A missing result is therefore indeterminate as well; only a successful DELETE or
  // an authenticated 200 response carrying an inactive status can close this boundary.
  if (!self) {
    throw new CloudflareTokenBootstrapError(
      'cloudflare_bootstrap_revocation_unconfirmed',
      true,
      undefined,
      true
    );
  }
  if (self.id !== input.expectedBootstrapTokenId) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_mismatch');
  }
  if (self.status !== 'active') return { revoked: true };
  const bootstrapRecord = await input.authority.getToken(self.id);
  if (!bootstrapRecord || bootstrapRecord.id !== self.id) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_mismatch');
  }
  validateBootstrapPolicy(bootstrapRecord, input.ownership, input.accountId);
  await revokeBootstrap(input.authority, self.id);
  return { revoked: true };
}

/** Verifies a separately supplied, narrowly policy-checked authority before it is staged. */
export async function inspectCloudflareBootstrapRecoveryToken(input: {
  accountId: string;
  ownership: CloudflareTokenOwnership;
  authority: CloudflareTokenAuthority;
}): Promise<{ tokenId: string }> {
  const self = await input.authority.verifySelf();
  if (!self || self.status !== 'active' || !TOKEN_ID.test(self.id)) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_recovery_token_inactive');
  }
  const record = await input.authority.getToken(self.id);
  if (!record || record.id !== self.id) {
    throw new CloudflareTokenBootstrapError(
      'cloudflare_bootstrap_recovery_token_identity_mismatch'
    );
  }
  validateBootstrapPolicy(record, input.ownership, input.accountId);
  return { tokenId: self.id };
}

/**
 * Reconciles the secret-free Control checkpoint with exact provider identities before a lost
 * private artifact is reconstructed. This function is intentionally read-only: the caller must
 * durably stage the reconstructed recovery artifact before invoking any revocation path.
 */
export async function inspectCloudflarePendingBootstrapRecoveryState(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  expectedBootstrapTokenId: string;
  expectedBootstrapTokenFingerprint: string;
  childTokens: ControlTokenBootstrapPreparedResult['childTokens'];
  authority: CloudflareTokenAuthority;
}): Promise<{ recoveryTokenId: string }> {
  const accountId = requiredAccountId(input.accountId);
  requiredEnvironment(input.environment);
  if (
    !TOKEN_ID.test(input.expectedBootstrapTokenId) ||
    !/^[0-9a-f]{64}$/u.test(input.expectedBootstrapTokenFingerprint)
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }

  const inspected = await inspectCloudflareBootstrapRecoveryToken({
    accountId,
    ownership: input.ownership,
    authority: input.authority,
  });
  const childTokenIds = new Set<string>();
  const childTokenFingerprints = new Set<string>();
  if (input.childTokens.length < 2) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }
  if (inspected.tokenId === input.expectedBootstrapTokenId) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_recovery_token_not_independent');
  }
  for (const child of input.childTokens) {
    const expectedSpec = CHILD_TOKEN_SPEC[child.resourceClass];
    if (
      !TOKEN_ID.test(child.tokenId) ||
      child.tokenId === input.expectedBootstrapTokenId ||
      child.tokenId === inspected.tokenId ||
      childTokenIds.has(child.tokenId) ||
      child.tokenFingerprint === input.expectedBootstrapTokenFingerprint ||
      childTokenFingerprints.has(child.tokenFingerprint) ||
      child.tokenName !==
        buildCloudflareChildTokenName({
          accountId,
          environment: input.environment,
          resourceClass: child.resourceClass,
        }) ||
      child.secretName !== expectedSpec.secretName ||
      !/^[0-9a-f]{64}$/u.test(child.tokenFingerprint)
    ) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
    }
    childTokenIds.add(child.tokenId);
    childTokenFingerprints.add(child.tokenFingerprint);
  }

  const bootstrap = await input.authority.getToken(input.expectedBootstrapTokenId);
  if (bootstrap) {
    if (bootstrap.id !== input.expectedBootstrapTokenId) {
      throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_mismatch');
    }
    validateBootstrapPolicy(bootstrap, input.ownership, accountId);
  }

  const permissionGroups = await input.authority.listPermissionGroups();
  for (const child of input.childTokens) {
    const record = await input.authority.getToken(child.tokenId);
    if (
      !record ||
      record.id !== child.tokenId ||
      record.name !== child.tokenName ||
      record.status !== 'active'
    ) {
      throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_recovery_child_token_mismatch');
    }
    const spec = CHILD_TOKEN_SPEC[child.resourceClass];
    const permissionGroup = exactPermissionGroup(permissionGroups, spec.permissionNames);
    validateExactChildPolicy(record, accountId, permissionGroup.id);
  }
  return { recoveryTokenId: inspected.tokenId };
}

/**
 * Uses an independently authenticated recovery token to prove/delete every checkpointed broad
 * token by exact ID, then revokes the recovery token itself. A successful DELETE response is the
 * only self-revocation proof; 401/403 are never interpreted as success.
 */
export async function reconcileCloudflareBootstrapRevocationWithRecoveryToken(input: {
  accountId: string;
  ownership: CloudflareTokenOwnership;
  expectedRecoveryTokenId: string;
  revocationTargetTokenIds: readonly string[];
  authority: CloudflareTokenAuthority;
}): Promise<{ revoked: true }> {
  const inspected = await inspectCloudflareBootstrapRecoveryToken({
    accountId: input.accountId,
    ownership: input.ownership,
    authority: input.authority,
  });
  if (inspected.tokenId !== input.expectedRecoveryTokenId) {
    throw new CloudflareTokenBootstrapError(
      'cloudflare_bootstrap_recovery_token_identity_mismatch'
    );
  }
  const targetIds = [...new Set(input.revocationTargetTokenIds)];
  if (
    targetIds.length < 1 ||
    targetIds.some((tokenId) => !TOKEN_ID.test(tokenId) || tokenId === inspected.tokenId)
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_recovery_targets_invalid');
  }
  for (const tokenId of targetIds) {
    const record = await input.authority.getToken(tokenId);
    if (!record) continue;
    validateBootstrapPolicy(record, input.ownership, input.accountId);
    await input.authority.deleteToken(tokenId);
    let absent = false;
    for (let attempt = 0; attempt <= CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS.length; attempt += 1) {
      if ((await input.authority.getToken(tokenId)) === null) {
        absent = true;
        break;
      }
      const delay = CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await waitForTokenApiRetry(delay);
    }
    if (!absent) {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_bootstrap_recovery_target_revocation_unconfirmed',
        true
      );
    }
  }
  await revokeBootstrap(input.authority, inspected.tokenId);
  return { revoked: true };
}

export async function bootstrapControlWorkerTokens(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  authority: CloudflareTokenAuthority;
  secretSink: ControlSecretSink;
  resourceClasses?: readonly ControlTokenResourceClass[];
  capabilityStabilizationDelaysMs?: readonly number[];
  childTokenCreateReconciliationDelaysMs?: readonly number[];
  secretInventoryRetryDelaysMs?: readonly number[];
  verifyControlSecretCutover?: (result: ControlTokenBootstrapPreparedResult) => Promise<boolean>;
  beforeBootstrapRevocation?: (result: ControlTokenBootstrapPreparedResult) => Promise<void>;
  afterBootstrapRevocation?: (result: ControlTokenBootstrapResult) => Promise<void>;
}): Promise<ControlTokenBootstrapResult> {
  const accountId = requiredAccountId(input.accountId);
  requiredEnvironment(input.environment);
  const requestedClasses = input.resourceClasses ?? ['d1', 'workers'];
  const resourceClasses = [...new Set(requestedClasses)];
  if (!resourceClasses.includes('d1') || !resourceClasses.includes('workers')) {
    throw new CloudflareTokenBootstrapError('cloudflare_baseline_child_tokens_required');
  }
  let self: Awaited<ReturnType<CloudflareTokenAuthority['verifySelf']>>;
  try {
    self = await input.authority.verifySelf();
  } catch (error) {
    if (isIndeterminateTokenApiError(error) && error instanceof CloudflareTokenBootstrapError) {
      throw new CloudflareTokenBootstrapError(error.code, false, error.capabilityDiagnostic, true);
    }
    throw error;
  }
  if (!self || self.status !== 'active' || !TOKEN_ID.test(self.id)) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_inactive');
  }
  const created: Array<{
    resourceClass: ControlTokenResourceClass;
    token: CloudflareTokenRecord;
    previousTokens: readonly CloudflareTokenRecord[];
    secretName: ControlTokenSecretName;
    secretWriteAttempted: boolean;
  }> = [];
  let bootstrapRevoked = false;
  let bootstrapRevocationStarted = false;
  try {
    const bootstrapRecord = await input.authority.getToken(self.id);
    if (!bootstrapRecord || bootstrapRecord.id !== self.id) {
      throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_mismatch');
    }
    validateBootstrapPolicy(bootstrapRecord, input.ownership, accountId);
    await deleteStaleBootstrapTokens(
      input.authority,
      buildCloudflareBootstrapTokenName({ accountId, environment: input.environment }),
      self.id
    );

    const permissionGroups = await input.authority.listPermissionGroups();
    for (const resourceClass of resourceClasses) {
      const spec = CHILD_TOKEN_SPEC[resourceClass];
      const permissionGroup = exactPermissionGroup(permissionGroups, spec.permissionNames);
      const tokenName = buildCloudflareChildTokenName({
        accountId,
        environment: input.environment,
        resourceClass,
      });
      const creation = await createRecoverably(
        input.authority,
        {
          name: tokenName,
          policies: [
            {
              effect: 'allow',
              permission_groups: [{ id: permissionGroup.id }],
              resources: { [`${ACCOUNT_RESOURCE_PREFIX}${accountId}`]: '*' },
            },
          ],
        },
        input.childTokenCreateReconciliationDelaysMs ?? CHILD_TOKEN_CREATE_RECONCILIATION_DELAYS_MS
      );
      const { token, previousTokens } = creation;
      const duplicate = created.some(
        (candidate) =>
          candidate.token.id === token.id ||
          (candidate.token.value !== undefined && candidate.token.value === token.value)
      );
      created.push({
        resourceClass,
        token,
        previousTokens,
        secretName: spec.secretName,
        secretWriteAttempted: false,
      });
      if (!token.value || token.id === self.id || token.value === bootstrapRecord.value) {
        throw new CloudflareTokenBootstrapError('cloudflare_child_token_identity_invalid');
      }
      if (previousTokens.some((previous) => previous.id === token.id)) {
        throw new CloudflareTokenBootstrapError('cloudflare_child_token_identity_invalid');
      }
      validateExactChildPolicy(token, accountId, permissionGroup.id);
      const verified = await input.authority.verifyIssuedToken(token.value);
      if (!verified || verified.id !== token.id || verified.status !== 'active') {
        throw new CloudflareTokenBootstrapError('cloudflare_child_token_verification_failed');
      }
      await validateIssuedChildCapabilities({
        authority: input.authority,
        token: token.value,
        resourceClass,
        stabilizationDelaysMs: input.capabilityStabilizationDelaysMs,
      });
      if (duplicate) {
        throw new CloudflareTokenBootstrapError('cloudflare_child_tokens_not_distinct');
      }
    }

    for (const child of created) child.secretWriteAttempted = true;
    const generationTag = `authrim-${input.environment}-${createHash('sha256')
      .update(
        created
          .map(
            (child) =>
              `${child.resourceClass}:${child.token.id}:${fingerprintToken(child.token.value!)}`
          )
          .sort()
          .join('|'),
        'utf8'
      )
      .digest('hex')
      .slice(0, 24)}`;
    const secretGeneration = await input.secretSink.putGeneration(
      Object.fromEntries(created.map((child) => [child.secretName, child.token.value!])),
      generationTag
    );
    for (const child of created) {
      if (
        !(await hasSecretWithRetry(
          input.secretSink,
          child.secretName,
          input.secretInventoryRetryDelaysMs ?? CONTROL_SECRET_INVENTORY_RETRY_DELAYS_MS
        ))
      ) {
        throw new CloudflareTokenBootstrapError(
          'cloudflare_control_secret_registration_unconfirmed',
          true
        );
      }
    }

    const preparedResult: ControlTokenBootstrapPreparedResult = {
      ownership: input.ownership,
      bootstrapTokenId: self.id,
      bootstrapRevoked: false,
      childTokens: created.map(({ resourceClass, token, secretName }) => ({
        resourceClass,
        tokenId: token.id,
        tokenName: token.name,
        secretName,
        tokenFingerprint: fingerprintToken(token.value!),
      })),
      secretGeneration,
    };
    if (input.verifyControlSecretCutover) {
      let verified = false;
      try {
        verified = await input.verifyControlSecretCutover(preparedResult);
      } catch {
        // Verification errors and negative results have the same fail-closed outcome.
      }
      if (!verified) {
        throw new CloudflareTokenBootstrapError(
          'cloudflare_control_secret_cutover_verification_failed',
          true
        );
      }
    }
    // Every new value reached at least one confirmed secret-put response before this point.
    // Ambiguous-only writes fail above and retain both generations; the confirmed path can safely
    // retire superseded credentials even when an additional functional verifier is unavailable.
    const previousTokenIds = new Set(
      created.flatMap((child) => child.previousTokens.map((token) => token.id))
    );
    await deleteTokenIdsConfirmed(
      input.authority,
      previousTokenIds,
      'cloudflare_previous_child_token_revocation_unconfirmed'
    );
    try {
      await input.beforeBootstrapRevocation?.(preparedResult);
    } catch {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_bootstrap_revocation_checkpoint_failed',
        false,
        undefined,
        true
      );
    }
    bootstrapRevocationStarted = true;
    await revokeBootstrap(input.authority, self.id);
    bootstrapRevoked = true;
    const result: ControlTokenBootstrapResult = {
      ...preparedResult,
      bootstrapRevoked: true,
    };
    try {
      await input.afterBootstrapRevocation?.(result);
    } catch {
      throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_cutover_checkpoint_failed');
    }
    return result;
  } catch (error) {
    let cleanupRequired = false;
    const preserveBootstrap =
      !bootstrapRevocationStarted &&
      (isIndeterminateTokenApiError(error) ||
        (error instanceof CloudflareTokenBootstrapError && error.bootstrapRetainedForRetry));
    if (!bootstrapRevoked) {
      const protectedTokenIds = new Set(
        created.filter((child) => child.secretWriteAttempted).map((child) => child.token.id)
      );
      const safeToDelete = new Set(
        created
          .filter((child) => !child.secretWriteAttempted && !protectedTokenIds.has(child.token.id))
          .map((child) => child.token.id)
      );
      try {
        await deleteTokenIdsConfirmed(
          input.authority,
          safeToDelete,
          'cloudflare_token_cleanup_unconfirmed'
        );
      } catch {
        cleanupRequired = true;
      }
      // Once a secret put was attempted, the Worker may already reference the new child token.
      // Keep both generations and never delete the same-name Worker secret on an ambiguous path.
      if (created.some((child) => child.secretWriteAttempted)) cleanupRequired = true;
      if (preserveBootstrap) {
        // The operator can safely retry with the same bootstrap credential after an indeterminate
        // read/create outcome. Revoking it here would turn a transient provider failure into manual
        // recovery, while unregistered child credentials are still reconciled above.
      } else {
        try {
          await revokeBootstrap(input.authority, self.id);
        } catch {
          cleanupRequired = true;
        }
      }
    }
    if (error instanceof CloudflareTokenBootstrapError) {
      throw new CloudflareTokenBootstrapError(
        error.code,
        preserveBootstrap ? false : error.cleanupRequired || cleanupRequired,
        error.capabilityDiagnostic,
        preserveBootstrap
      );
    }
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_failed', cleanupRequired);
  }
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number }>;
  result_info?: {
    count?: number;
    page?: number;
    per_page?: number;
    total_count?: number;
    total_pages?: number;
  };
}

function invalidTokenInventory(): never {
  throw new CloudflareTokenBootstrapError('cloudflare_token_inventory_invalid', true);
}

function validatedTokenInventoryRecord(candidate: unknown): CloudflareTokenRecord {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return invalidTokenInventory();
  }
  const record = candidate as Partial<CloudflareTokenRecord>;
  if (
    typeof record.id !== 'string' ||
    !TOKEN_ID.test(record.id) ||
    typeof record.name !== 'string' ||
    record.name.length === 0 ||
    !['active', 'disabled', 'expired'].includes(String(record.status)) ||
    !Array.isArray(record.policies)
  ) {
    return invalidTokenInventory();
  }
  return record as CloudflareTokenRecord;
}

export class CloudflareTokenAuthorityHttpClient implements CloudflareTokenAuthority {
  constructor(
    private readonly input: {
      accountId: string;
      ownership: CloudflareTokenOwnership;
      bootstrapToken: string;
      fetcher?: typeof fetch;
      tokenApiRetryDelaysMs?: readonly number[];
      tokenApiAttemptTimeoutMs?: number;
      tokenApiOperationTimeoutMs?: number;
    }
  ) {
    requiredAccountId(input.accountId);
  }

  private get fetcher(): typeof fetch {
    return this.input.fetcher ?? fetch;
  }

  private get tokenBase(): string {
    return this.input.ownership === 'account'
      ? `${API_BASE}/accounts/${this.input.accountId}/tokens`
      : `${API_BASE}/user/tokens`;
  }

  private createDeadline(): OperationDeadline {
    return createOperationDeadline(
      requiredTimeoutMs(
        this.input.tokenApiOperationTimeoutMs,
        DEFAULT_TOKEN_API_OPERATION_TIMEOUT_MS
      )
    );
  }

  private get attemptTimeoutMs(): number {
    return requiredTimeoutMs(
      this.input.tokenApiAttemptTimeoutMs,
      DEFAULT_TOKEN_API_ATTEMPT_TIMEOUT_MS
    );
  }

  private async requestEnvelope<T>(
    path: string,
    init: Parameters<typeof fetch>[1] = {},
    authorizationToken: string = this.input.bootstrapToken,
    deadline: OperationDeadline = this.createDeadline()
  ): Promise<CloudflareEnvelope<T>> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const retryableRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const retryDelays = retryableRead
      ? (this.input.tokenApiRetryDelaysMs ?? CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS)
      : [];
    let response: { status: number; ok: boolean; payload?: CloudflareEnvelope<T> } | undefined;
    let lastTransportError = false;

    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetchWithinDeadline({
          fetcher: this.fetcher,
          url: path,
          init: {
            ...init,
            headers: {
              Authorization: `Bearer ${authorizationToken}`,
              ...(init.body ? { 'Content-Type': 'application/json' } : {}),
              ...init.headers,
            },
          },
          deadline,
          attemptTimeoutMs: this.attemptTimeoutMs,
          timeoutCode: 'cloudflare_token_api_timeout',
          consume: async (result) => ({
            status: result.status,
            ok: result.ok,
            ...(result.ok ? { payload: (await result.json()) as CloudflareEnvelope<T> } : {}),
          }),
        });
        lastTransportError = false;
      } catch {
        response = undefined;
        lastTransportError = true;
      }

      const retryDelay = retryDelays[attempt];
      if (
        retryDelay !== undefined &&
        (lastTransportError ||
          (response !== undefined && isRetryableTokenApiStatus(response.status)))
      ) {
        try {
          await waitWithinDeadline(retryDelay, deadline, 'cloudflare_token_api_timeout');
          continue;
        } catch {
          response = undefined;
          lastTransportError = true;
        }
      }
      break;
    }

    if (lastTransportError || response === undefined) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_response_lost');
    }
    if (!response.ok) {
      throw new CloudflareTokenBootstrapError(`cloudflare_token_api_http_${response.status}`);
    }
    const payload = response.payload!;
    if (payload.success === false || payload.result === undefined) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_rejected');
    }
    return payload;
  }

  private async request<T>(
    path: string,
    init: Parameters<typeof fetch>[1] = {},
    authorizationToken: string = this.input.bootstrapToken
  ): Promise<T> {
    return (await this.requestEnvelope<T>(path, init, authorizationToken)).result!;
  }

  verifySelf() {
    return this.request<{ id: string; status: 'active' | 'disabled' | 'expired' }>(
      `${this.tokenBase}/verify`
    );
  }

  async getToken(tokenId: string): Promise<CloudflareTokenRecord | null> {
    if (!TOKEN_ID.test(tokenId)) throw new Error('cloudflare_token_id_invalid');
    try {
      return await this.request<CloudflareTokenRecord>(`${this.tokenBase}/${tokenId}`);
    } catch (error) {
      if (
        error instanceof CloudflareTokenBootstrapError &&
        error.code === 'cloudflare_token_api_http_404'
      ) {
        return null;
      }
      throw error;
    }
  }

  async listTokens(): Promise<readonly CloudflareTokenRecord[]> {
    const tokens: CloudflareTokenRecord[] = [];
    const seenTokenIds = new Set<string>();
    const deadline = this.createDeadline();
    let expectedTotalCount: number | undefined;
    for (let page = 1; page <= MAX_TOKEN_INVENTORY_PAGES; page += 1) {
      const payload = await this.requestEnvelope<CloudflareTokenRecord[]>(
        `${this.tokenBase}?per_page=${TOKEN_INVENTORY_PAGE_SIZE}&page=${page}`,
        {},
        this.input.bootstrapToken,
        deadline
      );
      const rawBatch = payload.result;
      const info = payload.result_info;
      if (!Array.isArray(rawBatch) || !info) return invalidTokenInventory();
      const {
        count,
        page: responsePage,
        per_page: perPage,
        total_count: totalCount,
        total_pages: totalPages,
      } = info;
      if (
        responsePage !== page ||
        perPage !== TOKEN_INVENTORY_PAGE_SIZE ||
        !Number.isSafeInteger(count) ||
        count !== rawBatch.length ||
        !Number.isSafeInteger(totalCount) ||
        totalCount! < 0
      ) {
        return invalidTokenInventory();
      }
      if (totalCount! > MAX_TOKEN_INVENTORY_RECORDS) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_inventory_too_large', true);
      }
      const expectedTotalPages = Math.ceil(totalCount! / TOKEN_INVENTORY_PAGE_SIZE);
      if (
        totalPages !== undefined &&
        (!Number.isSafeInteger(totalPages) ||
          (totalPages !== expectedTotalPages && !(totalCount === 0 && totalPages === 1)))
      ) {
        return invalidTokenInventory();
      }
      if (expectedTotalCount === undefined) expectedTotalCount = totalCount;
      if (totalCount !== expectedTotalCount) return invalidTokenInventory();

      const remainingCount = totalCount! - tokens.length;
      const expectedBatchLength = Math.min(TOKEN_INVENTORY_PAGE_SIZE, remainingCount);
      if (remainingCount < 0 || rawBatch.length !== expectedBatchLength) {
        return invalidTokenInventory();
      }

      const batch = rawBatch.map(validatedTokenInventoryRecord);
      for (const token of batch) {
        if (seenTokenIds.has(token.id)) return invalidTokenInventory();
        seenTokenIds.add(token.id);
      }
      tokens.push(...batch);
      if (tokens.length === totalCount) return tokens;
    }
    throw new CloudflareTokenBootstrapError('cloudflare_token_inventory_too_large', true);
  }

  listPermissionGroups(
    scope: 'com.cloudflare.api.account' | 'com.cloudflare.api.user' = 'com.cloudflare.api.account'
  ): Promise<readonly CloudflareTokenPermissionGroup[]> {
    return this.request<CloudflareTokenPermissionGroup[]>(
      `${this.tokenBase}/permission_groups?scope=${scope}`
    );
  }

  createToken(input: {
    name: string;
    policies: readonly CloudflareTokenPolicy[];
  }): Promise<CloudflareTokenRecord> {
    return this.request<CloudflareTokenRecord>(this.tokenBase, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async deleteToken(tokenId: string): Promise<void> {
    if (!TOKEN_ID.test(tokenId)) throw new Error('cloudflare_token_id_invalid');
    await this.request<{ id: string }>(`${this.tokenBase}/${tokenId}`, { method: 'DELETE' });
  }

  async verifyIssuedToken(token: string) {
    const path =
      this.input.ownership === 'account'
        ? `${API_BASE}/accounts/${this.input.accountId}/tokens/verify`
        : `${API_BASE}/user/tokens/verify`;
    try {
      return await this.request<{
        id: string;
        status: 'active' | 'disabled' | 'expired';
      }>(path, {}, token);
    } catch (error) {
      if (
        error instanceof CloudflareTokenBootstrapError &&
        (error.code === 'cloudflare_token_api_http_401' ||
          error.code === 'cloudflare_token_api_http_403' ||
          error.code === 'cloudflare_token_api_rejected')
      ) {
        return null;
      }
      throw error;
    }
  }

  probeIssuedToken(
    token: string,
    resourceClass: ControlTokenResourceClass
  ): Promise<CloudflareTokenCapability> {
    return probeScopedToken({
      fetcher: this.fetcher,
      accountId: this.input.accountId,
      token,
      resource: resourceClass,
      tokenApiAttemptTimeoutMs: this.input.tokenApiAttemptTimeoutMs,
      tokenApiOperationTimeoutMs: this.input.tokenApiOperationTimeoutMs,
    });
  }
}

interface WranglerSecretCommandResult {
  stdout: string;
}

type WranglerSecretCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    input?: string;
    env: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
  }
) => Promise<WranglerSecretCommandResult>;

async function defaultWranglerSecretCommandRunner(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    input?: string;
    env: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
  }
): Promise<WranglerSecretCommandResult> {
  const result = await execa(command, [...args], {
    cwd: options.cwd,
    ...(options.input === undefined ? {} : { input: options.input }),
    env: options.env,
    cancelSignal: options.signal,
    timeout: options.timeoutMs,
  });
  return { stdout: result.stdout };
}

function isWranglerSecretCommandTimeout(error: unknown): boolean {
  return (
    error instanceof CloudflareTokenBootstrapError &&
    error.code === 'cloudflare_control_secret_command_timeout'
  );
}

/** Uploads generated values through stdin only; values never enter argv or a local file. */
export class WranglerControlSecretSink implements ControlSecretSink {
  constructor(
    private readonly input: {
      workerName: string;
      cwd: string;
      runner?: WranglerSecretCommandRunner;
      commandTimeoutMs?: number;
      operationTimeoutMs?: number;
    }
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.workerName)) {
      throw new Error('cloudflare_control_worker_name_invalid');
    }
  }

  private createDeadline(): OperationDeadline {
    return createOperationDeadline(
      requiredTimeoutMs(this.input.operationTimeoutMs, DEFAULT_WRANGLER_SECRET_OPERATION_TIMEOUT_MS)
    );
  }

  private get commandTimeoutMs(): number {
    return requiredTimeoutMs(
      this.input.commandTimeoutMs,
      DEFAULT_WRANGLER_SECRET_COMMAND_TIMEOUT_MS
    );
  }

  private async run(
    args: readonly string[],
    input?: string,
    logLevel: 'log' | 'warn' = 'warn',
    deadline: OperationDeadline = this.createDeadline()
  ): Promise<WranglerSecretCommandResult> {
    try {
      return await runWithinDeadline({
        deadline,
        attemptTimeoutMs: this.commandTimeoutMs,
        timeoutCode: 'cloudflare_control_secret_command_timeout',
        operation: (signal) =>
          (this.input.runner ?? defaultWranglerSecretCommandRunner)('pnpm', args, {
            cwd: this.input.cwd,
            ...(input === undefined ? {} : { input }),
            env: { WRANGLER_LOG: logLevel },
            signal,
            timeoutMs: Math.max(1, Math.min(this.commandTimeoutMs, remainingDeadlineMs(deadline))),
          }),
      });
    } catch (error) {
      if (error instanceof OperationDeadlineExceededError) {
        throw new CloudflareTokenBootstrapError(
          'cloudflare_control_secret_command_timeout',
          true,
          undefined,
          true
        );
      }
      throw error;
    }
  }

  private async listVersionsWithTag(
    generationTag: string,
    deadline: OperationDeadline
  ): Promise<readonly { id: string; tag: string }[]> {
    let result: WranglerSecretCommandResult;
    try {
      result = await this.run(
        ['exec', 'wrangler', 'versions', 'list', '--name', this.input.workerName, '--json'],
        undefined,
        'log',
        deadline
      );
    } catch (error) {
      if (isWranglerSecretCommandTimeout(error)) throw error;
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_inventory_unavailable',
        true
      );
    }
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error();
      const versions = parsed.map((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new Error();
        }
        const record = candidate as { id?: unknown; annotations?: unknown };
        if (
          typeof record.id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.id) ||
          (record.annotations !== undefined &&
            (!record.annotations ||
              typeof record.annotations !== 'object' ||
              Array.isArray(record.annotations)))
        ) {
          throw new Error();
        }
        const tag = (record.annotations as Record<string, unknown> | undefined)?.['workers/tag'];
        if (tag !== undefined && typeof tag !== 'string') throw new Error();
        return { id: record.id, tag: tag ?? '' };
      });
      return versions.filter((version) => version.tag === generationTag);
    } catch {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_inventory_invalid',
        true
      );
    }
  }

  private async reconcileTaggedVersion(
    generationTag: string,
    deadline: OperationDeadline
  ): Promise<string> {
    // Wrangler exposes only the ten newest deployable versions. This reconciliation is deliberately
    // bounded to the upload command's immediate response-loss window in the same process; durable
    // resume uses the checkpointed immutable version ID instead of searching this rolling list.
    for (
      let attempt = 0;
      attempt <= CONTROL_SECRET_GENERATION_RECONCILIATION_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        const matching = await this.listVersionsWithTag(generationTag, deadline);
        if (matching.length > 1) {
          throw new CloudflareTokenBootstrapError(
            'cloudflare_control_secret_generation_tag_ambiguous',
            true
          );
        }
        if (matching.length === 1) return matching[0]!.id;
      } catch (error) {
        if (
          error instanceof CloudflareTokenBootstrapError &&
          error.code === 'cloudflare_control_secret_generation_tag_ambiguous'
        ) {
          throw error;
        }
      }
      const delay = CONTROL_SECRET_GENERATION_RECONCILIATION_DELAYS_MS[attempt];
      if (delay !== undefined) {
        try {
          await waitWithinDeadline(delay, deadline, 'cloudflare_control_secret_operation_timeout');
        } catch {
          break;
        }
      }
    }
    throw new CloudflareTokenBootstrapError(
      'cloudflare_control_secret_generation_creation_unconfirmed',
      true,
      undefined,
      true
    );
  }

  private deploymentArgs(versionId: string): readonly string[] {
    return [
      'exec',
      'wrangler',
      'versions',
      'deploy',
      `${versionId}@100%`,
      '--name',
      this.input.workerName,
      '--yes',
    ];
  }

  private async reconcileActiveGeneration(
    versionId: string,
    deadline: OperationDeadline,
    retryDelaysMs: readonly number[] = CONTROL_SECRET_GENERATION_RECONCILIATION_DELAYS_MS
  ): Promise<ControlSecretGenerationReceipt | null> {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        const receipt = await this.readActiveGenerationWithin(deadline);
        if (receipt.versionId === versionId) return receipt;
      } catch {
        // A status read can itself be transient. Do not replay the deployment on this path.
      }
      const delay = retryDelaysMs[attempt];
      if (delay !== undefined) {
        try {
          await waitWithinDeadline(delay, deadline, 'cloudflare_control_secret_operation_timeout');
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private async deployGeneration(
    versionId: string,
    deadline: OperationDeadline
  ): Promise<ControlSecretGenerationReceipt> {
    const alreadyActive = await this.reconcileActiveGeneration(versionId, deadline, []);
    if (alreadyActive) return alreadyActive;

    try {
      await this.run(this.deploymentArgs(versionId), undefined, 'log', deadline);
    } catch {
      // Wrangler/provider failures do not prove that the deployment mutation did not commit.
      // Replaying here could create duplicate deployment records while active status is stale.
    }

    // Every success/error path performs the same bounded final readback. A later setup resume can
    // read the checkpointed immutable version again; this invocation never issues a blind replay.
    const receipt = await this.reconcileActiveGeneration(versionId, deadline);
    if (receipt) return receipt;

    throw new CloudflareTokenBootstrapError(
      'cloudflare_control_secret_generation_deployment_unconfirmed',
      true,
      undefined,
      true
    );
  }

  async putGeneration(
    secrets: Readonly<Partial<Record<ControlTokenSecretName, string>>>,
    generationTag: string
  ): Promise<ControlSecretGenerationReceipt> {
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(generationTag)) {
      throw new Error('cloudflare_control_secret_generation_tag_invalid');
    }
    const entries = Object.entries(secrets);
    if (
      entries.length < 2 ||
      entries.some(
        ([name, value]) =>
          ![
            'CLOUDFLARE_D1_API_TOKEN',
            'CLOUDFLARE_WORKERS_API_TOKEN',
            'CLOUDFLARE_KV_API_TOKEN',
            'CLOUDFLARE_R2_API_TOKEN',
          ].includes(name) ||
          typeof value !== 'string' ||
          !value.trim()
      )
    ) {
      throw new Error('cloudflare_control_secret_generation_values_invalid');
    }
    const deadline = this.createDeadline();
    const existing = await this.listVersionsWithTag(generationTag, deadline);
    if (existing.length !== 0) {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_tag_collision',
        true
      );
    }

    let outputVersionId: string | undefined;
    try {
      const result = await this.run(
        [
          'exec',
          'wrangler',
          'versions',
          'secret',
          'bulk',
          '--name',
          this.input.workerName,
          '--tag',
          generationTag,
        ],
        JSON.stringify(secrets),
        'log',
        deadline
      );
      outputVersionId = /\bCreated version ([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) with\b/u.exec(
        result.stdout
      )?.[1];
    } catch {
      // The immutable version tag below reconciles a response lost after provider mutation.
    }
    const versionId = await this.reconcileTaggedVersion(generationTag, deadline);
    if (outputVersionId !== undefined && outputVersionId !== versionId) {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_version_mismatch',
        true
      );
    }

    return this.deployGeneration(versionId, deadline);
  }

  private async listNamesWithin(deadline: OperationDeadline): Promise<readonly string[]> {
    let result: WranglerSecretCommandResult;
    try {
      result = await this.run(
        ['exec', 'wrangler', 'secret', 'list', '--name', this.input.workerName, '--format', 'json'],
        undefined,
        'log',
        deadline
      );
    } catch (error) {
      if (isWranglerSecretCommandTimeout(error)) throw error;
      throw new CloudflareTokenBootstrapError('cloudflare_control_secret_list_failed');
    }
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new CloudflareTokenBootstrapError('cloudflare_control_secret_list_invalid');
      }
      const names = parsed.map((entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as { name?: unknown }).name
          : undefined
      );
      if (names.some((name) => typeof name !== 'string')) {
        throw new CloudflareTokenBootstrapError('cloudflare_control_secret_list_invalid');
      }
      return names as string[];
    } catch {
      throw new CloudflareTokenBootstrapError('cloudflare_control_secret_list_invalid');
    }
  }

  async listNames(): Promise<readonly string[]> {
    return this.listNamesWithin(this.createDeadline());
  }

  private async readActiveGenerationWithin(
    deadline: OperationDeadline
  ): Promise<ControlSecretGenerationReceipt> {
    let result: WranglerSecretCommandResult;
    try {
      result = await this.run(
        ['exec', 'wrangler', 'deployments', 'status', '--name', this.input.workerName, '--json'],
        undefined,
        'log',
        deadline
      );
    } catch (error) {
      if (isWranglerSecretCommandTimeout(error)) throw error;
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_receipt_unavailable',
        true
      );
    }
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const deployment = parsed as { id?: unknown; versions?: unknown };
      if (
        typeof deployment.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(deployment.id) ||
        !Array.isArray(deployment.versions)
      ) {
        throw new Error();
      }
      const activeVersions = deployment.versions.filter(
        (candidate): candidate is { percentage: number; version_id: string } =>
          candidate !== null &&
          typeof candidate === 'object' &&
          !Array.isArray(candidate) &&
          (candidate as { percentage?: unknown }).percentage === 100 &&
          typeof (candidate as { version_id?: unknown }).version_id === 'string'
      );
      if (
        deployment.versions.length !== 1 ||
        activeVersions.length !== 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(activeVersions[0]!.version_id)
      ) {
        throw new Error();
      }
      return {
        deploymentId: deployment.id,
        versionId: activeVersions[0]!.version_id,
      };
    } catch {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_receipt_invalid',
        true
      );
    }
  }

  async readActiveGeneration(): Promise<ControlSecretGenerationReceipt> {
    return this.readActiveGenerationWithin(this.createDeadline());
  }

  async canActivateGeneration(generation: ControlSecretGenerationReceipt): Promise<boolean> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(generation.deploymentId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(generation.versionId)
    ) {
      throw new Error('cloudflare_control_secret_generation_receipt_invalid');
    }
    const deadline = this.createDeadline();
    try {
      const result = await this.run(
        [
          'exec',
          'wrangler',
          'versions',
          'view',
          generation.versionId,
          '--name',
          this.input.workerName,
          '--json',
        ],
        undefined,
        'log',
        deadline
      );
      const parsed = JSON.parse(result.stdout) as unknown;
      return (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as { id?: unknown }).id === generation.versionId
      );
    } catch (error) {
      if (isWranglerSecretCommandTimeout(error)) throw error;
      return false;
    }
  }

  async activateGeneration(
    generation: ControlSecretGenerationReceipt
  ): Promise<ControlSecretGenerationReceipt> {
    if (!(await this.canActivateGeneration(generation))) {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_restore_unavailable',
        true
      );
    }
    const restored = await this.deployGeneration(generation.versionId, this.createDeadline());
    if (restored.versionId !== generation.versionId) {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_restore_mismatch',
        true
      );
    }
    return restored;
  }

  async has(secretName: string): Promise<boolean> {
    return (await this.listNames()).includes(secretName);
  }

  async delete(secretName: string): Promise<void> {
    const deadline = this.createDeadline();
    try {
      await this.run(
        ['exec', 'wrangler', 'secret', 'bulk', '--name', this.input.workerName],
        JSON.stringify({ [secretName]: null }),
        'warn',
        deadline
      );
    } catch {
      if ((await this.listNamesWithin(deadline)).includes(secretName)) {
        throw new CloudflareTokenBootstrapError('cloudflare_control_secret_delete_unconfirmed');
      }
    }
  }
}
