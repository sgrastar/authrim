const SAFE_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const DOMAIN = 'authrim-notification-installation-id-v1';
const PREFIX = 'notification-installation-v1-';

export interface NotificationInstallationIdentity {
  environmentId: string;
  tenantId: string;
  pluginId: string;
  purpose: string;
}

function validate(input: NotificationInstallationIdentity): void {
  if (
    !input ||
    typeof input !== 'object' ||
    !SAFE_COMPONENT.test(input.environmentId) ||
    !SAFE_COMPONENT.test(input.tenantId) ||
    !SAFE_COMPONENT.test(input.pluginId) ||
    !SAFE_COMPONENT.test(input.purpose)
  ) {
    throw new Error('notification_installation_identity_invalid');
  }
}

export async function deriveNotificationInstallationId(
  input: NotificationInstallationIdentity
): Promise<string> {
  validate(input);
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
