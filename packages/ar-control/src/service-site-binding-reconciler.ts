import {
  CloudflareControlApiError,
  activeWorkerDeployment,
  buildPreservingWorkerSettingsPatch,
  buildRemovingWorkerBindingSettingsPatch,
  ensureWorkerBindingsPatched,
  verifyWorkerSettingsBindingsRemoved,
  verifyWorkerSettingsPreserved,
  verifyWorkerSettingsRestoreIntent,
  type CloudflareWorkerBinding,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerScript,
  type CloudflareWorkerSettings,
} from '@authrim/ar-lib-core/control-plane';
import type { ServiceSiteBindingRow } from './service-site-binding';
import {
  D1ServiceSiteBindingRepository,
  serviceSiteTarget,
  type ServiceSiteBindingTarget,
  type ServiceSiteDeploymentLease,
} from './service-site-binding-repository';

interface ServiceSiteWorkersApi {
  getWorkerSettings(scriptName: string): Promise<CloudflareWorkerSettings>;
  patchWorkerSettings(
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings>;
  listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]>;
  listWorkerScripts(): Promise<CloudflareWorkerScript[]>;
}

export interface ServiceSiteBindingReconcilerResult {
  attempted: number;
  succeeded: number;
  deferred: number;
  blocked: number;
}

type Outcome = 'succeeded' | 'deferred' | 'blocked';

const RETRY_SECONDS = 15;
/** Transient failures stop retrying after a day; an operator re-requests the change. */
const RETRY_BUDGET_SECONDS = 24 * 60 * 60;
const PATCH_PROPAGATION_GRACE_SECONDS = 60;
const SAFE_BINDING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** The router variable that renames its service site binding (see ar-router). */
const ROUTER_BINDING_NAME_VARIABLE = 'SERVICE_SITE_BINDING';
const DEFAULT_BINDING_NAME = 'SERVICE_SITE';

function classifyError(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof CloudflareControlApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: 'control_workers_capability_rejected', permanent: true };
    }
    if (error.status === 404) {
      return { code: 'control_worker_active_deployment_missing', permanent: false };
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { code: 'control_worker_settings_request_rejected', permanent: true };
    }
    return { code: 'control_worker_settings_request_failed', permanent: false };
  }
  const code = error instanceof Error ? error.message : '';
  if (
    code.startsWith('service_site_') &&
    code !== 'service_site_fence_lost' &&
    code !== 'service_site_binding_propagating'
  ) {
    return { code, permanent: true };
  }
  if (
    code.startsWith('worker_settings_binding_') ||
    code.startsWith('worker_settings_payload_too_large') ||
    code === 'control_worker_active_deployment_ambiguous' ||
    code === 'control_worker_concurrent_deployment_detected' ||
    code === 'control_worker_restore_settings_missing' ||
    code === 'control_worker_restore_settings_invalid'
  ) {
    return { code, permanent: true };
  }
  return { code: code || 'service_site_reconciliation_failed', permanent: false };
}

/** The router's service site binding name: its SERVICE_SITE_BINDING variable, else the default. */
function resolveBindingName(settings: CloudflareWorkerSettings): string {
  const variable = (settings.bindings ?? []).find(
    (binding) => binding.name === ROUTER_BINDING_NAME_VARIABLE
  );
  if (!variable) return DEFAULT_BINDING_NAME;
  const text = variable.type === 'plain_text' ? variable.text : undefined;
  const name = typeof text === 'string' ? text.trim() : '';
  if (!name) return DEFAULT_BINDING_NAME;
  if (!SAFE_BINDING_NAME.test(name)) throw new Error('service_site_binding_name_invalid');
  return name;
}

function parseBinding(serialized: string | null): CloudflareWorkerBinding | null {
  if (!serialized) return null;
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('service_site_previous_binding_invalid');
  }
  return value as CloudflareWorkerBinding;
}

