/**
 * Saving one category of a tenant's settings: the checks, the validation, the write and what
 * follows it (audit, caches, the plugin gate). The tenant PATCH route and the bulk apply both run
 * it, so that nothing a PATCH checks can be skipped by the other path.
 */
import type { Context } from 'hono';
import type { IdentityMappingLevelHistoryVia } from '@authrim/ar-lib-core/services/identity-mapping-level-history';
import {
  ALL_CATEGORY_META,
  ConflictError,
  createLogger,
  getTenantMetadataContextFromHono,
  settingsParentScopes,
  type AdminAuthContext,
  type CategoryName,
  type DatabaseSource,
  type Env,
  type SettingScope,
} from '@authrim/ar-lib-core';
import { runTenantBackupCoveredMutation } from '../../tenant-backup-writer';
import {
  humanVerificationDocumentRefusal,
  patchTouchesHumanVerification,
} from '../../human-verification-guards';
import {
  disableTenantExternalPlugins,
  ExternalPluginShutdownError,
  patchTurnsExternalPluginsOff,
} from '../../external-plugin-shutdown';
import {
  reconcileRunnerExternalGate,
  setRunnerExternalGate,
} from '../../external-plugin-gate-sync';
import { identityMappingReferenceProblem } from './identity-mapping-reference';
import {
  categoryPatchNeedsState,
  categoryValidationKind,
  validateCategoryPatchAt,
  type ValidationKind,
} from './patch-validation';
import {
  canAccessTenant,
  hasTenantSettingsPermission,
  isCategoryAllowedAtScope,
} from './settings-authorization';
import {
  AUTHENTICATION_METHODS_TENANT_CACHE_CATEGORIES,
  HUMAN_VERIFICATION_SETTING_PREFIX,
  ensureTenantAccountPageEnabled,
  errorResponse,
  getSettingsManager,
  invalidateAuthenticationMethodsCacheRevision,
  parsePatchRequest,
  readScopedSettingsRecord,
  recordExternalPluginShutdownAudit,
  recordSettingsAuditFailure,
  scheduleInheritedHumanVerificationProjection,
} from './settings-support';
import {
  validateDcrReservedTargets,
  validateLoginUIPatch,
  validatePostLoginRelatedPatch,
  validateTenantUIPatch,
} from './settings-validators';

const log = createLogger().module('SETTINGS_AUDIT');

/** The parts of a failure record that are a code or a key name, nothing a validation found. */
function onlyCodes(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (!metadata) return kept;
  for (const name of ['current_version', 'error_class']) {
    if (typeof metadata[name] === 'string') kept[name] = metadata[name];
  }
  const rejected = metadata.rejected;
  if (typeof rejected === 'object' && rejected !== null) {
    kept.rejected_keys = Object.keys(rejected);
  }
  return kept;
}

export type TenantSettingsContext = Context<
  { Bindings: Env; Variables: { adminAuth?: AdminAuthContext } },
  string
>;

export interface ApplyTenantSettingsChangeInput {
  /** The request: its environment, and the audit mirror's view of who is acting. */
  c: TenantSettingsContext;
  adminAuth: AdminAuthContext | undefined;
  tenantId: string;
  category: CategoryName;
  /** The PATCH body (`ifMatch`, `set`, `clear`, `disable`), read when the save starts. */
  readBody: () => Promise<unknown>;
  /**
   * Who may reach the tenant. The tenant route lets a caller in by `canAccessTenant`; the bulk
   * apply, whose caller already holds the platform's authority, widens it only for a global
   * machine token.
   */
  canAccess?: (adminAuth: AdminAuthContext | undefined, tenantId: string) => boolean;
  /**
   * The tenant's own Core database, when the caller knows it. Left out, the request's tenant
   * context supplies it (right for the tenant route); `null` means the request's database is not
   * this tenant's, so the lookup routes by the tenant instead.
   */
  tenantCoreDb?: DatabaseSource | null;
  /** Added to every audit record this save writes (the bulk apply's ID). */
  auditMetadata?: Record<string, unknown>;
  /**
   * Run every check and decide what the save would do, without writing, auditing or touching the
   * plugin gate. The answer has the shape of a save's, with `dryRun: true`. It reads through a
   * manager that cannot create or change a document, and takes no backup mutation permit.
   */
  dryRun?: boolean;
  /** Keep the values of the change out of the audit records and the log (the bulk apply). */
  auditOmitValues?: boolean;
  /** Provenance only; the actor and the atomic write stay in the normal settings writer. */
  identityMappingHistory?: {
    via: IdentityMappingLevelHistoryVia;
    bulkId?: string;
    expectedLatestHistoryId?: string;
  };
  /**
   * Told what a refusal by a validation is about (see `ValidationKind`), for a caller that must not
   * repeat the text of a refusal that names what the tenant has saved. A refusal this does not
   * hear of (and a refusal that gives no `code`) is to be read as `state` with no code.
   */
  onRefusal?: (refusal: ValidationRefusal) => void;
}

