import type { AgentResourceRequestContext, JsonObject } from './types';

const CLIENT_METADATA_FIELDS = new Set(['client_name', 'description', 'logo_uri', 'client_uri']);
const CONTROL_FIELDS = new Set(['client_id', 'user_id', 'resource_version']);

/**
 * Derives the authorization resource from a fixed Tool contract and its validated arguments.
 * Callers may replace the tenant for an already-resolved Bulk target, but may not supply a
 * client-authored domain or resource identifier.
 */
export function buildAgentToolResourceContext(input: {
  base: AgentResourceRequestContext;
  toolId: string;
  arguments: JsonObject;
  tenantId?: string;
}): AgentResourceRequestContext {
  const { toolId, arguments: arguments_ } = input;
  const domain =
    toolId === 'admin.read.runtime.diagnostics'
      ? 'runtime_diagnostics'
      : toolId.startsWith('admin.read.users.') || toolId.startsWith('admin.write.users.')
        ? 'users'
        : toolId.startsWith('admin.read.clients.') || toolId.startsWith('admin.write.clients.')
          ? 'clients'
          : toolId.startsWith('admin.read.identity-providers.')
            ? 'identity_providers'
            : toolId.startsWith('admin.read.authorization.')
              ? 'authorization'
              : toolId.startsWith('admin.read.flows.')
                ? 'flows'
                : toolId.startsWith('admin.read.consent.')
                  ? 'consent'
                  : toolId.startsWith('admin.read.sessions.')
                    ? 'sessions'
                    : toolId.startsWith('admin.read.assurance.')
                      ? 'assurance'
                      : toolId.startsWith('admin.read.protocol-security.') ||
                          toolId.startsWith('admin.read.oauth.') ||
                          toolId.startsWith('admin.read.token-exchange.') ||
                          toolId.startsWith('admin.write.protocol-security.') ||
                          toolId.startsWith('admin.write.oauth.') ||
                          toolId.startsWith('admin.write.token-exchange.')
                        ? 'protocol_security'
                        : toolId.startsWith('admin.read.logout.') ||
                            toolId.startsWith('admin.write.session.')
                          ? 'logout'
                          : toolId.startsWith('admin.read.login-ui.') ||
                              toolId.startsWith('admin.write.login-ui.')
                            ? 'login_ui'
                            : toolId.startsWith('admin.read.conformance.')
                              ? 'conformance'
                              : toolId.startsWith('admin.read.webhooks.')
                                ? 'webhooks'
                                : toolId.startsWith('admin.read.audit.')
                                  ? 'admin_audit'
                                  : toolId.startsWith('admin.read.agent-settings.')
                                    ? 'agent_settings'
                                    : toolId.includes('.configuration.')
                                      ? 'configuration'
                                      : toolId.includes('.bulk.')
                                        ? 'bulk_plans'
                                        : input.base.domain;
  const candidateId = arguments_.user_id ?? arguments_.client_id;
  const quantity = arguments_.page_size;
  const requestedFields =
    toolId === 'admin.write.clients.metadata'
      ? Object.keys(arguments_).filter((key) => CLIENT_METADATA_FIELDS.has(key))
      : toolId === 'admin.write.users.suspend'
        ? ['status']
        : toolId.startsWith('admin.write.') && !toolId.includes('.plan.')
          ? Object.keys(arguments_).filter((key) => !CONTROL_FIELDS.has(key))
          : undefined;

  return {
    ...input.base,
    tenantId: input.tenantId ?? input.base.tenantId,
    domain,
    resourceId: typeof candidateId === 'string' ? candidateId : input.base.resourceId,
    ...(requestedFields && requestedFields.length > 0 ? { requestedFields } : {}),
    quantity: typeof quantity === 'number' ? quantity : 1,
    requestsUnmaskedPii: false,
  };
}