function parseRestoreSettings(serialized: string | null): CloudflareWorkerSettings {
  if (!serialized) throw new Error('control_worker_restore_settings_missing');
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_worker_restore_settings_invalid');
  }
  return value as CloudflareWorkerSettings;
}

function bindingByName(
  settings: CloudflareWorkerSettings,
  name: string
): CloudflareWorkerBinding | undefined {
  return (settings.bindings ?? []).find((binding) => binding.name === name);
}

/**
 * Applies the requested service site attachment to the router Worker's settings. The router's
 * other bindings and settings are carried over unchanged; the change is verified against the
 * provider's reflected settings, re-checked after a stabilisation interval, and rolled back when
 * the reflected settings do not match. There is no request-level smoke check: the router exposes
 * no runtime smoke entrypoint, so verification rests on the reflected settings and deployments.
 */
export class ServiceSiteBindingReconciler {
  constructor(
    private readonly repository: D1ServiceSiteBindingRepository,
    private readonly api: ServiceSiteWorkersApi,
    private readonly now: () => number,
    private readonly providerMutationEnabled = true
  ) {}

  async reconcile(limit = 5): Promise<ServiceSiteBindingReconcilerResult> {
    const result: ServiceSiteBindingReconcilerResult = {
      attempted: 0,
      succeeded: 0,
      deferred: 0,
      blocked: 0,
    };
    if (!this.providerMutationEnabled) return result;
    const rows = await this.repository.listDue(limit, this.now());
    for (const row of rows) {
      result.attempted += 1;
      result[await this.reconcileRow(row)] += 1;
    }
    return result;
  }

  private async reconcileRow(row: ServiceSiteBindingRow): Promise<Outcome> {
    const target = serviceSiteTarget(row);
    const now = this.now();
    let lease: ServiceSiteDeploymentLease | null = null;
    try {
      if (
        !(await this.repository.isRouterActive(row.environment_id, row.router_worker_script_name))
      ) {
        throw new Error('service_site_router_not_in_inventory');
      }
      await this.repository.markOperationRunning(row, now);
      const router = row.router_worker_script_name;
      const deployments = await this.api.listWorkerDeployments(router);
      const active = activeWorkerDeployment(deployments);
      lease = await this.repository.acquireDeploymentLease(
        row,
        row.expected_source_version_id ?? active.versionId,
        now
      );
      if (!lease) {
        await this.repository.recordTransientError(
          target,
          'control_worker_deployment_lease_busy',
          now + RETRY_SECONDS,
          now
        );
        return 'deferred';
      }
      // Re-read after the lease is held so the decision uses the state nobody else can change.
      const currentDeployments = await this.api.listWorkerDeployments(router);
      const currentActive = activeWorkerDeployment(currentDeployments);
      let outcome: Outcome;
      if (row.state === 'settings_patched') {
        outcome = await this.stabilize(row, lease);
      } else if (row.state === 'rollback_required') {
        outcome = await this.rollback(row, lease, currentActive);
      } else {
        outcome = await this.apply(row, lease, currentDeployments, currentActive);
      }
      if (outcome === 'blocked' || outcome === 'succeeded') {
        // markSucceeded already dropped the lease; a blocked change must not keep the router locked.
        await this.repository.releaseDeploymentLease(lease);
      }
      return outcome;
    } catch (error) {
      const failure = classifyError(error);
      const budgetExpired = now - Number(row.created_at) > RETRY_BUDGET_SECONDS;
      if (failure.permanent || budgetExpired) {
        await this.repository.markBlocked(
          target,
          failure.permanent ? failure.code : 'service_site_retry_budget_exhausted',
          now
        );
        if (lease) await this.repository.releaseDeploymentLease(lease);
        return 'blocked';
      }
      await this.repository.recordTransientError(target, failure.code, now + RETRY_SECONDS, now);
      return 'deferred';
    }
  }