/** What a validation that refused a save was about; `code` is a fixed one, safe to give. */
export interface ValidationRefusal {
  kind: ValidationKind;
  code?: string;
}

/**
 * Applies a PATCH to one category of one tenant's settings and answers as the PATCH route does.
 */
export async function applyTenantSettingsChange(
  input: ApplyTenantSettingsChangeInput
): Promise<Response> {
  const { c, adminAuth, tenantId, category } = input;
  const dryRun = input.dryRun === true;
  const canAccess = input.canAccess ?? canAccessTenant;
  const auditFailure = async (details: {
    category: CategoryName;
    scope: SettingScope;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    if (dryRun) return;
    // For the bulk apply, the failure record holds codes and key names only: what a validation
    // found (an ID of a client, a link, the values of other settings) is left out.
    const detail = input.auditOmitValues ? onlyCodes(details.metadata) : details.metadata;
    await recordSettingsAuditFailure(c, {
      ...details,
      ...(input.auditMetadata || detail ? { metadata: { ...input.auditMetadata, ...detail } } : {}),
    });
  };

  // Security Check 1: Validate category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Security Check 2: Validate category is available at tenant scope
  if (!isCategoryAllowedAtScope(category, 'tenant')) {
    return errorResponse(
      c,
      'bad_request',
      `Category "${category}" is not available at tenant scope`,
      400
    );
  }

  // Security Check 3: Validate user has EDIT permission for this category at tenant scope
  if (!hasTenantSettingsPermission(adminAuth, category, 'edit', tenantId)) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to edit tenant settings', 403);
  }

  // Security Check 4: Validate user can access this specific tenant
  if (!canAccess(adminAuth, tenantId)) {
    return errorResponse(c, 'forbidden', 'Cannot modify settings for this tenant', 403);
  }

  // A dry run writes nothing, so it is not a mutation the tenant backup has to cover.
  const covered = (run: () => Promise<Response>): Promise<Response> =>
    dryRun ? run() : runTenantBackupCoveredMutation({ env: c.env, tenantId, run });

  return covered(async () => {
    const manager = getSettingsManager(c.env, c, true, false, input.auditMetadata, {
      readOnly: dryRun,
      omitAuditValues: input.auditOmitValues,
      identityMappingHistory: input.identityMappingHistory,
    });
    const scope: SettingScope = { type: 'tenant', id: tenantId };

    try {
      // Parse and sanitize request body (prevent prototype pollution)
      const rawBody = await input.readBody();
      const body = parsePatchRequest(rawBody);

      // Validate ifMatch is provided
      if (!body.ifMatch) {
        await auditFailure({ category, scope, reason: 'if_match_required' });
        return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
      }

      if (category === 'login-ui') {
        const loginUiValidation = validateLoginUIPatch(body);
        if (!loginUiValidation.ok) {
          input.onRefusal?.({ kind: 'value', code: 'value_invalid' });
          await auditFailure({
            category,
            scope,
            reason: 'login_ui_validation_failed',
            metadata: loginUiValidation.details,
          });
          return errorResponse(
            c,
            'validation_failed',
            loginUiValidation.message ?? 'Login UI settings are invalid',
            400,
            loginUiValidation.details
          );
        }
      }

      if (category === 'tenant') {
        const tenantUiError = await validateTenantUIPatch(body, c.env, tenantId);
        if (tenantUiError) {
          input.onRefusal?.({ kind: 'state', code: 'value_invalid' });
          await auditFailure({
            category,
            scope,
            reason: 'tenant_ui_validation_failed',
          });
          return errorResponse(c, 'validation_failed', tenantUiError, 400);
        }
      }

      // CIBA and device flow bounds are checked on the document the save leaves: the tenant's
      // current values stand in for the keys the PATCH does not hold, and a cleared key takes
      // what it inherits (the platform, an environment variable or the default).
      const patchState = categoryPatchNeedsState(category)
        ? await manager.getAll(category, scope, {
            parents: settingsParentScopes(category, scope),
          })
        : null;
      const categoryError = validateCategoryPatchAt(
        category,
        'tenant',
        body,
        patchState && { current: patchState.values, inherited: patchState.inherited.values }
      );
      if (categoryError) {
        const kind = categoryValidationKind(category);
        input.onRefusal?.({ kind, code: kind === 'state' ? 'bounds_not_met' : 'value_invalid' });
        await auditFailure({
          category,
          scope,
          reason: `${category.replace('-', '_')}_validation_failed`,
        });
        return errorResponse(c, 'validation_failed', categoryError, 400);
      }

      if (category === 'dcr') {
        const dcrTarget = await validateDcrReservedTargets(
          body,
          c.env,
          tenantId,
          input.tenantCoreDb === undefined
            ? getTenantMetadataContextFromHono(
                c as unknown as Parameters<typeof getTenantMetadataContextFromHono>[0]
              )?.coreDb
            : (input.tenantCoreDb ?? undefined)
        );
        if (dcrTarget.unavailable) {
          await auditFailure({
            category,
            scope,
            reason: 'dcr_issuers_unavailable',
          });
          return errorResponse(
            c,
            'temporarily_unavailable',
            "The tenant's issuers cannot be determined right now, so the default target cannot be checked; try again",
            503
          );
        }
        if (dcrTarget.problem) {
          input.onRefusal?.({ kind: 'state', code: 'value_invalid' });
          await auditFailure({
            category,
            scope,
            reason: 'dcr_validation_failed',
          });
          return errorResponse(c, 'validation_failed', dcrTarget.problem, 400);
        }
      }

      if (category === 'identity-mapping') {
        const mappingProblem = await identityMappingReferenceProblem(c.env, body, {
          type: 'tenant',
          tenantId,
        });
        if (mappingProblem) {
          input.onRefusal?.({ kind: 'state', code: mappingProblem.reason });
          await auditFailure({
            category,
            scope,
            reason: mappingProblem.reason,
          });
          return mappingProblem.status === 503
            ? errorResponse(c, 'temporarily_unavailable', mappingProblem.message, 503)
            : errorResponse(c, 'validation_failed', mappingProblem.message, 400);
        }
      }

      const postLoginValidation = await validatePostLoginRelatedPatch(
        c.env,
        tenantId,
        category,
        body,
        dryRun ? 'none' : undefined
      );
      if (!postLoginValidation.ok) {
        input.onRefusal?.({ kind: 'state', code: 'dependency_not_met' });
        await auditFailure({
          category,
          scope,
          reason: 'post_login_validation_failed',
          metadata: postLoginValidation.details,
        });
        return errorResponse(
          c,
          postLoginValidation.error,
          postLoginValidation.message,
          postLoginValidation.status,
          postLoginValidation.details
        );
      }

      // Get actor from context (set by auth middleware)
      const actor = adminAuth?.userId ?? 'unknown';

      // Turning external plugin code off (`plugin.enabled`). What stops external code is the
      // tenant gate in ar-plugin-runner, so, before anything is saved: (a) close the gate;
      // (b) switch the tenant's external installations off. Either failing refuses the PATCH
      // (503) and saves nothing: never a saved "off" that the runner has not been told. This
      // only runs for a change the settings manager would accept (a dry run decides, so a
      // refused or conflicting request stops nothing). If the save then fails (a version
      // conflict between the dry run and the save), the gate stays closed and the
      // installations stay off, which is the safe side: a later save of "on" (or enabling an
      // external plugin) opens the gate again from the saved setting.
      let externalPluginsTurnedOff = false;
      if (category === 'plugin') {
        const decision = await manager.patch(category, scope, body, actor, {
          parents: settingsParentScopes(category, scope),
          dryRun: true,
        });
        externalPluginsTurnedOff = await patchTurnsExternalPluginsOff(body, decision, async () => {
          const state = await manager.getAll(category, scope, {
            parents: settingsParentScopes(category, scope),
          });
          return state.inherited.values['plugin.enabled'];
        });
      }
      // A dry run only decides: it closes no gate and switches nothing off.
      if (externalPluginsTurnedOff && !dryRun) {
        try {
          await setRunnerExternalGate(c.env, tenantId, false);
        } catch {
          log.error('Failed to close the external plugin gate; plugin.enabled was not saved', {
            tenantId,
          });
          await auditFailure({
            category,
            scope,
            reason: 'external_plugin_gate_close_failed',
          });
          return errorResponse(
            c,
            'temporarily_unavailable',
            "The tenant's external plugin gate could not be closed, so plugin.enabled was not changed; try again",
            503,
            { reason: 'external_plugin_gate_unavailable' }
          );
        }
        try {
          const stopped = await disableTenantExternalPlugins(c.env, tenantId);
          if (stopped.length > 0) {
            await recordExternalPluginShutdownAudit(c, {
              scope,
              stopped,
              outcome: 'success',
              failedPluginId: null,
            });
          }
        } catch (error) {
          const stopped = error instanceof ExternalPluginShutdownError ? error.stopped : [];
          const failed = error instanceof ExternalPluginShutdownError ? error.failedPluginId : null;
          log.error('Failed to switch off external plugins; plugin.enabled was not saved', {
            tenantId,
            stoppedPluginIds: stopped,
            failedPluginId: failed,
          });
          await recordExternalPluginShutdownAudit(c, {
            scope,
            stopped,
            outcome: 'failure',
            failedPluginId: failed,
          });
          await auditFailure({
            category,
            scope,
            reason: 'external_plugin_shutdown_failed',
            metadata: { stopped_plugin_ids: stopped, failed_plugin_id: failed },
          });
          return errorResponse(
            c,
            'temporarily_unavailable',
            "The tenant's external plugins could not all be switched off, so plugin.enabled was not changed; try again",
            503,
            { reason: 'external_plugin_shutdown_failed', stopped_plugin_ids: stopped }
          );
        }
      }

      const authenticationMethodsBefore =
        category === 'authentication-methods'
          ? await readScopedSettingsRecord(c.env, category, scope)
          : null;

      // Turning a flow's human verification on (or switching the provider under it) while the
      // provider is disabled or has no credentials would leave the flow with no widget and a
      // server that refuses every attempt: refuse it. Only a change that creates the mismatch
      // is refused; a tenant already in one can still save its other settings.
      if (category === 'authentication-methods' && patchTouchesHumanVerification(body)) {
        // Judged on what the save would act on: the canonical document, with the operations
        // the manager rejects left out (a dry run decides both).
        const decision = await manager.patch(category, scope, body, actor, {
          parents: settingsParentScopes(category, scope),
          dryRun: true,
        });
        const refusal = decision.candidate
          ? await humanVerificationDocumentRefusal(
              c.env,
              tenantId,
              decision.candidate.before,
              decision.candidate.after
            )
          : null;
        if (refusal) {
          input.onRefusal?.({ kind: 'state', code: `human_verification_${refusal.reason}` });
          await auditFailure({
            category,
            scope,
            reason: 'human_verification_provider_unavailable',
            metadata: { plugin_id: refusal.pluginId, reason: refusal.reason },
          });
          return errorResponse(
            c,
            'human_verification_provider_unavailable',
            refusal.reason === 'provider_disabled'
              ? 'The human verification provider is not enabled for this tenant, so a flow cannot be made to require it. Enable the plugin first.'
              : 'The human verification provider has no credentials for this tenant, so a flow cannot be made to require it. Configure the plugin first.',
            400,
            {
              reason: refusal.reason,
              plugin_id: refusal.pluginId,
              settings: refusal.settings,
            }
          );
        }
      }

      const result = await manager.patch(category, scope, body, actor, {
        parents: settingsParentScopes(category, scope),
        ...(dryRun ? { dryRun: true } : {}),
      });

      if (
        !dryRun &&
        category === 'login-entry' &&
        body.set?.['login-entry.post_login_behavior'] === 'account' &&
        result.applied.includes('login-entry.post_login_behavior')
      ) {
        await ensureTenantAccountPageEnabled(manager, tenantId, actor);
      }

      // Check if there were any rejections
      const hasRejections = Object.keys(result.rejected).length > 0;
      const hasApplied =
        result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;
      const changedKeys = [...result.applied, ...result.cleared, ...result.disabled];

      if (
        !dryRun &&
        authenticationMethodsBefore &&
        changedKeys.some((key) => key.startsWith(HUMAN_VERIFICATION_SETTING_PREFIX))
      ) {
        const authenticationMethodsAfter = await readScopedSettingsRecord(c.env, category, scope);
        await scheduleInheritedHumanVerificationProjection(
          c.env,
          tenantId,
          authenticationMethodsBefore,
          authenticationMethodsAfter
        );
      }

      // Return appropriate status
      // 200 OK if anything was applied (even with rejections)
      // 400 Bad Request if everything was rejected
      if (!hasApplied && hasRejections) {
        // The reasons are the manager's: about the keys and values sent, and the metadata of the
        // settings they depend on, never what the tenant has saved.
        input.onRefusal?.({ kind: 'value' });
        await auditFailure({
          category,
          scope,
          reason: 'validation_failed',
          metadata: { rejected: result.rejected },
        });
        return c.json(
          {
            error: 'validation_failed',
            message: 'All changes were rejected',
            ...result,
          },
          400
        );
      }

      if (dryRun) {
        // What the save would do; the manager's candidate documents stay inside.
        return c.json({
          version: result.version,
          applied: result.applied,
          cleared: result.cleared,
          disabled: result.disabled,
          rejected: result.rejected,
          dryRun: true as const,
        });
      }

      if (hasApplied && AUTHENTICATION_METHODS_TENANT_CACHE_CATEGORIES.has(category)) {
        await invalidateAuthenticationMethodsCacheRevision(c, tenantId, `tenant:${category}`);
      }

      // Bring the runner's gate in step with what was just saved (the saved setting, not the
      // KV copy). A turn-off closed it already, so only an unchanged-or-opened gate can be
      // late: then the gate stays closed (fail-closed) and the response says so, and the same
      // PATCH again, or enabling an external plugin, opens it.
      if (category === 'plugin' && changedKeys.includes('plugin.enabled')) {
        try {
          await reconcileRunnerExternalGate(c.env, tenantId);
        } catch {
          log.warn('External plugin gate was not brought in step with plugin.enabled', {
            tenantId,
          });
          // After a turn-off this means the closing after the save did not go through, so a
          // concurrent enable may have reopened the gate: say so (the periodic reconciliation
          // closes it) and leave a record of it.
          if (externalPluginsTurnedOff) {
            await auditFailure({
              category,
              scope,
              reason: 'external_plugin_gate_resync_failed',
            });
          }
          return c.json({ ...result, externalPluginGate: 'pending' as const });
        }
      }

      return c.json(result);
    } catch (error) {
      // Handle JSON parse errors
      if (error instanceof SyntaxError) {
        await auditFailure({ category, scope, reason: 'invalid_json' });
        return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
      }
      if (error instanceof ConflictError) {
        await auditFailure({
          category,
          scope,
          reason: 'version_conflict',
          metadata: { current_version: error.currentVersion },
        });
        return c.json(
          {
            error: 'conflict',
            message: error.message,
            currentVersion: error.currentVersion,
          },
          409
        );
      }
      if (error instanceof Error) {
        if (error.message.includes('Unknown category')) {
          await auditFailure({ category, scope, reason: 'unknown_category' });
          return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
        }
        if (error.message.includes('read-only')) {
          await auditFailure({ category, scope, reason: 'read_only' });
          return errorResponse(c, 'forbidden', error.message, 403);
        }
      }
      await auditFailure({
        category,
        scope,
        reason: 'unhandled_error',
        metadata: { error_class: error instanceof Error ? error.name : 'unknown_error' },
      });
      throw error;
    }
  });
}
