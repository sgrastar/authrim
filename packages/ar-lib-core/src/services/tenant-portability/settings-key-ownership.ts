export type SettingsKeyOwnership =
  | { kind: 'tenant_override'; tenantId: string; category: string }
  | { kind: 'client_override'; tenantId: string; clientId: string; category: string }
  | { kind: 'platform_dependency'; category: string }
  | { kind: 'foreign_tenant' }
  | { kind: 'unsupported'; reason: 'key_shape' | 'category' | 'client_reference' };

const keyPart = /^[a-zA-Z0-9_-]{1,128}$/;

export type DirectoryConnectorSecretOwnership =
  | { kind: 'tenant_secret'; tenantId: string; connectorId: string }
  | { kind: 'foreign_tenant' }
  | { kind: 'unsupported'; reason: 'key_shape' | 'connector_reference' };

/**
 * Directory connector managed secrets use a separate five-part key, not a
 * SettingsManager category document. Resolve only against the pinned connector
 * configuration's IDs. This identifies a secret dependency; it does not authorize
 * reading its value, and the adapter must retain active and previous key versions.
 */
export function directoryConnectorSecretKeyOwnership(
  key: string,
  context: { tenantId: string; connectorIds: ReadonlySet<string> }
): DirectoryConnectorSecretOwnership {
  if (!keyPart.test(context.tenantId)) throw new Error('backup_invalid_settings_tenant_id');
  if (key.length > 512) return { kind: 'unsupported', reason: 'key_shape' };
  const parts = key.split(':');
  if (
    parts.length !== 5 ||
    parts[0] !== 'settings' ||
    parts[1] !== 'tenant' ||
    !keyPart.test(parts[2]) ||
    parts[3] !== 'directory-connector-secret' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(parts[4])
  ) {
    return { kind: 'unsupported', reason: 'key_shape' };
  }
  if (parts[2] !== context.tenantId) return { kind: 'foreign_tenant' };
  if (!context.connectorIds.has(parts[4])) {
    return { kind: 'unsupported', reason: 'connector_reference' };
  }
  return { kind: 'tenant_secret', tenantId: context.tenantId, connectorId: parts[4] };
}

/**
 * Classify one exact SettingsManager key against a pinned, reviewed category/client inventory.
 * This does not authorize export, establish a KV snapshot, or permit copying platform settings.
 * Unknown keys are blockers for the calling module, never an implicit whole-namespace export.
 */
export function settingsKeyOwnership(
  key: string,
  context: {
    tenantId: string;
    reviewedCategories: ReadonlySet<string>;
    clientIds: ReadonlySet<string>;
  }
): SettingsKeyOwnership {
  if (!keyPart.test(context.tenantId)) throw new Error('backup_invalid_settings_tenant_id');
  // Bound work before splitting untrusted manifest/key input.
  if (key.length > 4 * 128 + 32) return { kind: 'unsupported', reason: 'key_shape' };
  const parts = key.split(':');
  const scope = parts[1];
  const expectedParts =
    scope === 'platform' ? 3 : scope === 'tenant' ? 4 : scope === 'client' ? 5 : 0;
  if (
    parts[0] !== 'settings' ||
    parts.length !== expectedParts ||
    !parts.every((part) => keyPart.test(part))
  ) {
    return { kind: 'unsupported', reason: 'key_shape' };
  }
  // A malformed key never becomes a foreign-tenant exclusion. A structurally valid foreign
  // tenant key, however, must not require discovering that tenant's clients or configuration.
  if (scope !== 'platform' && parts[2] !== context.tenantId) return { kind: 'foreign_tenant' };
  const category = parts[parts.length - 1];
  if (!context.reviewedCategories.has(category)) return { kind: 'unsupported', reason: 'category' };
  if (scope === 'platform') return { kind: 'platform_dependency', category };
  if (scope === 'tenant') return { kind: 'tenant_override', tenantId: context.tenantId, category };
  const clientId = parts[3];
  if (!context.clientIds.has(clientId)) return { kind: 'unsupported', reason: 'client_reference' };
  return { kind: 'client_override', tenantId: context.tenantId, clientId, category };
}
