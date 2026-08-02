const SAFE_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const DOMAIN = 'authrim-plugin-installation-id-v1';
const PREFIX = 'plugin-installation-v1-';

export interface PluginInstallationIdentity {
  environmentId: string;
  tenantId: string;
  pluginId: string;
  purpose: string;
}

export async function derivePluginInstallationId(
  input: PluginInstallationIdentity
): Promise<string> {
  if (
    !input ||
    typeof input !== 'object' ||
    !SAFE_COMPONENT.test(input.environmentId) ||
    !SAFE_COMPONENT.test(input.tenantId) ||
    !SAFE_COMPONENT.test(input.pluginId) ||
    !SAFE_COMPONENT.test(input.purpose)
  ) {
    throw new Error('plugin_installation_identity_invalid');
  }
  const canonical = JSON.stringify([
    DOMAIN,
    input.environmentId,
    input.tenantId,
    input.pluginId,
    input.purpose,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `${PREFIX}${hex}`;
}
