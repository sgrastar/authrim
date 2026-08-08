import { execa } from 'execa';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const TOKEN_ID = /^[0-9a-f]{32}$/u;
const SAFE_ENV = /^[a-z][a-z0-9-]{0,31}$/u;
const ACCOUNT_RESOURCE_PREFIX = 'com.cloudflare.api.account.';
const CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

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

export type CloudflareTokenOwnership = 'account' | 'user';
export type ControlTokenResourceClass = 'd1' | 'workers' | 'kv' | 'r2';
type CloudflareTokenCapability = 'allowed' | 'denied';

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
  value?: string;
}

export interface CloudflareTokenAuthority {
  verifySelf(): Promise<{ id: string; status: 'active' | 'disabled' | 'expired' } | null>;
  getToken(tokenId: string): Promise<CloudflareTokenRecord | null>;
  listTokens(): Promise<readonly CloudflareTokenRecord[]>;
  listPermissionGroups(): Promise<readonly CloudflareTokenPermissionGroup[]>;
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
  put(
    secretName:
      | 'CLOUDFLARE_D1_API_TOKEN'
      | 'CLOUDFLARE_WORKERS_API_TOKEN'
      | 'CLOUDFLARE_KV_API_TOKEN'
      | 'CLOUDFLARE_R2_API_TOKEN',
    value: string
  ): Promise<void>;
  listNames?(): Promise<readonly string[]>;
  has(secretName: string): Promise<boolean>;
  delete(secretName: string): Promise<void>;
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
    readonly capabilityDiagnostic?: CloudflareTokenCapabilityDiagnostic
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

async function probeScopedToken(
  fetcher: typeof fetch,
  accountId: string,
  token: string,
  resource: ControlTokenResourceClass
): Promise<CloudflareTokenCapability> {
  const path = {
    d1: `/accounts/${accountId}/d1/database?per_page=1`,
    workers: `/accounts/${accountId}/workers/scripts?per_page=1`,
    kv: `/accounts/${accountId}/storage/kv/namespaces?per_page=1`,
    r2: `/accounts/${accountId}/r2/buckets?per_page=1`,
  }[resource];
  try {
    const response = await fetcher(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    });
    if (response.ok) return 'allowed';
    if (response.status === 401 || response.status === 403) return 'denied';
    throw new CloudflareTokenBootstrapError('cloudflare_token_capability_probe_unavailable');
  } catch {
    throw new CloudflareTokenBootstrapError('cloudflare_token_capability_probe_unavailable');
  }
}

export async function detectCloudflareTokenOwnership(input: {
  accountId: string;
  token: string;
  fetcher?: typeof fetch;
}): Promise<CloudflareTokenOwnership | null> {
  const accountId = requiredAccountId(input.accountId);
  const token = input.token.trim();
  if (!token) throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_input_invalid');
  const fetcher = input.fetcher ?? fetch;
  const verify = async (ownership: CloudflareTokenOwnership): Promise<boolean> => {
    const path =
      ownership === 'account'
        ? `${API_BASE}/accounts/${accountId}/tokens/verify`
        : `${API_BASE}/user/tokens/verify`;
    try {
      const response = await fetcher(path, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
      });
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_verification_failed');
      }
      const payload = (await response.json()) as CloudflareEnvelope<{ status?: string }>;
      if (payload.success !== true || payload.result === undefined) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_verification_failed');
      }
      return payload.result.status === 'active';
    } catch (error) {
      if (error instanceof CloudflareTokenBootstrapError) throw error;
      throw new CloudflareTokenBootstrapError('cloudflare_token_ownership_verification_failed');
    }
  };
  const [account, user] = await Promise.all([verify('account'), verify('user')]);
  if (account === user) return null;
  return account ? 'account' : 'user';
}

/** Capability-probes advanced direct tokens without persisting or returning either value. */
export async function validateDirectControlTokens(input: {
  accountId: string;
  d1Token: string;
  workersToken: string;
  fetcher?: typeof fetch;
}): Promise<CloudflareTokenOwnership> {
  const accountId = requiredAccountId(input.accountId);
  const d1Token = input.d1Token.trim();
  const workersToken = input.workersToken.trim();
  if (!d1Token || !workersToken || d1Token === workersToken) {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_tokens_not_distinct');
  }
  const fetcher = input.fetcher ?? fetch;
  const [d1CanD1, d1CanWorkers, workersCanWorkers, workersCanD1, d1Owner, workersOwner] =
    await Promise.all([
      probeScopedToken(fetcher, accountId, d1Token, 'd1'),
      probeScopedToken(fetcher, accountId, d1Token, 'workers'),
      probeScopedToken(fetcher, accountId, workersToken, 'workers'),
      probeScopedToken(fetcher, accountId, workersToken, 'd1'),
      detectCloudflareTokenOwnership({ fetcher, accountId, token: d1Token }),
      detectCloudflareTokenOwnership({ fetcher, accountId, token: workersToken }),
    ]);
  if (d1CanD1 !== 'allowed' || d1CanWorkers !== 'denied') {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_d1_token_scope_invalid');
  }
  if (workersCanWorkers !== 'allowed' || workersCanD1 !== 'denied') {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_workers_token_scope_invalid');
  }
  if (!d1Owner || d1Owner !== workersOwner) {
    throw new CloudflareTokenBootstrapError('cloudflare_direct_token_ownership_invalid');
  }
  return d1Owner;
}

