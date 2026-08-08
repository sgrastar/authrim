import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Fetcher } from '@cloudflare/workers-types';
import { RuntimeSmokeEntrypoint as BaseRuntimeSmokeEntrypoint } from '@authrim/ar-lib-core';
import { PluginRunnerScheduler } from './scheduler';
import { DynamicWorkerSyncHookBackend } from './sync-hooks';
import { SyncHookBackendRouter } from './sync-hook-backend-router';
import { SyncHookService } from './sync-hook-service';
import { PluginOutboundGateway } from './outbound-gateway';
import { D1PluginConfigStore } from './config-store';
import { pluginEncryptionKeyringFromEnv } from './encryption-keyring';
import { D1PluginConfigReencryptor } from './config-reencryption';
import { isPluginAccountMetadataRequest, PluginAccountMetadataService } from './account-metadata';
import {
  ImmediateNotificationDeliveryService,
  type ImmediateNotificationDeliveryInput,
} from './notification-delivery-service';
import { D1NotificationInstallationStore } from './notification-installations';
import { D1NotificationProviderOrderStore } from './notification-provider-order';
import type { PluginRunnerEnv, PluginRunnerRpcProps } from './types';
import { createBuiltinHumanVerificationRegistry } from './builtin-human-verification';
import { D1HumanVerificationInstallationStore } from './human-verification-installations';
import { D1AccountEventInstallationResolver } from './account-event-installations';
import { R2PluginWorkerCodeResolver } from './dynamic-worker-code';
import { D1PluginInstallationResolver } from './installations';
import type { PluginEgressContext } from './types';
import { D1DynamicPluginInstallationStore } from './dynamic-worker-installations';
import { resolvePluginHostInterfaceEnv } from './host-interfaces';
import type { PluginHostInterfaceEnvFactory } from './dynamic-worker-backend';
import type { PluginHostInterfaceBindingContract } from '@authrim/ar-lib-core/services/plugin-host-interface-contract';
import {
  PluginD1ResourceAccess,
  PluginKvResourceAccess,
  PluginR2ResourceAccess,
  PluginResourceControlService,
  type PluginResourceBindingDescriptor,
  type PluginResourceBindingProps,
} from './resource-bindings';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_NAME = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const EXPOSED_ERROR = /^plugin_(?:sync|config|notification|dynamic)_[a-z0-9_]+$/u;

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_sync_input_invalid');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('plugin_sync_input_invalid');
  }
  return record;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error('plugin_sync_input_invalid');
  }
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_NAME.test(value)) {
    throw new Error('plugin_sync_input_invalid');
  }
  return value;
}

function remoteIp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 45 ||
    !/^[0-9A-Fa-f:.]+$/u.test(value)
  ) {
    throw new Error('plugin_sync_input_invalid');
  }
  const ipv4 = value.split('.');
  if (ipv4.length === 4) {
    if (
      ipv4.some(
        (part) =>
          !/^(?:0|[1-9][0-9]{0,2})$/u.test(part) ||
          !Number.isSafeInteger(Number(part)) ||
          Number(part) > 255
      )
    ) {
      throw new Error('plugin_sync_input_invalid');
    }
    return value;
  }
  if (!value.includes(':')) throw new Error('plugin_sync_input_invalid');
  try {
    new URL(`http://[${value}]/`);
  } catch {
    throw new Error('plugin_sync_input_invalid');
  }
  return value;
}

function humanVerificationInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_sync_input_invalid');
  }
  const raw = input as Record<string, unknown>;
  const keys = ['tenantId', 'pluginInstallationId', 'requestId', 'action', 'responseToken'];
  if (raw.remoteIp !== undefined) keys.push('remoteIp');
  const value = exactRecord(raw, keys);
  if (
    !['login', 'signup', 'reauth'].includes(String(value.action)) ||
    typeof value.responseToken !== 'string' ||
    value.responseToken.length < 1 ||
    value.responseToken.length > 4_096
  ) {
    throw new Error('plugin_sync_input_invalid');
  }
  return {
    tenantId: id(value.tenantId),
    pluginInstallationId: id(value.pluginInstallationId),
    requestId: id(value.requestId),
    action: value.action as 'login' | 'signup' | 'reauth',
    responseToken: value.responseToken,
    ...(value.remoteIp === undefined ? {} : { remoteIp: remoteIp(value.remoteIp) }),
  };
}