  private async apply(
    row: ServiceSiteBindingRow,
    lease: ServiceSiteDeploymentLease,
    deployments: CloudflareWorkerDeployment[],
    active: ReturnType<typeof activeWorkerDeployment>
  ): Promise<Outcome> {
    const router = row.router_worker_script_name;
    const target = serviceSiteTarget(row);
    const settings = await this.api.getWorkerSettings(router);
    let bindingName = row.binding_name;
    if (!lease.mutationStarted) {
      // First pass: decide the binding name and remember what it points at today. Later passes
      // (after an interrupted PATCH) keep the plan, because the settings may already be changed.
      bindingName = resolveBindingName(settings);
      const existing = bindingByName(settings, bindingName);
      if (existing && existing.type !== 'service') {
        throw new Error('service_site_binding_name_conflict');
      }
      await this.repository.recordBindingPlan(
        row,
        bindingName,
        existing ? JSON.stringify(existing) : null,
        this.now()
      );
      row = { ...row, binding_name: bindingName };
    }
    return row.desired_state === 'attached'
      ? this.attach(row, target, lease, deployments, active, bindingName)
      : this.detach(row, target, lease, deployments, active, settings, bindingName);
  }

  private async attach(
    row: ServiceSiteBindingRow,
    target: ServiceSiteBindingTarget,
    lease: ServiceSiteDeploymentLease,
    deployments: CloudflareWorkerDeployment[],
    active: ReturnType<typeof activeWorkerDeployment>,
    bindingName: string
  ): Promise<Outcome> {
    const workerName = row.desired_worker_name;
    if (!workerName) throw new Error('service_site_desired_worker_missing');
    if (!lease.mutationStarted) {
      const scripts = await this.api.listWorkerScripts();
      if (!scripts.some((script) => script.id === workerName)) {
        throw new Error('service_site_worker_not_found');
      }
    }
    const patched = await ensureWorkerBindingsPatched({
      target,
      lease,
      desiredBindings: [{ name: bindingName, type: 'service', service: workerName }],
      deploymentsBefore: deployments,
      activeBefore: active,
      api: this.api,
      state: this.repository,
      now: this.now,
      retrySeconds: RETRY_SECONDS,
    });
    if (patched.state === 'blocked') return 'blocked';
    if (patched.state === 'rollback_required') {
      // The rollback pass takes the lease again, so do not hold it across the retry.
      await this.repository.releaseDeploymentLease(lease);
    }
    return 'deferred';
  }

  private async detach(
    row: ServiceSiteBindingRow,
    target: ServiceSiteBindingTarget,
    lease: ServiceSiteDeploymentLease,
    deployments: CloudflareWorkerDeployment[],
    active: ReturnType<typeof activeWorkerDeployment>,
    settings: CloudflareWorkerSettings,
    bindingName: string
  ): Promise<Outcome> {
    const router = row.router_worker_script_name;
    const present = bindingByName(settings, bindingName) !== undefined;
    const now = this.now();
    if (!lease.mutationStarted) {
      if (!present) {
        // Nothing to remove: the router already has no such binding.
        await this.repository.markSucceeded(row, lease, now);
        return 'succeeded';
      }
      if (active.versionId !== lease.expectedSourceVersionId) {
        throw new Error('control_worker_source_version_changed');
      }
      const restore = buildPreservingWorkerSettingsPatch({
        currentSettings: settings,
        sourceVersionId: lease.expectedSourceVersionId,
        desiredBindings: [],
      });
      await this.repository.recordPatchStarted({
        target,
        lease,
        previousDeploymentId: active.deploymentId,
        restoreSettingsJson: JSON.stringify(restore),
        now,
      });
      if (!(await this.repository.leaseIsCurrent(lease, this.now()))) {
        throw new Error('control_worker_deployment_lease_lost');
      }
      const patch = buildRemovingWorkerBindingSettingsPatch({
        currentSettings: settings,
        sourceVersionId: lease.expectedSourceVersionId,
        bindingName,
      });
      const beforePatch = activeWorkerDeployment(await this.api.listWorkerDeployments(router));
      if (
        beforePatch.deploymentId !== active.deploymentId ||
        beforePatch.versionId !== lease.expectedSourceVersionId
      ) {
        throw new Error('control_worker_source_version_changed');
      }
      try {
        await this.api.patchWorkerSettings(router, patch);
      } catch (error) {
        // A lost response can hide a successful PATCH; only a reflected change is accepted as one.
        const reflected = await this.api.getWorkerSettings(router);
        if (bindingByName(reflected, bindingName)) throw error;
      }
      return this.observeDetach(
        row,
        target,
        lease,
        deployments,
        settings,
        bindingName,
        active.deploymentId
      );
    }
    // An earlier pass already sent the PATCH. Observe what the provider shows before doing more.
    if (present) {
      if (active.versionId !== lease.expectedSourceVersionId) {
        await this.repository.markBlocked(
          target,
          'control_worker_concurrent_deployment_detected',
          now
        );
        return 'blocked';
      }
      const started = lease.mutationStartedAt;
      if (
        started !== null &&
        started !== undefined &&
        now - started >= PATCH_PROPAGATION_GRACE_SECONDS &&
        (await this.repository.rearmPatchIntent({ target, lease, now }))
      ) {
        return 'deferred';
      }
      await this.repository.recordTransientError(
        target,
        'control_worker_patch_propagating',
        now + RETRY_SECONDS,
        now
      );
      return 'deferred';
    }
    return this.observeDetach(
      row,
      target,
      lease,
      deployments,
      null,
      bindingName,
      lease.previousDeploymentId
    );
  }

