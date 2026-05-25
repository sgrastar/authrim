function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function createOpaqueTenantKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `t_${base64Url(bytes)}`;
}

/**
 * Transitional tenant key derivation used until tenant creation stores a random
 * opaque tenant_key in the tenant registry. The output is safe for R2 paths and
 * prevents raw tenant_id from appearing in hot archive object keys.
 */
export async function deriveTenantKeyFromTenantId(
  tenantId: string,
  salt?: string
): Promise<string> {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error('tenant_id_required');
  }

  const material = salt ? `${salt}:${normalized}` : normalized;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return `t_${base64Url(new Uint8Array(digest)).slice(0, 32)}`;
}