export async function selectPreferredCloudflareTokenOwnership(input: {
  accountId: string;
  wranglerOAuthToken: string;
  fetcher?: typeof fetch;
}): Promise<CloudflareTokenOwnership> {
  const accountId = requiredAccountId(input.accountId);
  const fetcher = input.fetcher ?? fetch;
  try {
    const response = await fetcher(`${API_BASE}/memberships?per_page=50`, {
      headers: { Authorization: `Bearer ${input.wranglerOAuthToken}` },
    });
    if (!response.ok) return 'user';
    const payload = (await response.json()) as {
      success?: boolean;
      result?: Array<{
        account?: { id?: string };
        status?: string;
        roles?: Array<{ name?: string }>;
      }>;
    };
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
    const capabilities = await Promise.all(
      CONTROL_TOKEN_RESOURCE_CLASSES.map(async (resourceClass) => ({
        resourceClass,
        capability: await input.authority.probeIssuedToken(input.token, resourceClass),
      }))
    );
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
  ownership: CloudflareTokenOwnership
): void {
  const allowedNames =
    ownership === 'account'
      ? ['Account API Tokens Write', 'Account API Tokens Edit']
      : ['API Tokens Write', 'API Tokens Edit'];
  const groups = token.policies.flatMap((policy) => policy.permission_groups);
  if (
    token.status !== 'active' ||
    token.policies.length !== 1 ||
    token.policies[0]?.effect !== 'allow' ||
    groups.length !== 1 ||
    !groups[0]?.name ||
    !allowedNames.includes(groups[0].name)
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_scope_invalid');
  }
}

async function deleteExactNamedTokens(
  authority: CloudflareTokenAuthority,
  tokenName: string
): Promise<void> {
  const matches = (await authority.listTokens()).filter((token) => token.name === tokenName);
  for (const token of matches) {
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
  if (remaining.some((token) => token.name === tokenName)) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_cleanup_unconfirmed', true);
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
  input: { name: string; policies: readonly CloudflareTokenPolicy[] }
): Promise<CloudflareTokenRecord> {
  await deleteExactNamedTokens(authority, input.name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await authority.createToken(input);
    } catch {
      await deleteExactNamedTokens(authority, input.name);
      if (attempt === 1) {
        throw new CloudflareTokenBootstrapError('cloudflare_child_token_create_failed');
      }
    }
  }
  throw new CloudflareTokenBootstrapError('cloudflare_child_token_create_failed');
}

async function putSecretRecoverably(
  sink: ControlSecretSink,
  secretName: Parameters<ControlSecretSink['put']>[0],
  value: string
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await sink.put(secretName, value);
    } catch {
      if (!(await sink.has(secretName)) && attempt === 1) {
        throw new CloudflareTokenBootstrapError('cloudflare_control_secret_registration_failed');
      }
    }
    if (await sink.has(secretName)) return;
  }
  throw new CloudflareTokenBootstrapError('cloudflare_control_secret_registration_failed');
}