  /** Checks the reflected result of a detach PATCH and records it. `before` is null on recovery. */
  private async observeDetach(
    row: ServiceSiteBindingRow,
    target: ServiceSiteBindingTarget,
    lease: ServiceSiteDeploymentLease,
    deploymentsBefore: CloudflareWorkerDeployment[],
    before: CloudflareWorkerSettings | null,
    bindingName: string,
    previousDeploymentId: string | null
  ): Promise<Outcome> {
    const router = row.router_worker_script_name;
    const now = this.now();
    const deploymentsAfter = await this.api.listWorkerDeployments(router);
    const activeAfter = activeWorkerDeployment(deploymentsAfter);
    if (activeAfter.versionId === lease.expectedSourceVersionId) {
      await this.repository.recordTransientError(
        target,
        'control_worker_patch_propagating',
        now + RETRY_SECONDS,
        now
      );
      return 'deferred';
    }
    // Exactly one deployment must have appeared, and it must be the one that is now active.
    const sorted = deploymentsAfter
      .slice()
      .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
    const previousIndex = sorted.findIndex((deployment) => deployment.id === previousDeploymentId);
    const beforeIds = new Set(deploymentsBefore.map((deployment) => deployment.id));
    const isNew = (id: string) => !beforeIds.has(id);
    if (
      sorted[0]?.id !== activeAfter.deploymentId ||
      previousIndex !== 1 ||
      (before !== null &&
        deploymentsAfter.filter((deployment) => isNew(deployment.id)).length !== 1)
    ) {
      await this.repository.markBlocked(
        target,
        'control_worker_concurrent_deployment_detected',
        now
      );
      return 'blocked';
    }
    const reflected = await this.api.getWorkerSettings(router);
    await this.repository.recordPatchResult({
      target,
      lease,
      versionId: activeAfter.versionId,
      deploymentId: activeAfter.deploymentId,
      now,
    });
    const issues = before
      ? verifyWorkerSettingsBindingsRemoved({
          before,
          after: reflected,
          bindingNames: [bindingName],
        })
      : verifyWorkerSettingsRestoreIntent({
          restoreSettings: this.withoutBinding(
            parseRestoreSettings(row.previous_restore_settings_json),
            bindingName
          ),
          after: reflected,
          desiredBindings: [],
        });
    if (issues.length > 0) {
      await this.repository.markRollbackRequired(
        target,
        'control_worker_settings_preservation_failed',
        now
      );
      await this.repository.releaseDeploymentLease(lease);
    }
    return 'deferred';
  }

