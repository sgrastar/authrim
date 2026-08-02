import type {
  D1Database,
  KVNamespace,
  R2Bucket,
  WorkerLoader,
  WorkerVersionMetadata,
} from '@cloudflare/workers-types';
import type { EmailServiceBinding, NotificationDeliveryPayload } from '@authrim/ar-lib-core';

export interface PluginRunnerEnv {
  PLUGIN_RUNNER_DB: D1Database;
  TENANT_RUNTIME_REGISTRY: KVNamespace;
  PLUGIN_LOADER?: WorkerLoader;
  PLUGIN_BUNDLES?: R2Bucket;
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: string;
  PLUGIN_ENCRYPTION_KEY: string;
  PLUGIN_MUTATION_HMAC_KEY: string;
  NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: string;
  NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B?: string;
  EMAIL?: EmailServiceBinding;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  PLUGIN_ENCRYPTION_ACTIVE_KEY_ID?: string;
  PLUGIN_ENCRYPTION_KEY_PREVIOUS?: string;
  PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID?: string;
  AUTHRIM_ENVIRONMENT_NAME: string;
  AUTHRIM_WORKER_SCRIPT_NAME: string;
  CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS: string;
  CONTROL_SMOKE_VERSION: WorkerVersionMetadata;
  AUTHRIM_PLUGIN_EGRESS_CONTEXT?: PluginEgressContext;
  [binding: string]: unknown;
}

export interface PluginEgressContext {
  contractVersion: 1;
  tenantId: string;
  pluginInstallationId: string;
  capability: string;
  requestId: string;
  executionScope?: PluginExecutionScope;
}

export interface PluginExecutionScope {
  bindingRef: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users';
  residencyPartition: string;
  accountId?: string;
}

export type PluginShardExecutionScope = Omit<PluginExecutionScope, 'accountId'>;

export interface WritePluginAccountMetadataInput {
  operationId: string;
  accountId: string;
  metadataKey: string;
  value: unknown;
  expectedVersion: number | null;
}

export interface WritePluginAccountMetadataResult {
  operationId: string;
  accountId: string;
  metadataKey: string;
  version: number;
}

export interface PluginRunnerRpcProps {
  caller: 'ar-auth' | 'ar-bridge' | 'ar-management' | 'ar-policy' | 'ar-saml';
  environmentId: string;
  audience: 'authrim-plugin-runner-v1';
}

export interface PluginAccountHookReferencePayload {
  tenantId: string;
  accountId: string;
  eventType: string;
  eventVersion: number;
}

export interface PluginNotificationHookReferencePayload {
  tenantId: string;
  intentId: string;
  eventType: 'notification.delivery.requested';
  eventVersion: 1;
}

export type PluginHookReferencePayload =
  | PluginAccountHookReferencePayload
  | PluginNotificationHookReferencePayload;

export interface PluginHookInvocation {
  pluginInstallationId: string;
  tenantId: string;
  capability: string;
  eventType: string;
  eventVersion: number;
  idempotencyKey: string;
  payload: PluginHookReferencePayload;
}

export interface PluginNotificationExecutionPayload {
  tenantId: string;
  intentId: string;
  eventType: 'notification.delivery.requested';
  eventVersion: 1;
  notificationKind: string;
  expiresAt: number;
  delivery: NotificationDeliveryPayload;
}

export interface PluginHookExecutionInvocation extends Omit<PluginHookInvocation, 'payload'> {
  payload: PluginAccountHookReferencePayload | PluginNotificationExecutionPayload;
}

export interface PluginHookBackend {
  invoke(input: PluginHookInvocation): Promise<void>;
}

export interface PluginExecutionBackend {
  invoke(input: PluginHookExecutionInvocation): Promise<void>;
}