async function revokeBootstrap(
  authority: CloudflareTokenAuthority,
  bootstrapTokenId: string
): Promise<void> {
  try {
    await authority.deleteToken(bootstrapTokenId);
  } catch {
    // A lost delete response is successful only if the credential no longer verifies.
  }
  if ((await authority.verifySelf())?.status === 'active') {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_revocation_unconfirmed', true);
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

export async function bootstrapControlWorkerTokens(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  authority: CloudflareTokenAuthority;
  secretSink: ControlSecretSink;
  resourceClasses?: readonly ControlTokenResourceClass[];
  capabilityStabilizationDelaysMs?: readonly number[];
  beforeBootstrapRevocation?: (result: ControlTokenBootstrapPreparedResult) => Promise<void>;
}): Promise<ControlTokenBootstrapResult> {
  const accountId = requiredAccountId(input.accountId);
  requiredEnvironment(input.environment);
  const requestedClasses = input.resourceClasses ?? ['d1', 'workers'];
  const resourceClasses = [...new Set(requestedClasses)];
  if (!resourceClasses.includes('d1') || !resourceClasses.includes('workers')) {
    throw new CloudflareTokenBootstrapError('cloudflare_baseline_child_tokens_required');
  }
  const self = await input.authority.verifySelf();
  if (!self || self.status !== 'active' || !TOKEN_ID.test(self.id)) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_inactive');
  }
  const created: Array<{
    resourceClass: ControlTokenResourceClass;
    token: CloudflareTokenRecord;
    secretName: Parameters<ControlSecretSink['put']>[0];
  }> = [];
  let bootstrapRevoked = false;
  try {
    const bootstrapRecord = await input.authority.getToken(self.id);
    if (!bootstrapRecord || bootstrapRecord.id !== self.id) {
      throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_identity_mismatch');
    }
    validateBootstrapPolicy(bootstrapRecord, input.ownership);
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
      const token = await createRecoverably(input.authority, {
        name: tokenName,
        policies: [
          {
            effect: 'allow',
            permission_groups: [{ id: permissionGroup.id }],
            resources: { [`${ACCOUNT_RESOURCE_PREFIX}${accountId}`]: '*' },
          },
        ],
      });
      const duplicate = created.some(
        (candidate) =>
          candidate.token.id === token.id ||
          (candidate.token.value !== undefined && candidate.token.value === token.value)
      );
      created.push({ resourceClass, token, secretName: spec.secretName });
      if (!token.value || token.id === self.id || token.value === bootstrapRecord.value) {
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
      await putSecretRecoverably(input.secretSink, spec.secretName, token.value);
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
      })),
    };
    await input.beforeBootstrapRevocation?.(preparedResult);
    await revokeBootstrap(input.authority, self.id);
    bootstrapRevoked = true;
    return {
      ...preparedResult,
      bootstrapRevoked: true,
    };
  } catch (error) {
    let cleanupRequired = false;
    if (!bootstrapRevoked) {
      for (const child of created) {
        try {
          await input.authority.deleteToken(child.token.id);
          await input.secretSink.delete(child.secretName);
          if (await input.secretSink.has(child.secretName)) cleanupRequired = true;
        } catch {
          cleanupRequired = true;
        }
      }
      try {
        const remainingIds = new Set((await input.authority.listTokens()).map((token) => token.id));
        if (created.some((child) => remainingIds.has(child.token.id))) cleanupRequired = true;
      } catch {
        cleanupRequired = true;
      }
      try {
        await revokeBootstrap(input.authority, self.id);
      } catch {
        cleanupRequired = true;
      }
    }
    if (error instanceof CloudflareTokenBootstrapError) {
      throw new CloudflareTokenBootstrapError(
        error.code,
        error.cleanupRequired || cleanupRequired,
        error.capabilityDiagnostic
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
  };
}

export class CloudflareTokenAuthorityHttpClient implements CloudflareTokenAuthority {
  constructor(
    private readonly input: {
      accountId: string;
      ownership: CloudflareTokenOwnership;
      bootstrapToken: string;
      fetcher?: typeof fetch;
      tokenApiRetryDelaysMs?: readonly number[];
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

  private async requestEnvelope<T>(
    path: string,
    init: Parameters<typeof fetch>[1] = {}
  ): Promise<CloudflareEnvelope<T>> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const retryableRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const retryDelays = retryableRead
      ? (this.input.tokenApiRetryDelaysMs ?? CLOUDFLARE_TOKEN_API_RETRY_DELAYS_MS)
      : [];
    let response: Response | undefined;
    let lastTransportError = false;

    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await this.fetcher(path, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.input.bootstrapToken}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
          },
        });
        lastTransportError = false;
      } catch {
        lastTransportError = true;
      }

      const retryDelay = retryDelays[attempt];
      if (
        retryDelay !== undefined &&
        (lastTransportError ||
          (response !== undefined && isRetryableTokenApiStatus(response.status)))
      ) {
        await waitForTokenApiRetry(retryDelay);
        continue;
      }
      break;
    }

    if (lastTransportError || response === undefined) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_response_lost');
    }
    if (!response.ok) {
      throw new CloudflareTokenBootstrapError(`cloudflare_token_api_http_${response.status}`);
    }
    const payload = (await response.json()) as CloudflareEnvelope<T>;
    if (payload.success === false || payload.result === undefined) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_rejected');
    }
    return payload;
  }

  private async request<T>(path: string, init: Parameters<typeof fetch>[1] = {}): Promise<T> {
    return (await this.requestEnvelope<T>(path, init)).result!;
  }

  async verifySelf() {
    try {
      return await this.request<{ id: string; status: 'active' | 'disabled' | 'expired' }>(
        `${this.tokenBase}/verify`
      );
    } catch (error) {
      if (
        error instanceof CloudflareTokenBootstrapError &&
        (error.code === 'cloudflare_token_api_http_401' ||
          error.code === 'cloudflare_token_api_http_403')
      ) {
        return null;
      }
      throw error;
    }
  }

  async getToken(tokenId: string): Promise<CloudflareTokenRecord | null> {
    if (!TOKEN_ID.test(tokenId)) throw new Error('cloudflare_token_id_invalid');
    try {
      return await this.request<CloudflareTokenRecord>(`${this.tokenBase}/${tokenId}`);
    } catch {
      return null;
    }
  }

  async listTokens(): Promise<readonly CloudflareTokenRecord[]> {
    const tokens: CloudflareTokenRecord[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const payload = await this.requestEnvelope<CloudflareTokenRecord[]>(
        `${this.tokenBase}?per_page=50&page=${page}`
      );
      const batch = payload.result!;
      tokens.push(...batch);
      const totalCount = payload.result_info?.total_count;
      if (batch.length < 50 || (totalCount !== undefined && tokens.length >= totalCount)) {
        return tokens;
      }
    }
    throw new CloudflareTokenBootstrapError('cloudflare_token_inventory_too_large', true);
  }

  listPermissionGroups(): Promise<readonly CloudflareTokenPermissionGroup[]> {
    return this.request<CloudflareTokenPermissionGroup[]>(
      `${this.tokenBase}/permission_groups?scope=com.cloudflare.api.account`
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
      const response = await this.fetcher(path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as CloudflareEnvelope<{
        id: string;
        status: 'active' | 'disabled' | 'expired';
      }>;
      return payload.success === false ? null : (payload.result ?? null);
    } catch {
      return null;
    }
  }

  probeIssuedToken(
    token: string,
    resourceClass: ControlTokenResourceClass
  ): Promise<CloudflareTokenCapability> {
    return probeScopedToken(this.fetcher, this.input.accountId, token, resourceClass);
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
  }
) => Promise<WranglerSecretCommandResult>;

