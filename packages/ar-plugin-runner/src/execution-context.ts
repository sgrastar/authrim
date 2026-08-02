import type { PluginEgressContext, PluginExecutionScope } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_REQUEST_ID = /^[\x21-\x7e]{1,256}$/u;
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const SAFE_BINDING = /^TDB_[A-Z0-9_]{1,120}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function executionScope(input: unknown): PluginExecutionScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_egress_context_invalid');
  }
  const value = input as Record<string, unknown>;
  const hasAccountId = value.accountId !== undefined;
  if (
    !exactKeys(value, [
      ...(hasAccountId ? ['accountId'] : []),
      'bindingRef',
      'dataRole',
      'residencyPartition',
    ]) ||
    (hasAccountId && (typeof value.accountId !== 'string' || !SAFE_ID.test(value.accountId))) ||
    typeof value.bindingRef !== 'string' ||
    !SAFE_BINDING.test(value.bindingRef) ||
    (value.dataRole !== 'tenant_core/default' && value.dataRole !== 'tenant_core/users') ||
    typeof value.residencyPartition !== 'string' ||
    !SAFE_PARTITION.test(value.residencyPartition)
  ) {
    throw new Error('plugin_egress_context_invalid');
  }
  return {
    bindingRef: value.bindingRef,
    dataRole: value.dataRole,
    residencyPartition: value.residencyPartition,
    ...(hasAccountId ? { accountId: value.accountId as string } : {}),
  };
}

export function parsePluginExecutionContext(input: unknown): PluginEgressContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_egress_context_invalid');
  }
  const value = input as Record<string, unknown>;
  const expectedKeys = [
    'capability',
    'contractVersion',
    'pluginInstallationId',
    'requestId',
    'tenantId',
    ...(value.executionScope === undefined ? [] : ['executionScope']),
  ];
  if (
    !exactKeys(value, expectedKeys) ||
    value.contractVersion !== 1 ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.pluginInstallationId !== 'string' ||
    !SAFE_ID.test(value.pluginInstallationId) ||
    typeof value.capability !== 'string' ||
    !SAFE_CAPABILITY.test(value.capability) ||
    typeof value.requestId !== 'string' ||
    !SAFE_REQUEST_ID.test(value.requestId)
  ) {
    throw new Error('plugin_egress_context_invalid');
  }
  return {
    contractVersion: 1,
    tenantId: value.tenantId,
    pluginInstallationId: value.pluginInstallationId,
    capability: value.capability,
    requestId: value.requestId,
    ...(value.executionScope === undefined
      ? {}
      : { executionScope: executionScope(value.executionScope) }),
  };
}
