export function requireTenantId(tenantId: string | undefined | null, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}
