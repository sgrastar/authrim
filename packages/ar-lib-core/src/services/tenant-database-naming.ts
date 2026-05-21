import type { TenantDatabaseRole } from '../repositories/admin/tenant-database-registry';

export interface TenantDatabaseNamingInput {
  environment: string;
  tenantId: string;
  role: TenantDatabaseRole;
  tenantSlug?: string | null;
  shardIndex?: number;
}

export interface TenantDatabaseBindingPlan {
  databaseName: string;
  bindingRef: string;
  workerShard: string;
}

export interface TenantDatabaseSlotBindingPlan {
  databaseName: string;
  bindingRef: string;
  slotNumber: number;
  workerShard: string;
}

export interface TenantDatabaseBindingCapacity {
  currentBindings: number;
  addedBindings: number;
  projectedBindings: number;
  warningThreshold: number;
  hardLimit: number;
  state: 'ok' | 'warning' | 'exceeds_limit';
}

const ROLE_SUFFIX: Record<TenantDatabaseRole, string> = {
  tenant_core: 'CORE',
  tenant_pii: 'PII',
  tenant_audit: 'AUDIT',
  tenant_custom: 'CUSTOM',
};

const ROLE_DATABASE_SUFFIX: Record<TenantDatabaseRole, string> = {
  tenant_core: 'core',
  tenant_pii: 'pii',
  tenant_audit: 'audit',
  tenant_custom: 'custom',
};

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

function trimToLength(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizeNamePartWithSeparator(
  value: string,
  fallback: string,
  transform: (input: string) => string,
  separator: string,
  isAllowed: (charCode: number) => boolean
): string {
  const input = transform(value.trim());
  let normalized = '';
  let pendingSeparator = false;

  for (let i = 0; i < input.length; i += 1) {
    const charCode = input.charCodeAt(i);
    if (isAllowed(charCode)) {
      if (pendingSeparator && normalized.length > 0) {
        normalized += separator;
      }
      normalized += input[i];
      pendingSeparator = false;
    } else {
      pendingSeparator = normalized.length > 0;
    }
  }

  return normalized || fallback;
}

export function normalizeTenantDatabaseNamePart(value: string, fallback: string): string {
  return normalizeNamePartWithSeparator(
    value,
    fallback,
    (input) => input.toLowerCase(),
    '-',
    (charCode) => (charCode >= 97 && charCode <= 122) || (charCode >= 48 && charCode <= 57)
  );
}

export function normalizeTenantBindingNamePart(value: string, fallback: string): string {
  return normalizeNamePartWithSeparator(
    value,
    fallback,
    (input) => input.toUpperCase(),
    '_',
    (charCode) => (charCode >= 65 && charCode <= 90) || (charCode >= 48 && charCode <= 57)
  );
}

export function buildTenantDatabaseBindingPlan(
  input: TenantDatabaseNamingInput
): TenantDatabaseBindingPlan {
  const environment = normalizeTenantDatabaseNamePart(input.environment, 'env');
  const tenantName = trimToLength(
    normalizeTenantDatabaseNamePart(input.tenantSlug ?? input.tenantId, 'tenant'),
    40
  );
  const bindingTenant = trimToLength(
    normalizeTenantBindingNamePart(input.tenantSlug ?? input.tenantId, 'TENANT'),
    32
  );
  const roleSuffix = ROLE_SUFFIX[input.role];
  const databaseRole = ROLE_DATABASE_SUFFIX[input.role];
  const shardSuffix =
    input.shardIndex !== undefined && input.shardIndex > 0 ? `-s${input.shardIndex}` : '';
  const bindingShard =
    input.shardIndex !== undefined && input.shardIndex > 0 ? `_S${input.shardIndex}` : '';
  const shortHash = fnv1a32(
    `${environment}:${input.tenantId}:${input.tenantSlug ?? ''}:${input.role}:${input.shardIndex ?? 0}`
  );

  return {
    databaseName: `authrim-${environment}-${tenantName}-${databaseRole}${shardSuffix}`,
    bindingRef: `TDB_${bindingTenant}_${shortHash}_${roleSuffix}${bindingShard}`,
    workerShard: 'primary',
  };
}

export function formatTenantDatabaseSlotNumber(slotNumber: number): string {
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 500) {
    throw new Error('tenant_database_slot_number_out_of_range');
  }
  return slotNumber.toString().padStart(4, '0');
}

export function buildTenantDatabaseSlotBindingPlan(input: {
  environment: string;
  slotNumber: number;
  role: TenantDatabaseRole;
}): TenantDatabaseSlotBindingPlan {
  const environment = normalizeTenantDatabaseNamePart(input.environment, 'env');
  const slot = formatTenantDatabaseSlotNumber(input.slotNumber);
  const roleSuffix = ROLE_SUFFIX[input.role];
  const databaseRole = ROLE_DATABASE_SUFFIX[input.role];
  return {
    databaseName: `authrim-${environment}-tdb-slot-${slot}-${databaseRole}`,
    bindingRef: `TDB_SLOT_${slot}_${roleSuffix}`,
    slotNumber: input.slotNumber,
    workerShard: 'primary',
  };
}

export function evaluateTenantDatabaseBindingCapacity(options: {
  currentBindings: number;
  tenantsToAdd: number;
  rolesPerTenant?: number;
  warningThreshold?: number;
  hardLimit?: number;
}): TenantDatabaseBindingCapacity {
  const rolesPerTenant = options.rolesPerTenant ?? 2;
  const warningThreshold = options.warningThreshold ?? 3000;
  const hardLimit = options.hardLimit ?? 5000;
  const addedBindings = options.tenantsToAdd * rolesPerTenant;
  const projectedBindings = options.currentBindings + addedBindings;

  return {
    currentBindings: options.currentBindings,
    addedBindings,
    projectedBindings,
    warningThreshold,
    hardLimit,
    state:
      projectedBindings >= hardLimit
        ? 'exceeds_limit'
        : projectedBindings >= warningThreshold
          ? 'warning'
          : 'ok',
  };
}
