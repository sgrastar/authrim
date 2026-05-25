import { describe, expect, it } from 'vitest';
import {
  generateTenantIdFromBytes,
  generateRandomTenantId,
  isValidTenantId,
} from '../core/tenant-id.js';

describe('tenant-id helpers', () => {
  it('generates a valid tenant ID from bytes', () => {
    const tenantId = generateTenantIdFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

    expect(tenantId).toMatch(/^[abcdefghjkmnpqrstuvwxyz]+$/);
    expect(isValidTenantId(tenantId)).toBe(true);
  });

  it('generates URL-safe random tenant IDs', () => {
    const tenantId = generateRandomTenantId();

    expect(tenantId).toMatch(/^[abcdefghjkmnpqrstuvwxyz]{12}$/);
    expect(isValidTenantId(tenantId)).toBe(true);
  });

  it('rejects tenant IDs longer than 63 characters', () => {
    expect(isValidTenantId(`a${'a'.repeat(63)}`)).toBe(false);
  });
});