function policyAttributes(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_sync_input_invalid');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new Error('plugin_sync_input_invalid');
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of entries) {
    if (
      !SAFE_NAME.test(key) ||
      !(
        typeof entry === 'boolean' ||
        (typeof entry === 'number' && Number.isFinite(entry)) ||
        (typeof entry === 'string' && entry.length <= 256)
      )
    ) {
      throw new Error('plugin_sync_input_invalid');
    }
    result[key] = entry;
  }
  return result;
}

function policyDecisionInput(input: unknown) {
  const value = exactRecord(input, [
    'tenantId',
    'pluginInstallationId',
    'requestId',
    'subjectId',
    'action',
    'resourceType',
    'resourceId',
    'attributes',
  ]);
  return {
    tenantId: id(value.tenantId),
    pluginInstallationId: id(value.pluginInstallationId),
    requestId: id(value.requestId),
    subjectId: id(value.subjectId),
    action: name(value.action),
    resourceType: name(value.resourceType),
    resourceId: id(value.resourceId),
    attributes: policyAttributes(value.attributes),
  };
}

function flowHookInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_sync_input_invalid');
  }
  const raw = input as Record<string, unknown>;
  const keys = [
    'tenantId',
    'pluginInstallationId',
    'requestId',
    'flowId',
    'hookName',
    'stateVersion',
  ];
  if (raw.accountId !== undefined) keys.push('accountId');
  const value = exactRecord(raw, keys);
  if (!Number.isSafeInteger(value.stateVersion) || (value.stateVersion as number) < 1) {
    throw new Error('plugin_sync_input_invalid');
  }
  return {
    tenantId: id(value.tenantId),
    pluginInstallationId: id(value.pluginInstallationId),
    requestId: id(value.requestId),
    flowId: id(value.flowId),
    hookName: name(value.hookName),
    ...(value.accountId === undefined ? {} : { accountId: id(value.accountId) }),
    stateVersion: value.stateVersion as number,
  };
}

function notificationDeliveryInput(input: unknown): ImmediateNotificationDeliveryInput {
  const value = exactRecord(input, [
    'tenantId',
    'intentId',
    'outboxId',
    'pluginInstallationId',
    'bindingRef',
  ]);
  if (
    typeof value.bindingRef !== 'string' ||
    !/^[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]{1,120}$/u.test(value.bindingRef)
  ) {
    throw new Error('plugin_notification_input_invalid');
  }
  return {
    tenantId: id(value.tenantId),
    intentId: id(value.intentId),
    outboxId: id(value.outboxId),
    pluginInstallationId: id(value.pluginInstallationId),
    bindingRef: value.bindingRef,
  };
}

function notificationProviderOrderQuery(input: unknown) {
  const value = exactRecord(input, ['tenantId', 'channel']);
  if (!['email', 'sms', 'push'].includes(String(value.channel))) {
    throw new Error('plugin_notification_provider_order_input_invalid');
  }
  return {
    tenantId: id(value.tenantId),
    channel: value.channel as 'email' | 'sms' | 'push',
  };
}

function accountEventInstallationsInput(input: unknown) {
  const value = exactRecord(input, ['tenantId', 'eventType']);
  if (value.eventType !== 'account.created') {
    throw new Error('plugin_sync_account_event_input_invalid');
  }
  return {
    tenantId: id(value.tenantId),
    eventType: value.eventType,
  } as const;
}

