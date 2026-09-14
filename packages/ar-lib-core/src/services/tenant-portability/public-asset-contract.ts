export type PublicAssetKeyClassification =
  | { kind: 'asset'; category: 'settings' | 'users'; tenantId: string; filename: string }
  | { kind: 'foreign_tenant' }
  | { kind: 'unsupported' };

/**
 * PUBLIC_ASSETS has direct uploads outside Object Catalog. This identifies a
 * reviewed namespace only, not a snapshot, authorization grant or reference proof.
 * Unknown objects must be reported; URL values are never fetched by this classifier.
 */
export function classifyPublicAssetKey(
  key: string,
  tenantId: string
): PublicAssetKeyClassification {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId)) {
    throw new Error('backup_invalid_settings_tenant_id');
  }
  if (key.length > 512) return { kind: 'unsupported' };
  const settings =
    /^public\/([a-zA-Z0-9_-]{1,128})\/login-ui\/(?:logo|background|panel-background|favicon|thumbnail)\/([A-Za-z0-9._-]+\.(?:gif|ico|jpe?g|png|webp))$/.exec(
      key
    );
  const users =
    /^avatars\/([a-zA-Z0-9_-]{1,128})\/users\/([A-Za-z0-9._-]+\.(?:gif|jpe?g|png|webp))$/.exec(key);
  const match = settings ?? users;
  if (!match) return { kind: 'unsupported' };
  if (match[1] !== tenantId) return { kind: 'foreign_tenant' };
  return { kind: 'asset', category: settings ? 'settings' : 'users', tenantId, filename: match[2] };
}