  private withoutBinding(
    settings: CloudflareWorkerSettings,
    bindingName: string
  ): CloudflareWorkerSettings {
    return {
      ...settings,
      bindings: (settings.bindings ?? []).filter((binding) => binding.name !== bindingName),
    };
  }

  /** The settled check: the provider still shows the requested binding state. */
  private async stabilize(
    row: ServiceSiteBindingRow,
    lease: ServiceSiteDeploymentLease
  ): Promise<Outcome> {
    const target = serviceSiteTarget(row);
    const now = this.now();
    const settings = await this.api.getWorkerSettings(row.router_worker_script_name);
    const binding = bindingByName(settings, row.binding_name);
    const reflected =
      row.desired_state === 'attached'
        ? binding?.type === 'service' && binding.service === row.desired_worker_name
        : binding === undefined;
    if (!reflected) {
      await this.repository.markBlocked(target, 'service_site_binding_reflection_mismatch', now);
      return 'blocked';
    }
    await this.repository.markSucceeded(row, lease, now);
    return 'succeeded';
  }

  private async rollback(
    row: ServiceSiteBindingRow,
    lease: ServiceSiteDeploymentLease,
    active: ReturnType<typeof activeWorkerDeployment>
  ): Promise<Outcome> {
    const router = row.router_worker_script_name;
    const target = serviceSiteTarget(row);
    const now = this.now();
    if (
      !row.patch_result_version_id ||
      !row.patch_result_deployment_id ||
      active.versionId !== row.patch_result_version_id ||
      active.deploymentId !== row.patch_result_deployment_id
    ) {
      await this.repository.markBlocked(target, 'service_site_newer_deployment_detected', now);
      return 'blocked';
    }
    if (!(await this.repository.leaseIsCurrent(lease, now))) return 'deferred';
    const previous = parseBinding(row.previous_binding_json);
    const settings = await this.api.getWorkerSettings(router);
    const present = bindingByName(settings, row.binding_name) !== undefined;
    // Put the binding back as it was: the earlier binding, or none when the router had none.
    let reflected = settings;
    if (previous || present) {
      const patch = previous
        ? buildPreservingWorkerSettingsPatch({
            currentSettings: settings,
            sourceVersionId: active.versionId,
            desiredBindings: [previous],
          })
        : buildRemovingWorkerBindingSettingsPatch({
            currentSettings: settings,
            sourceVersionId: active.versionId,
            bindingName: row.binding_name,
          });
      await this.api.patchWorkerSettings(router, patch);
      reflected = await this.api.getWorkerSettings(router);
      const issues = previous
        ? verifyWorkerSettingsPreserved({
            before: settings,
            after: reflected,
            desiredBindings: [previous],
          })
        : verifyWorkerSettingsBindingsRemoved({
            before: settings,
            after: reflected,
            bindingNames: [row.binding_name],
          });
      if (issues.length > 0) {
        await this.repository.markBlocked(target, 'service_site_rollback_failed', now);
        return 'blocked';
      }
    }
    // The checks above are relative to the settings the rollback started from, which may already
    // be damaged. Only the settings saved before the change say what the router should look like.
    const restoreIssues = verifyWorkerSettingsRestoreIntent({
      restoreSettings: parseRestoreSettings(row.previous_restore_settings_json),
      after: reflected,
      desiredBindings: previous ? [previous] : [],
    });
    if (restoreIssues.length > 0) {
      await this.repository.markBlocked(target, 'service_site_rollback_failed', now);
      return 'blocked';
    }
    const restoredService =
      previous && typeof previous.service === 'string' ? previous.service : null;
    await this.repository.markRolledBack(target, restoredService, this.now());
    await this.repository.releaseDeploymentLease(lease);
    return 'blocked';
  }
}