function dynamicCredentialsInput(input: unknown) {
  const value = exactRecord(input, [
    'operationId',
    'tenantId',
    'pluginId',
    'expectedConfigVersion',
    'credentials',
  ]);
  if (
    !Number.isSafeInteger(value.expectedConfigVersion) ||
    (value.expectedConfigVersion as number) < 1 ||
    !value.credentials ||
    typeof value.credentials !== 'object' ||
    Array.isArray(value.credentials)
  ) {
    throw new Error('plugin_dynamic_credentials_input_invalid');
  }
  return {
    operationId: id(value.operationId),
    tenantId: id(value.tenantId),
    pluginId: id(value.pluginId),
    expectedConfigVersion: value.expectedConfigVersion as number,
    credentials: value.credentials as Record<string, unknown>,
  };
}

function authorized(
  env: PluginRunnerEnv,
  props: PluginRunnerRpcProps,
  callers: readonly PluginRunnerRpcProps['caller'][]
): void {
  if (
    !props ||
    !callers.includes(props.caller) ||
    props.audience !== 'authrim-plugin-runner-v1' ||
    !SAFE_ID.test(props.environmentId) ||
    env.AUTHRIM_ENVIRONMENT_NAME !== props.environmentId
  ) {
    throw new Error('plugin_sync_caller_unauthorized');
  }
}

async function rpcResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && EXPOSED_ERROR.test(error.message)) {
      throw new Error(error.message);
    }
    throw new Error('plugin_sync_internal_error');
  }
}

function syncHookService(
  env: PluginRunnerEnv,
  outbound: (context: PluginEgressContext) => Fetcher,
  hostInterfaces: PluginHostInterfaceEnvFactory
): SyncHookService {
  const installations = new D1PluginInstallationResolver(env.PLUGIN_RUNNER_DB);
  return new SyncHookService(
    env.PLUGIN_RUNNER_DB,
    new SyncHookBackendRouter(
      new DynamicWorkerSyncHookBackend(
        env.PLUGIN_LOADER,
        installations,
        new R2PluginWorkerCodeResolver(env.PLUGIN_BUNDLES),
        outbound,
        hostInterfaces
      ),
      createBuiltinHumanVerificationRegistry(env)
    )
  );
}

