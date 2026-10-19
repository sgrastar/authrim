/**
 * The tenant ID that owns the platform-wide Mapping Sets (and the rows under them). It is a
 * namespace of the Admin database, not a tenant: no tenant may be created under this ID, so a
 * row owned by it can never belong to a customer.
 */
export const PLATFORM_MAPPING_TENANT_ID = 'platform';

/**
 * Whether `value` would name the platform namespace once case and surrounding whitespace are
 * ignored. Tenant creation refuses such an ID, so it cannot be registered under a spelling that
 * a later normalisation would fold into the platform's.
 */
export function isReservedPlatformTenantId(value: string): boolean {
  return value.trim().toLowerCase() === PLATFORM_MAPPING_TENANT_ID;
}

/** A call asked to read rows of a tenant ID it may not read, or to search where it may not. */
export class RuntimeIdentityMappingOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeIdentityMappingOwnerError';
  }
}
