import {
  EXTERNAL_PLUGIN_EXECUTION_NOT_ALLOWED,
  getExternalPluginExecutionState,
  type ControlPluginResourceCleanupView,
  type ControlPluginDynamicWorkerStateView,
  type ControlPluginDynamicWorkerResourcePreparation,
  type ControlPluginDynamicWorkerDesiredStateRequest,
  type ControlPluginDynamicWorkerObservedStateRequest,
  type ControlPluginResourceSelection,
  type DynamicPluginInstallationResult,
  type Env,
} from '@authrim/ar-lib-core';
import {
  ExternalPluginGateUnavailableError,
  readSavedExternalPluginSetting,
  reconcileRunnerExternalGate,
  setRunnerExternalGate,
} from './external-plugin-gate-sync';

function control(env: Env) {
  const binding = env.CONTROL;
  if (
    !binding?.validatePluginDynamicWorkerDesiredState ||
    !binding.syncPluginDynamicWorkerObservedState
  ) {
    throw new Error('dynamic_plugin_control_unavailable');
  }
  return {
    validate: (input: ControlPluginDynamicWorkerDesiredStateRequest) => {
      if (!binding.validatePluginDynamicWorkerDesiredState) {
        throw new Error('dynamic_plugin_control_unavailable');
      }
      return binding.validatePluginDynamicWorkerDesiredState(input);
    },
    prepare: binding.preparePluginDynamicWorkerResources
      ? (input: ControlPluginDynamicWorkerDesiredStateRequest) => {
          if (!binding.preparePluginDynamicWorkerResources) {
            throw new Error('dynamic_plugin_control_unavailable');
          }
          return binding.preparePluginDynamicWorkerResources(input);
        }
      : undefined,
    sync: (input: ControlPluginDynamicWorkerObservedStateRequest) => {
      if (!binding.syncPluginDynamicWorkerObservedState) {
        throw new Error('dynamic_plugin_control_unavailable');
      }
      return binding.syncPluginDynamicWorkerObservedState(input);
    },
  };
}

function runner(env: Env) {
  if (!env.PLUGIN_RUNNER) throw new Error('dynamic_plugin_runner_unavailable');
  return env.PLUGIN_RUNNER;
}

export class DynamicPluginResourcesPendingError extends Error {
  constructor(readonly preparation: ControlPluginDynamicWorkerResourcePreparation) {
    super('dynamic_plugin_resources_not_ready');
    this.name = 'DynamicPluginResourcesPendingError';
  }
}

/** The tenant's `plugin.enabled` does not allow external plugin code, so nothing is switched on. */
export class ExternalPluginExecutionNotAllowedError extends Error {
  constructor() {
    super(EXTERNAL_PLUGIN_EXECUTION_NOT_ALLOWED);
    this.name = 'ExternalPluginExecutionNotAllowedError';
  }
}

export async function getDynamicPluginResourceProvisioning(
  env: Env,
  input: { tenantId: string; pluginId: string }
): Promise<{
  operationId: string;
  state: 'pending' | 'blocked';
  kind: 'provisioning' | 'cleanup';
} | null> {
  const cleanup = await getDynamicPluginResourceCleanup(env, input);
  if (cleanup && cleanup.state !== 'succeeded') {
    return {
      operationId: cleanup.operationId,
      state: cleanup.state === 'blocked' ? 'blocked' : 'pending',
      kind: 'cleanup',
    };
  }
  const preparation = await getDynamicPluginResourcePreparation(env, input);
  if (!preparation || preparation.readiness === 'ready') return null;
  return {
    operationId: preparation.operationId,
    state: preparation.readiness,
    kind: 'provisioning',
  };
}

export async function getDynamicPluginResourcePreparation(
  env: Env,
  input: { tenantId: string; pluginId: string }
): Promise<
  | (ControlPluginDynamicWorkerResourcePreparation & {
      operationId: string;
      readiness: 'pending' | 'blocked' | 'ready';
    })
  | null
> {
  const binding = env.CONTROL;
  if (!binding?.getPluginDynamicWorkerResourcePreparation) return null;
  const preparation = await binding.getPluginDynamicWorkerResourcePreparation({
    ...input,
    enabled: true,
  });
  if (!preparation || preparation.readiness === 'not_required') {
    return null;
  }
  if (
    preparation.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME ||
    preparation.tenantId !== input.tenantId ||
    preparation.pluginId !== input.pluginId ||
    preparation.enabled !== true ||
    !preparation.operationId ||
    !['pending', 'blocked', 'ready'].includes(preparation.readiness)
  ) {
    throw new Error('dynamic_plugin_control_plan_mismatch');
  }
  return preparation as ControlPluginDynamicWorkerResourcePreparation & {
    operationId: string;
    readiness: 'pending' | 'blocked' | 'ready';
  };
}