async function handleDynamicOutbound(
  env: PluginRunnerEnv,
  context: PluginEgressContext,
  request: Request
): Promise<Response> {
  if (isPluginAccountMetadataRequest(request)) {
    return new PluginAccountMetadataService(
      env,
      env.PLUGIN_MUTATION_HMAC_KEY,
      () => Math.floor(Date.now() / 1000),
      context
    )
      .handle(request)
      .catch((error: unknown) => {
        const code = error instanceof Error ? error.message : '';
        const status =
          code === 'plugin_data_method_denied'
            ? 405
            : code === 'plugin_data_input_invalid'
              ? 400
              : code === 'plugin_data_scope_denied'
                ? 403
                : code === 'plugin_data_account_unavailable'
                  ? 404
                  : code === 'plugin_data_version_conflict' ||
                      code === 'plugin_data_idempotency_conflict'
                    ? 409
                    : 503;
        return new Response(null, {
          status,
          headers: {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(status === 405 ? { Allow: 'PUT' } : {}),
          },
        });
      });
  }
  return new PluginOutboundGateway(env, fetch, () => Math.floor(Date.now() / 1000), context)
    .fetch(request)
    .catch((error: unknown) => {
      const code = error instanceof Error ? error.message : '';
      const status =
        code === 'plugin_egress_rate_limited'
          ? 429
          : code === 'plugin_egress_request_too_large'
            ? 413
            : code === 'plugin_egress_host_denied' ||
                code === 'plugin_egress_wildcard_requires_controlled_proxy' ||
                code === 'plugin_egress_method_denied'
              ? 403
              : 502;
      return new Response(null, {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
}

export class PluginDynamicOutbound extends WorkerEntrypoint<PluginRunnerEnv, PluginEgressContext> {
  fetch(request: Request): Promise<Response> {
    return handleDynamicOutbound(this.env, this.ctx.props, request);
  }
}

export class PluginAccountMetadataAccess extends WorkerEntrypoint<
  PluginRunnerEnv,
  PluginEgressContext
> {
  async write(input: unknown) {
    try {
      return await new PluginAccountMetadataService(this.env).write(this.ctx.props, input);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(?:plugin_data_(?:input_invalid|scope_denied|account_unavailable|version_conflict|idempotency_conflict|idempotency_key_unavailable))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('plugin_host_interface_unavailable');
    }
  }
}

export class RuntimeSmokeEntrypoint extends BaseRuntimeSmokeEntrypoint {
  smokePluginResourceBindings(input: unknown) {
    return new PluginResourceControlService(
      this.env as PluginRunnerEnv,
      this.ctx.props
    ).reflectAndSmoke(input);
  }
}

export default class PluginRunnerWorker extends WorkerEntrypoint<
  PluginRunnerEnv,
  PluginRunnerRpcProps
> {
  private dynamicOutbound(context: PluginEgressContext): Fetcher {
    const loopback = this.ctx as typeof this.ctx & {
      exports: {
        PluginDynamicOutbound(options: { props: PluginEgressContext }): Fetcher;
      };
    };
    return loopback.exports.PluginDynamicOutbound({ props: context });
  }

  private dynamicHostInterfaces(
    context: PluginEgressContext,
    bindings: readonly PluginHostInterfaceBindingContract[],
    resources: readonly PluginResourceBindingDescriptor[],
    pluginId: string
  ): Record<string, unknown> {
    const loopback = this.ctx as typeof this.ctx & {
      exports: {
        PluginAccountMetadataAccess(options: { props: PluginEgressContext }): unknown;
        PluginD1ResourceAccess(options: { props: PluginResourceBindingProps }): unknown;
        PluginKvResourceAccess(options: { props: PluginResourceBindingProps }): unknown;
        PluginR2ResourceAccess(options: { props: PluginResourceBindingProps }): unknown;
      };
    };
    const resolved = resolvePluginHostInterfaceEnv(bindings, {
      'authrim.account_metadata.v1': () =>
        loopback.exports.PluginAccountMetadataAccess({ props: context }),
    });
    for (const resource of resources) {
      if (Object.prototype.hasOwnProperty.call(resolved, resource.binding)) {
        throw new Error('plugin_host_interface_binding_conflict');
      }
      const props: PluginResourceBindingProps = {
        tenantId: context.tenantId,
        pluginId,
        installationId: context.pluginInstallationId,
        ...resource,
      };
      resolved[resource.binding] =
        resource.kind === 'd1'
          ? loopback.exports.PluginD1ResourceAccess({ props })
          : resource.kind === 'kv_namespace'
            ? loopback.exports.PluginKvResourceAccess({ props })
            : loopback.exports.PluginR2ResourceAccess({ props });
    }
    return resolved;
  }

  fetch(_request: Request): Response {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  scheduled(): Promise<void> {
    return new PluginRunnerScheduler(
      this.env,
      () => Math.floor(Date.now() / 1000),
      (context) => this.dynamicOutbound(context),
      (context, bindings, resources, pluginId) =>
        this.dynamicHostInterfaces(context, bindings, resources, pluginId)
    ).run();
  }

  runHumanVerification(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-auth', 'ar-bridge', 'ar-management', 'ar-saml']);
      return syncHookService(
        this.env,
        (context) => this.dynamicOutbound(context),
        (context, bindings, resources, pluginId) =>
          this.dynamicHostInterfaces(context, bindings, resources, pluginId)
      ).runHumanVerification(humanVerificationInput(input));
    });
  }

  runPolicyDecision(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-policy']);
      return syncHookService(
        this.env,
        (context) => this.dynamicOutbound(context),
        (context, bindings, resources, pluginId) =>
          this.dynamicHostInterfaces(context, bindings, resources, pluginId)
      ).runPolicyDecision(policyDecisionInput(input));
    });
  }

  runFlowHook(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-auth', 'ar-management']);
      return syncHookService(
        this.env,
        (context) => this.dynamicOutbound(context),
        (context, bindings, resources, pluginId) =>
          this.dynamicHostInterfaces(context, bindings, resources, pluginId)
      ).runFlowHook(flowHookInput(input));
    });
  }

  deliverNotification(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-auth', 'ar-management']);
      return new ImmediateNotificationDeliveryService(
        this.env,
        () => Math.floor(Date.now() / 1000),
        (context) => this.dynamicOutbound(context),
        (context, bindings, resources, pluginId) =>
          this.dynamicHostInterfaces(context, bindings, resources, pluginId)
      )
        .deliver(notificationDeliveryInput(input))
        .catch(() => 'pending' as const);
    });
  }

  replacePluginCredentials(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1PluginConfigStore(
        this.env.PLUGIN_RUNNER_DB,
        pluginEncryptionKeyringFromEnv(this.env),
        this.env.PLUGIN_MUTATION_HMAC_KEY
      ).replaceCredentials(input);
    });
  }

  configureNotificationInstallation(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1NotificationInstallationStore(this.env.PLUGIN_RUNNER_DB).configure(input);
    });
  }

  configureHumanVerificationInstallation(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1HumanVerificationInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        pluginEncryptionKeyringFromEnv(this.env),
        this.env.PLUGIN_MUTATION_HMAC_KEY
      ).configure(input);
    });
  }

  configureDynamicPluginInstallation(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      ).configure(input);
    });
  }

  stageDynamicPluginActivation(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      ).stageActivation(input);
    });
  }

  rolloutDynamicPluginInstallation(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      ).rollout(input);
    });
  }

  rolloutDynamicPluginBatch(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      ).rolloutBatch(input);
    });
  }

  listApprovedDynamicPlugins() {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      ).listApproved();
    });
  }

  getDynamicPluginInstallationStatus(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      ).status(input);
    });
  }

  replaceDynamicPluginCredentials(input: unknown) {
    return rpcResult(async () => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      const value = dynamicCredentialsInput(input);
      const installations = new D1DynamicPluginInstallationStore(
        this.env.PLUGIN_RUNNER_DB,
        this.env.AUTHRIM_ENVIRONMENT_NAME
      );
      let status = await installations.status({
        tenantId: value.tenantId,
        pluginId: value.pluginId,
      });
      if (status.state === 'absent') {
        await installations.configure({
          tenantId: value.tenantId,
          pluginId: value.pluginId,
          enabled: false,
        });
        status = await installations.status({
          tenantId: value.tenantId,
          pluginId: value.pluginId,
        });
      }
      if (status.configVersion !== value.expectedConfigVersion) {
        throw new Error('plugin_dynamic_credentials_version_conflict');
      }
      const mapped = await installations.credentialInputs({
        tenantId: value.tenantId,
        pluginId: value.pluginId,
        credentials: value.credentials,
      });
      return new D1PluginConfigStore(
        this.env.PLUGIN_RUNNER_DB,
        pluginEncryptionKeyringFromEnv(this.env),
        this.env.PLUGIN_MUTATION_HMAC_KEY
      ).replaceCredentials({
        operationId: value.operationId,
        tenantId: value.tenantId,
        installationId: status.installationId,
        expectedConfigVersion: value.expectedConfigVersion,
        credentials: mapped.values,
      });
    });
  }

  replaceNotificationProviderOrder(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1NotificationProviderOrderStore(this.env.PLUGIN_RUNNER_DB).replace(input);
    });
  }

  resolveNotificationProviderOrder(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-auth', 'ar-management']);
      return new D1NotificationProviderOrderStore(this.env.PLUGIN_RUNNER_DB).resolve(
        notificationProviderOrderQuery(input)
      );
    });
  }

  resolveAccountEventInstallations(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      return new D1AccountEventInstallationResolver(this.env.PLUGIN_RUNNER_DB).resolve(
        accountEventInstallationsInput(input)
      );
    });
  }

  startPluginCredentialRotation(input: unknown) {
    return rpcResult(() => {
      authorized(this.env, this.ctx.props, ['ar-management']);
      const value = exactRecord(input, ['operationId']);
      return new D1PluginConfigReencryptor(
        this.env.PLUGIN_RUNNER_DB,
        pluginEncryptionKeyringFromEnv(this.env)
      ).start(id(value.operationId));
    });
  }
}

export { PluginD1ResourceAccess, PluginKvResourceAccess, PluginR2ResourceAccess };