async function defaultWranglerSecretCommandRunner(
  command: string,
  args: readonly string[],
  options: { cwd: string; input?: string; env: Record<string, string> }
): Promise<WranglerSecretCommandResult> {
  const result = await execa(command, [...args], options);
  return { stdout: result.stdout };
}

/** Uploads generated values through stdin only; values never enter argv or a local file. */
export class WranglerControlSecretSink implements ControlSecretSink {
  constructor(
    private readonly input: {
      workerName: string;
      cwd: string;
      runner?: WranglerSecretCommandRunner;
    }
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.workerName)) {
      throw new Error('cloudflare_control_worker_name_invalid');
    }
  }

  private run(
    args: readonly string[],
    input?: string,
    logLevel: 'log' | 'warn' = 'warn'
  ): Promise<WranglerSecretCommandResult> {
    return (this.input.runner ?? defaultWranglerSecretCommandRunner)('pnpm', args, {
      cwd: this.input.cwd,
      ...(input === undefined ? {} : { input }),
      env: { WRANGLER_LOG: logLevel },
    });
  }

  async put(secretName: Parameters<ControlSecretSink['put']>[0], value: string): Promise<void> {
    if (!value.trim()) throw new Error('cloudflare_control_secret_value_invalid');
    try {
      await this.run(
        ['exec', 'wrangler', 'secret', 'put', secretName, '--name', this.input.workerName],
        value
      );
    } catch {
      throw new CloudflareTokenBootstrapError('cloudflare_control_secret_put_response_lost');
    }
  }

  async listNames(): Promise<readonly string[]> {
    let result: WranglerSecretCommandResult;
    try {
      result = await this.run(
        ['exec', 'wrangler', 'secret', 'list', '--name', this.input.workerName, '--format', 'json'],
        undefined,
        'log'
      );
    } catch {
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

  async has(secretName: string): Promise<boolean> {
    return (await this.listNames()).includes(secretName);
  }

  async delete(secretName: string): Promise<void> {
    try {
      await this.run(
        ['exec', 'wrangler', 'secret', 'bulk', '--name', this.input.workerName],
        JSON.stringify({ [secretName]: null })
      );
    } catch {
      if (await this.has(secretName)) {
        throw new CloudflareTokenBootstrapError('cloudflare_control_secret_delete_unconfirmed');
      }
    }
  }
}