export async function getDynamicPluginResourcePreparationForDisable(
  env: Env,
  input: { tenantId: string; pluginId: string }
): ReturnType<typeof getDynamicPluginResourcePreparation> {
  try {
    return await getDynamicPluginResourcePreparation(env, input);
  } catch (error) {
    // An inactive or rejected manifest must block activation, but must not make removal impossible.
    if (error instanceof Error && error.message === 'control_plugin_manifest_unavailable') {
      return null;
    }
    throw error;
  }
}

export async function configureDynamicPluginWithControl(
  env: Env,
  input: {
    tenantId: string;
    pluginId: string;
    enabled: boolean;
    resourceSelections?: readonly ControlPluginResourceSelection[];
    activationRequestId?: string;
  }
): Promise<{
  installation: DynamicPluginInstallationResult;
  controlState: ControlPluginDynamicWorkerStateView;
}> {
  // Switching an external plugin on needs the tenant's permission to run external code
  // (`plugin.enabled`); this runs before any resource is provisioned, and the delayed activation
  // of a plugin whose resources were still being prepared passes through here too. Switching off
  // is never refused. The platform and the built-in plugins do not come through here.
  //
  // This is an early refusal on the settings the runtime reads. What stops external code is the
  // tenant gate in ar-plugin-runner: it is opened here from the saved setting (not the KV copy)
  // just before the installation is switched on, and checked again afterwards (see below).
  if (input.enabled) {
    const state = await getExternalPluginExecutionState(env, input.tenantId, { fresh: true });
    if (state === 'unreadable') throw new ExternalPluginGateUnavailableError('settings_unreadable');
    if (state !== 'allowed') throw new ExternalPluginExecutionNotAllowedError();
  }
  const controlBinding = control(env);
  let activationRequestId = input.activationRequestId;
  const controlInput = {
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    enabled: input.enabled,
    ...(input.resourceSelections ? { resourceSelections: input.resourceSelections } : {}),
  };
  const plan = await controlBinding.validate(controlInput);
  if (
    plan.tenantId !== input.tenantId ||
    plan.pluginId !== input.pluginId ||
    plan.enabled !== input.enabled ||
    plan.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME
  ) {
    throw new Error('dynamic_plugin_control_plan_mismatch');
  }
  for (const selection of input.resourceSelections ?? []) {
    const resource = plan.resources.find(
      (candidate) => candidate.logicalResourceId === selection.logicalResourceId
    );
    if (
      !resource ||
      resource.lifecycleMode !== 'existing' ||
      resource.providerResourceId !== selection.providerResourceId ||
      resource.providerName !== selection.providerName
    ) {
      throw new Error('dynamic_plugin_control_plan_mismatch');
    }
  }
  if (input.enabled && plan.resources.length > 0) {
    if (!controlBinding.prepare) throw new Error('dynamic_plugin_control_unavailable');
    const preparation = await controlBinding.prepare(controlInput);
    if (
      preparation.environmentId !== plan.environmentId ||
      preparation.tenantId !== plan.tenantId ||
      preparation.pluginId !== plan.pluginId ||
      preparation.installationId !== plan.installationId ||
      preparation.capabilityManifestDigest !== plan.capabilityManifestDigest ||
      preparation.enabled !== true ||
      JSON.stringify(preparation.resources) !== JSON.stringify(plan.resources) ||
      !preparation.operationId
    ) {
      throw new Error('dynamic_plugin_control_plan_mismatch');
    }
    if (preparation.readiness !== 'ready') {
      throw new DynamicPluginResourcesPendingError(preparation);
    }
    if (activationRequestId && activationRequestId !== preparation.operationId) {
      throw new Error('dynamic_plugin_activation_request_mismatch');
    }
    activationRequestId = preparation.operationId;
    const current = await runner(env).getDynamicPluginInstallationStatus({
      tenantId: input.tenantId,
      pluginId: input.pluginId,
    });
    if (
      current.installationId !== plan.installationId ||
      current.tenantId !== input.tenantId ||
      current.pluginId !== input.pluginId
    ) {
      throw new Error('dynamic_plugin_runner_result_mismatch');
    }
    if (current.state === 'enabled') {
      activationRequestId = undefined;
    } else {
      await stageDynamicPluginActivation(env, {
        tenantId: input.tenantId,
        pluginId: input.pluginId,
        activationRequestId,
      });
    }
  }
  if (input.enabled) {
    if (!(await reconcileRunnerExternalGate(env, input.tenantId, { requireRunner: true }))) {
      throw new ExternalPluginExecutionNotAllowedError();
    }
  }
  // From here the gate is open (for a saved "on") and the installation is being switched on. An
  // exception at any later step (Control sync failing, the runner answering oddly, the setting
  // turned off meanwhile) must not leave an open gate behind a setting that is off.
  try {
    const installation = await runner(env).configureDynamicPluginInstallation({
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      enabled: input.enabled,
      ...(activationRequestId ? { activationRequestId } : {}),
    });
    if (
      installation.installationId !== plan.installationId ||
      installation.tenantId !== input.tenantId ||
      installation.pluginId !== input.pluginId ||
      installation.state !== (input.enabled ? 'enabled' : 'disabled')
    ) {
      throw new Error('dynamic_plugin_runner_result_mismatch');
    }
    const controlState = await controlBinding.sync({
      installationId: installation.installationId,
      tenantId: installation.tenantId,
      pluginId: installation.pluginId,
      state: installation.state,
      configVersion: installation.configVersion,
      pinnedVersionDigest: installation.pinnedVersionDigest,
      resourceSelections: input.resourceSelections ?? [],
    });
    if (
      controlState.installationId !== installation.installationId ||
      controlState.tenantId !== installation.tenantId ||
      controlState.pluginId !== installation.pluginId ||
      controlState.state !== installation.state ||
      controlState.configVersion !== installation.configVersion ||
      controlState.pinnedVersionDigest !== installation.pinnedVersionDigest
    ) {
      throw new Error('dynamic_plugin_control_state_mismatch');
    }
    if (input.enabled) await confirmGateAfterEnable(env, input);
    return { installation, controlState };
  } catch (error) {
    if (input.enabled) await settleFailedEnable(env, input);
    throw error;
  }
}

