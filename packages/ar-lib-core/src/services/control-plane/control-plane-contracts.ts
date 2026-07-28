export type ControlOperationStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type LookupLifecycleState = 'pending' | 'active' | 'disabled';
export type AccountDirectoryPublicationState =
  | 'pending'
  | 'active_pending_directory'
  | 'active'
  | 'disabled';
export type D1ConsistencyClass = 'replica_eligible' | 'primary_required' | 'read_after_write';

export interface D1ConsistencyRequest {
  consistencyClass: D1ConsistencyClass;
  bookmark: string | null;
}

export interface DirectoryRewriteLeaseState {
  operationId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  mutationStarted: boolean;
}

const OPERATION_TRANSITIONS: Readonly<
  Record<ControlOperationStatus, readonly ControlOperationStatus[]>
> = {
  pending: ['running', 'blocked', 'cancelled'],
  running: ['waiting', 'succeeded', 'failed', 'blocked'],
  waiting: ['running', 'failed', 'blocked', 'cancelled'],
  succeeded: [],
  failed: [],
  blocked: ['running', 'cancelled'],
  cancelled: [],
};

const LOOKUP_TRANSITIONS: Readonly<Record<LookupLifecycleState, readonly LookupLifecycleState[]>> =
  {
    pending: ['active', 'disabled'],
    active: ['disabled'],
    disabled: [],
  };

const DIRECTORY_PUBLICATION_TRANSITIONS: Readonly<
  Record<AccountDirectoryPublicationState, readonly AccountDirectoryPublicationState[]>
> = {
  pending: ['active_pending_directory', 'disabled'],
  active_pending_directory: ['active', 'disabled'],
  active: ['disabled'],
  disabled: [],
};

const SENSITIVE_CONTROL_KEY_PATTERN =
  /(^|_)(api_token|authorization|cloudflare_token|credential_value|hmac_key_body|private_jwk|private_key|raw_email|secret_value)(_|$)/i;

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function assertSafeString(value: string, path: string): void {
  if (/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/u.test(value) || /^Bearer\s+\S+/iu.test(value)) {
    throw new Error(`control_plane_sensitive_value_forbidden:${path}`);
  }
}

export function assertControlPlaneRecordIsSecretFree(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    assertSafeString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertControlPlaneRecordIsSecretFree(entry, `${path}[${index}]`)
    );
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_CONTROL_KEY_PATTERN.test(normalizedKey(key))) {
      throw new Error(`control_plane_sensitive_key_forbidden:${childPath}`);
    }
    assertControlPlaneRecordIsSecretFree(entryValue, childPath);
  }
}

export function assertControlOperationTransition(
  from: ControlOperationStatus,
  to: ControlOperationStatus
): void {
  if (!OPERATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid_control_operation_transition:${from}:${to}`);
  }
}

export function assertLookupLifecycleTransition(
  from: LookupLifecycleState,
  to: LookupLifecycleState,
  gate: { tenantActive: boolean; runtimeRouteActive: boolean }
): void {
  if (!LOOKUP_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid_lookup_lifecycle_transition:${from}:${to}`);
  }
  if (to === 'active' && (!gate.tenantActive || !gate.runtimeRouteActive)) {
    throw new Error('lookup_activation_gate_not_satisfied');
  }
}

export function assertAccountDirectoryPublicationTransition(
  from: AccountDirectoryPublicationState,
  to: AccountDirectoryPublicationState
): void {
  if (!DIRECTORY_PUBLICATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid_account_directory_transition:${from}:${to}`);
  }
}

export function createD1ConsistencyRequest(
  consistencyClass: D1ConsistencyClass,
  bookmark?: string | null
): D1ConsistencyRequest {
  const normalizedBookmark = bookmark?.trim() || null;
  if (consistencyClass === 'read_after_write' && !normalizedBookmark) {
    throw new Error('d1_read_after_write_bookmark_required');
  }
  if (consistencyClass !== 'read_after_write' && normalizedBookmark) {
    throw new Error(`d1_bookmark_not_allowed_for:${consistencyClass}`);
  }
  return { consistencyClass, bookmark: normalizedBookmark };
}

export function assertTenantShardWriteOwnership(
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii',
  entityKind: 'tenant_metadata' | 'account' | 'identifier' | 'credential' | 'pii_profile'
): void {
  if (entityKind === 'tenant_metadata' && dataRole !== 'tenant_core/default') {
    throw new Error(`tenant_metadata_write_forbidden_for:${dataRole}`);
  }
  if (
    dataRole === 'tenant_core/default' &&
    ['account', 'identifier', 'credential', 'pii_profile'].includes(entityKind)
  ) {
    throw new Error(`account_data_write_forbidden_for:${dataRole}`);
  }
  if (dataRole === 'tenant_core/users' && entityKind === 'pii_profile') {
    throw new Error(`pii_write_forbidden_for:${dataRole}`);
  }
  if (dataRole === 'tenant_pii' && entityKind !== 'pii_profile') {
    throw new Error(`non_pii_write_forbidden_for:${dataRole}`);
  }
}

export function nextDirectoryRewriteFencingToken(input: {
  current: DirectoryRewriteLeaseState | null;
  nextOperationId: string;
  now: number;
}): number {
  const nextOperationId = input.nextOperationId.trim();
  if (!nextOperationId) throw new Error('directory_rewrite_operation_id_required');
  if (!input.current) return 1;
  if (input.current.leaseExpiresAt > input.now) {
    throw new Error('directory_rewrite_lease_active');
  }
  if (input.current.operationId !== nextOperationId && input.current.mutationStarted) {
    throw new Error('directory_rewrite_cross_operation_takeover_forbidden_after_mutation');
  }
  return input.current.fencingToken + 1;
}
