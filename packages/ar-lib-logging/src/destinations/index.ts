export type DestinationKind =
  | 'object_storage'
  | 'http_sink'
  | 'external_collector'
  | 'database'
  | 'custom';

export type DestinationProvider =
  | 'r2'
  | 'aws_s3'
  | 'sftp'
  | 'http'
  | 'logpush'
  | 'analytics_engine'
  | 'firehose'
  | 'external'
  | 'custom';

export type DestinationCapability =
  | 'archive_write'
  | 'sensitive_detail_write'
  | 'log_sink_write'
  | 'dlq_replay_payload_write'
  | 'export_artifact_write';

export type DestinationScopeType = 'platform' | 'tenant' | 'shared';

export type DestinationLifecycleStatus = 'active' | 'disabled' | 'deleted';

export type DestinationHealthStatus =
  | 'unknown'
  | 'configured'
  | 'healthy'
  | 'degraded'
  | 'failing'
  | 'unreachable';

export type DestinationEncryptionMode = 'platform_managed' | 'external_managed' | 'none';

export interface DestinationCapabilityPolicy {
  allowedTenantIds?: string[];
  allowedLogTypes?: string[];
  allowedPlanes?: string[];
  region?: string | null;
  criticalAllowed?: boolean;
  defaultFallbackEligible?: boolean;
  retentionDays?: number | null;
  encryptionMode?: DestinationEncryptionMode;
}

export interface LoggingDestination {
  id: string;
  scopeType: DestinationScopeType;
  scopeId: string | null;
  destinationKind: DestinationKind;
  provider: DestinationProvider;
  name: string;
  displayName: string;
  lifecycleStatus: DestinationLifecycleStatus;
  healthStatus: DestinationHealthStatus;
  providerConfig: Record<string, unknown>;
  capabilityPolicy: DestinationCapabilityPolicy;
}

export interface DestinationProviderSchema {
  provider: DestinationProvider;
  destinationKind: DestinationKind;
  requiredFields: string[];
  optionalFields: string[];
  defaultCapabilities: DestinationCapability[];
}

export const DESTINATION_PROVIDER_SCHEMAS: Record<DestinationProvider, DestinationProviderSchema> =
  {
    r2: {
      provider: 'r2',
      destinationKind: 'object_storage',
      requiredFields: ['bindingRef'],
      optionalFields: ['prefix', 'region', 'storageClass'],
      defaultCapabilities: ['archive_write', 'sensitive_detail_write', 'dlq_replay_payload_write'],
    },
    aws_s3: {
      provider: 'aws_s3',
      destinationKind: 'object_storage',
      requiredFields: ['bucket', 'region'],
      optionalFields: ['prefix', 'endpoint', 'forcePathStyle'],
      defaultCapabilities: ['archive_write', 'sensitive_detail_write', 'dlq_replay_payload_write'],
    },
    sftp: {
      provider: 'sftp',
      destinationKind: 'object_storage',
      requiredFields: ['host', 'path'],
      optionalFields: ['port', 'username', 'knownHostFingerprint'],
      defaultCapabilities: ['archive_write', 'export_artifact_write'],
    },
    http: {
      provider: 'http',
      destinationKind: 'http_sink',
      requiredFields: ['url'],
      optionalFields: ['authProfile', 'headerProfile', 'timeoutMs'],
      defaultCapabilities: ['log_sink_write'],
    },
    logpush: {
      provider: 'logpush',
      destinationKind: 'external_collector',
      requiredFields: ['dataset'],
      optionalFields: ['destinationConf', 'enabled'],
      defaultCapabilities: ['log_sink_write'],
    },
    analytics_engine: {
      provider: 'analytics_engine',
      destinationKind: 'external_collector',
      requiredFields: ['dataset'],
      optionalFields: ['indexFields'],
      defaultCapabilities: ['log_sink_write'],
    },
    firehose: {
      provider: 'firehose',
      destinationKind: 'external_collector',
      requiredFields: ['streamArn', 'region'],
      optionalFields: ['roleArn'],
      defaultCapabilities: ['log_sink_write'],
    },
    external: {
      provider: 'external',
      destinationKind: 'external_collector',
      requiredFields: ['connector'],
      optionalFields: ['config'],
      defaultCapabilities: ['log_sink_write'],
    },
    custom: {
      provider: 'custom',
      destinationKind: 'custom',
      requiredFields: ['type'],
      optionalFields: ['config'],
      defaultCapabilities: [],
    },
  };

export interface DestinationProviderConfigValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
  schema: DestinationProviderSchema;
}

export function validateDestinationProviderConfig(
  provider: DestinationProvider,
  config: Record<string, unknown>
): DestinationProviderConfigValidationResult {
  const schema = DESTINATION_PROVIDER_SCHEMAS[provider];
  const errors: Array<{ field: string; message: string }> = [];

  for (const field of schema.requiredFields) {
    const value = config[field];
    if (value === undefined || value === null || value === '') {
      errors.push({ field, message: 'required' });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    schema,
  };
}

export function getDefaultDestinationCapabilities(
  provider: DestinationProvider
): DestinationCapability[] {
  return [...DESTINATION_PROVIDER_SCHEMAS[provider].defaultCapabilities];
}

export function isDestinationSelectableForTenant(input: {
  destination: LoggingDestination;
  tenantId: string;
  logType: string;
  plane: string;
  region?: string | null;
  critical?: boolean;
}): boolean {
  const { destination, tenantId, logType, plane, region, critical } = input;
  const policy = destination.capabilityPolicy;

  if (destination.lifecycleStatus !== 'active') {
    return false;
  }
  if (!['configured', 'healthy'].includes(destination.healthStatus)) {
    return false;
  }
  if (
    policy.allowedTenantIds &&
    policy.allowedTenantIds.length > 0 &&
    !policy.allowedTenantIds.includes(tenantId)
  ) {
    return false;
  }
  if (
    policy.allowedLogTypes &&
    policy.allowedLogTypes.length > 0 &&
    !policy.allowedLogTypes.includes(logType)
  ) {
    return false;
  }
  if (
    policy.allowedPlanes &&
    policy.allowedPlanes.length > 0 &&
    !policy.allowedPlanes.includes(plane)
  ) {
    return false;
  }
  if (region && policy.region && region !== policy.region) {
    return false;
  }
  if (critical && !policy.criticalAllowed) {
    return false;
  }
  return true;
}