/**
 * An enable failed after the gate was opened. If the saved setting no longer says on (or cannot
 * be read), close the gate and switch the installation back off, so a turn-off that finished
 * meanwhile is not undone by this enable. If it still says on, the gate is rightly open for the
 * tenant's other external plugins and is left alone. The original error is what the caller gets.
 */
async function settleFailedEnable(
  env: Env,
  input: { tenantId: string; pluginId: string }
): Promise<void> {
  let saved = false;
  try {
    saved = await readSavedExternalPluginSetting(env, input.tenantId);
  } catch {
    saved = false;
  }
  if (saved) return;
  try {
    await setRunnerExternalGate(env, input.tenantId, false, { requireRunner: true });
  } catch {
    // Nothing more can be done here; the caller still reports the original failure.
  }
  try {
    await configureDynamicPluginWithControl(env, {
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      enabled: false,
    });
  } catch {
    // The gate is closed; the installation is switched off by the turn-off that won the race.
  }
}

/**
 * The setting may have been turned off while this enable was under way (the turn-off closes the
 * gate and switches the installations off, but this enable can still switch one on after that).
 * Look at the saved setting once more now that the installation is on: if it is off, refuse (the
 * failure path then closes the gate and switches the installation back off).
 */
async function confirmGateAfterEnable(
  env: Env,
  input: { tenantId: string; pluginId: string }
): Promise<void> {
  if (await readSavedExternalPluginSetting(env, input.tenantId)) return;
  // The caller's catch closes the gate and switches the installation back off.
  throw new ExternalPluginExecutionNotAllowedError();
}

export async function stageDynamicPluginActivation(
  env: Env,
  input: { tenantId: string; pluginId: string; activationRequestId: string }
): Promise<void> {
  const result = await runner(env).stageDynamicPluginActivation(input);
  if (
    result.tenantId !== input.tenantId ||
    result.pluginId !== input.pluginId ||
    result.activationRequestId !== input.activationRequestId ||
    result.state !== 'pending'
  ) {
    throw new Error('dynamic_plugin_activation_stage_mismatch');
  }
}

export async function requestDynamicPluginResourceCleanup(
  env: Env,
  input: {
    tenantId: string;
    pluginId: string;
    reason: 'uninstall' | 'canceled_pre_activation';
    sourceOperationId?: string;
    requestedById: string;
    idempotencyKey: string;
  }
): Promise<ControlPluginResourceCleanupView | null> {
  const binding = env.CONTROL;
  if (!binding?.requestPluginResourceCleanup) {
    throw new Error('dynamic_plugin_control_unavailable');
  }
  const result = await binding.requestPluginResourceCleanup(input);
  if (
    result &&
    (result.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME ||
      result.tenantId !== input.tenantId ||
      result.pluginId !== input.pluginId ||
      result.reason !== input.reason)
  ) {
    throw new Error('dynamic_plugin_control_state_mismatch');
  }
  return result;
}

export async function getDynamicPluginResourceCleanup(
  env: Env,
  input: { tenantId: string; pluginId: string }
): Promise<ControlPluginResourceCleanupView | null> {
  const binding = env.CONTROL;
  if (!binding?.getPluginResourceCleanup) return null;
  const result = await binding.getPluginResourceCleanup(input);
  if (
    result &&
    (result.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME ||
      result.tenantId !== input.tenantId ||
      result.pluginId !== input.pluginId)
  ) {
    throw new Error('dynamic_plugin_control_state_mismatch');
  }
  return result;
}
