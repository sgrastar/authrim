/**
 * The lite Login UI guard for the settings categories that can give a lite tenant something the
 * lite UI cannot do, judged on the document the save would leave (a dry run):
 * - `authentication-methods`: DID sign-in or the directory password switched on; and the actions
 *   that require human verification, which the lite policy publishes with the save;
 * - `login-ui`: a published account page with a block the lite UI cannot render;
 * - `self-service`: an account page at a path of the tenant's own (the lite UI serves `/account`).
 * `login-ui.lite_mode` itself is never saved here (PUT /api/admin/login-ui/lite-mode).
 */
import {
  ConflictError,
  createAuthContextFromHono,
  humanVerificationSelectionFromSettings,
  settingsParentScopes,
  type CategoryName,
  type Env,
  type LiteHumanVerificationRequired,
  type LiteModeIssue,
  type SettingScope,
} from '@authrim/ar-lib-core';
import type { Context } from 'hono';
import { patchTouchesHumanVerification } from '../../human-verification-guards';
import { runLiteGuardedWrite } from '../../lite-mode-guard';
import {
  liteAccountPageIssuesFromLoginUISettings,
  liteAccountPagePathIssues,
  liteMethodIssuesFromAuthenticationMethods,
  liteMethodsOnInAuthenticationMethods,
  liteScreenIssuesForTenant,
  resolveLiteMethodState,
} from '../../lite-mode-readiness';
import { getSettingsManager, parsePatchRequest } from './settings-support';

const LITE_MODE_KEY = 'login-ui.lite_mode';
const ACCOUNT_PAGE_PATH_KEY = 'self-service.account_page_path';

/** Whether a settings change names `key` (set, clear or disable). */
function patchTouchesKey(
  body: { set?: Record<string, unknown>; clear?: string[]; disable?: string[] },
  key: string
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(body.set ?? {}, key) ||
    (body.clear ?? []).includes(key) ||
    (body.disable ?? []).includes(key)
  );
}

/** Whether a settings change names `login-ui.lite_mode` (set, clear or disable). */
export function patchTouchesLiteMode(body: {
  set?: Record<string, unknown>;
  clear?: string[];
  disable?: string[];
}): boolean {
  return (
    Object.prototype.hasOwnProperty.call(body.set ?? {}, LITE_MODE_KEY) ||
    (body.clear ?? []).includes(LITE_MODE_KEY) ||
    (body.disable ?? []).includes(LITE_MODE_KEY)
  );
}

export async function guardTenantSettingsChangeForLite(input: {
  c: Context;
  tenantId: string;
  category: CategoryName;
  actor: string;
  readBody: () => Promise<unknown>;
  save: () => Promise<Response>;
}): Promise<Response> {
  const { c, tenantId, category } = input;
  let raw: unknown;
  try {
    raw = await input.readBody();
  } catch {
    // An unreadable body: the save answers it as it always has (400, with its audit record).
    return input.save();
  }
  const body = parsePatchRequest(raw);
  let humanVerificationAfter: LiteHumanVerificationRequired | null = null;

  const check = async (): Promise<LiteModeIssue[]> => {
    const manager = getSettingsManager(c.env as Env, c, true, false, undefined, {
      readOnly: true,
    });
    const scope: SettingScope = { type: 'tenant', id: tenantId };
    let after: Record<string, unknown> | null = null;
    try {
      const decision = await manager.patch(category, scope, body, input.actor, {
        parents: settingsParentScopes(category, scope),
        dryRun: true,
      });
      after = decision.candidate?.after ?? null;
    } catch (error) {
      // A stale `ifMatch` saves nothing: the save answers it (409). Anything else means the
      // change could not be judged, so it must not be saved (the guard answers 503).
      if (error instanceof ConflictError) return [];
      throw error;
    }
    if (!after) return [];
    if (category === 'authentication-methods') {
      if (patchTouchesHumanVerification(body)) {
        humanVerificationAfter = { ...humanVerificationSelectionFromSettings(after).required };
      }
      return [
        ...liteMethodIssuesFromAuthenticationMethods(after),
        ...(await screensRevealedBy(after)),
      ];
    }
    if (category === 'self-service') return liteAccountPagePathIssues(after);
    return liteAccountPageIssuesFromLoginUISettings(after);
  };

  /**
   * A method switched on shows the blocks a screen keeps for it (`feature_enabled`): the screens
   * are judged again with the methods on now and the ones the change switches on. Only what the
   * change reveals is reported.
   */
  const screensRevealedBy = async (after: Record<string, unknown>): Promise<LiteModeIssue[]> => {
    const env = c.env as Env;
    const now = await resolveLiteMethodState(env, tenantId);
    const then = new Set([...now.enabled, ...liteMethodsOnInAuthenticationMethods(after)]);
    if (then.size === now.enabled.size) return [];
    const db = createAuthContextFromHono(c as Context<{ Bindings: Env }>, tenantId).coreAdapter;
    const key = (issue: LiteModeIssue) => `${issue.code}|${issue.subject}|${issue.detail}`;
    const before = new Set((await liteScreenIssuesForTenant(db, tenantId, now.enabled)).map(key));
    return (await liteScreenIssuesForTenant(db, tenantId, then)).filter(
      (issue) => !before.has(key(issue))
    );
  };

  return runLiteGuardedWrite(c, tenantId, {
    check,
    write: input.save,
    humanVerificationAfter: () => humanVerificationAfter,
    // A switch to `always` publishes the required actions it reads from these settings, and
    // checks the account page's path: a change of either must not run at the same time (a save
    // judged with lite off must not land after the switch).
    serializeWithSwitch:
      (category === 'authentication-methods' && patchTouchesHumanVerification(body)) ||
      (category === 'self-service' && patchTouchesKey(body, ACCOUNT_PAGE_PATH_KEY)),
  });
}
