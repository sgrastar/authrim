import { LOGIN_UI_CLIENT_DESCRIPTION, LOGIN_UI_CLIENT_NAME } from './login-ui-client-metadata';

/**
 * The confidential client @authrim/setup registers for downstream grant introspection
 * (packages/setup/src/core/downstream-introspection-client.ts); the two definitions are kept equal.
 */
export const DOWNSTREAM_INTROSPECTION_CLIENT_NAME = 'Downstream Grant Introspection';
export const DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION =
  'System-managed confidential client used by Authrim for downstream grant introspection.';

const SYSTEM_MANAGED_CLIENTS: ReadonlyArray<{ name: string; description: string }> = [
  { name: LOGIN_UI_CLIENT_NAME, description: LOGIN_UI_CLIENT_DESCRIPTION },
  {
    name: DOWNSTREAM_INTROSPECTION_CLIENT_NAME,
    description: DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
  },
];

/**
 * Whether a client is one Authrim itself registered and keeps (the Login UI's public client, the
 * downstream introspection client): consoles list these apart from the tenant's own apps. The
 * match is the pair of fixed name and description that setup writes, the same pair the Login UI
 * client lookup uses; an administrator's app that reuses only the name is not system-managed.
 */
export function isSystemManagedClient(client: {
  client_name?: string | null;
  description?: string | null;
}): boolean {
  return SYSTEM_MANAGED_CLIENTS.some(
    (system) => client.client_name === system.name && client.description === system.description
  );
}
