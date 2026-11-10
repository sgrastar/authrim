/**
 * Whether a tenant can switch to the lite Login UI, and what stops it.
 *
 * The lite UI serves every in-scope page of the tenant, so the whole tenant is checked, not only
 * what one request would reach:
 * - the environment: the lite UI is released (or pre-release is allowed) and the policy store
 *   is bound;
 * - sign-in methods the tenant has on: directory password and DID sign-in are not in the lite UI;
 * - every published Flow assigned for sign-in or sign-up: only components the lite UI drives;
 * - every active screen of the tenant, and the system screens a tenant without its own falls back
 *   to: only blocks the lite UI renders (a block for a method that is off never shows);
 * - the published account page's screens;
 * - applications with their own Login UI (`login_ui_url`): the lite UI cannot serve them;
 * - external sign-in returns to the issuer `buildIssuerUrl` names; it has to be the tenant's
 *   canonical issuer, or the browser binding cookie would be on another host.
 *
 * The same functions judge a single change (a screen, a Flow version, a settings document) while
 * the tenant is in lite mode (lite-mode-guard.ts).
 */
import type { Context } from 'hono';
import {
  buildIssuerUrl,
  createAuthContextFromHono,
  DEFAULT_RUNTIME_SCREEN_KEYS,
  EDITABLE_DEFAULT_SCREEN_KEYS,
  getLitePolicyStore,
  humanVerificationSettingsKey,
  isLoginUILiteSelectable,
  LITE_FLOW_KINDS,
  liteAccountScreenIssues,
  liteFlowComponentIssues,
  liteScreenIssues,
  normalizeLiteModeIssues,
  resolveRuntimeScreenRow,
  type DatabaseAdapter,
  type Env,
  type LiteModeIssue,
  type ScreenField,
  publishedAccountPageFromSettings,
} from '@authrim/ar-lib-core';
import { buildCanonicalTenantIssuerUrl } from '@authrim/ar-lib-core/services/tenant-vanity-domain-resolver';
import {
  builtInAuthenticationMethodsFromSettings,
  resolveBuiltInAuthenticationMethods,
  resolveDirectoryPasswordMethod,
} from './authentication-methods';

type AnyContext = Context;

const MAX_LISTED_CLIENTS = 20;
const TEMPLATE_SCREEN_KEYS = new Set(EDITABLE_DEFAULT_SCREEN_KEYS.map((key) => `${key}_template`));

interface ScreenRow {
  screen_key: string;
  screen_kind: string;
  fields_json: string | null;
}

function parseFields(json: string | null): ScreenField[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ScreenField[]) : [];
  } catch {
    return [];
  }
}

/** The authentication-methods document the servers read (KV), or null. */
async function readAuthenticationMethodsDocument(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown> | null> {
  const raw = await env.SETTINGS?.get(humanVerificationSettingsKey(tenantId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** The unsupported sign-in methods an authentication-methods document switches on. */
export function liteMethodIssuesFromAuthenticationMethods(
  document: Readonly<Record<string, unknown>> | null
): LiteModeIssue[] {
  const issues: LiteModeIssue[] = [];
  if (document?.['authentication-methods.did.login_enabled'] === true) {
    issues.push({ code: 'method_unsupported', subject: 'did' });
  }
  if (document?.['authentication-methods.directory_password.enabled'] === true) {
    issues.push({ code: 'method_unsupported', subject: 'directory_password' });
  }
  return issues;
}

/**
 * The sign-in methods that are on (the names screen blocks use), and the unsupported ones among
 * them. External providers count as on: their blocks are checked whatever the provider list says.
 */
export async function resolveLiteMethodState(
  env: Env,
  tenantId: string
): Promise<{ enabled: Set<string>; issues: LiteModeIssue[] }> {
  const [builtIn, directoryPassword, document] = await Promise.all([
    resolveBuiltInAuthenticationMethods(env, tenantId),
    resolveDirectoryPasswordMethod(env, tenantId),
    readAuthenticationMethodsDocument(env, tenantId),
  ]);
  const enabled = new Set<string>(['external_idp', ...builtInMethodsOn(builtIn)]);
  const issues = liteMethodIssuesFromAuthenticationMethods(document);
  if (directoryPassword.enabled) {
    enabled.add('directory_password');
    issues.push({ code: 'method_unsupported', subject: 'directory_password' });
  }
  if (document?.['authentication-methods.did.login_enabled'] === true) enabled.add('did');
  return { enabled, issues };
}

/** The screen-condition names of the built-in methods that are on. */
function builtInMethodsOn(
  builtIn: Awaited<ReturnType<typeof resolveBuiltInAuthenticationMethods>>
) {
  const on = new Set<string>();
  if (
    builtIn.passkeyLoginEnabled ||
    builtIn.passkeySignupEnabled ||
    builtIn.passkeyReauthEnabled ||
    builtIn.passkeyAccountLinkEnabled
  ) {
    on.add('passkey');
  }
  if (
    builtIn.emailCodeLoginEnabled ||
    builtIn.emailCodeSignupEnabled ||
    builtIn.emailCodeReauthEnabled ||
    builtIn.emailCodeAccountLinkEnabled
  ) {
    on.add('mail_otp');
  }
  if (
    builtIn.totpLoginEnabled ||
    builtIn.totpSignupEnabled ||
    builtIn.totpReauthEnabled ||
    builtIn.totpAccountLinkEnabled
  ) {
    on.add('totp');
  }
  if (on.has('mail_otp') && on.has('totp')) on.add('mail_otp_totp');
  return on;
}

/**
 * The sign-in methods an authentication-methods document leaves on (screen-condition names), with
 * the defaults and the older switches applied as the runtime applies them.
 */
export function liteMethodsOnInAuthenticationMethods(
  document: Readonly<Record<string, unknown>> | null
): Set<string> {
  const on = builtInMethodsOn(builtInAuthenticationMethodsFromSettings(document));
  if (document?.['authentication-methods.directory_password.enabled'] === true) {
    on.add('directory_password');
  }
  return on;
}

/** The issues of one screen as the lite UI would draw it (account screens have their own blocks). */
export function liteIssuesOfScreen(
  screen: { screen_key: string; screen_kind: string; fields: readonly ScreenField[] },
  enabledMethods: ReadonlySet<string>
): LiteModeIssue[] {
  return screen.screen_kind === 'account'
    ? liteAccountScreenIssues(screen.screen_key, screen.fields)
    : liteScreenIssues(screen.screen_key, screen.fields, enabledMethods);
}

export async function liteScreenIssuesForTenant(
  db: DatabaseAdapter,
  tenantId: string,
  enabledMethods: ReadonlySet<string>
): Promise<LiteModeIssue[]> {
  const rows = await db.query<ScreenRow>(
    `SELECT screen_key, screen_kind, fields_json FROM screens WHERE tenant_id = ? AND is_active = 1`,
    [tenantId]
  );
  // Templates are not tenant pages and must not count as active screens or suppress fallback.
  const activeRows = rows.filter((row) => !TEMPLATE_SCREEN_KEYS.has(row.screen_key));
  const own = new Set(activeRows.map((row) => row.screen_key));
  const fallbackKeys = [...DEFAULT_RUNTIME_SCREEN_KEYS].filter((key) => !own.has(key));
  const fallbackRefs = fallbackKeys.flatMap((key) =>
    TEMPLATE_SCREEN_KEYS.has(`${key}_template`) ? [key, `${key}_template`] : [key]
  );
  const systemRows =
    fallbackRefs.length > 0
      ? await db.query<ScreenRow>(
          `SELECT screen_key, screen_kind, fields_json FROM screens
            WHERE tenant_id = 'default' AND is_system = 1 AND is_active = 1
              AND screen_key IN (${fallbackRefs.map(() => '?').join(', ')})`,
          fallbackRefs
        )
      : [];
  const fallbacks = fallbackKeys
    .map(
      (key) =>
        systemRows.find((row) => row.screen_key === key) ??
        systemRows.find((row) => row.screen_key === `${key}_template`)
    )
    .filter((row): row is ScreenRow => row !== undefined);
  return [...activeRows, ...fallbacks].flatMap((row) =>
    liteIssuesOfScreen(
      {
        screen_key: row.screen_key,
        screen_kind: row.screen_kind,
        fields: parseFields(row.fields_json),
      },
      enabledMethods
    )
  );
}

function readSteps(runtimeJson: string | null): unknown[] | null {
  try {
    const runtime = runtimeJson ? (JSON.parse(runtimeJson) as { ui?: { steps?: unknown } }) : null;
    return Array.isArray(runtime?.ui?.steps) ? runtime.ui.steps : null;
  } catch {
    return null;
  }
}

/**
 * The issues of a Flow version's steps: components the lite UI cannot drive, and screens a step
 * names that do not resolve (the lite UI does not guess a screen; it stops).
 */
export async function liteIssuesOfFlowSteps(
  db: DatabaseAdapter,
  tenantId: string,
  flowId: string,
  steps: readonly unknown[] | null
): Promise<LiteModeIssue[]> {
  if (!steps) {
    return [{ code: 'flow_component_unsupported', subject: flowId, detail: 'unreadable' }];
  }
  const typed = steps.filter(
    (step): step is { component?: unknown; config?: { screen_ref?: unknown } } =>
      Boolean(step) && typeof step === 'object'
  );
  const issues = liteFlowComponentIssues(flowId, typed);
  for (const step of typed) {
    const ref = step.config?.screen_ref;
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const component = typeof step.component === 'string' ? step.component : undefined;
    if (!(await resolveRuntimeScreenRow(db, tenantId, ref.trim(), component))) {
      issues.push({ code: 'flow_screen_missing', subject: flowId, detail: ref.trim() });
    }
  }
  return issues;
}

/** The issues of a published Flow version's runtime snapshot (JSON). */
export function liteIssuesOfFlowRuntime(
  db: DatabaseAdapter,
  tenantId: string,
  flowId: string,
  runtimeJson: string | null
): Promise<LiteModeIssue[]> {
  return liteIssuesOfFlowSteps(db, tenantId, flowId, readSteps(runtimeJson));
}

interface AssignedFlowRow {
  flow_id: string;
  runtime_snapshot_json: string | null;
}

/** The published versions of the Flows assigned for sign-in or sign-up. */
async function assignedFlows(db: DatabaseAdapter, tenantId: string): Promise<AssignedFlowRow[]> {
  const kinds = [...LITE_FLOW_KINDS];
  return db.query<AssignedFlowRow>(
    `SELECT DISTINCT f.id AS flow_id, v.runtime_snapshot_json
       FROM flow_assignments a
       JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
       LEFT JOIN flow_versions v
         ON v.tenant_id = f.tenant_id AND v.flow_id = f.id AND v.id = f.published_version_id
      WHERE a.tenant_id = ?
        AND a.enabled = TRUE
        AND a.flow_kind IN (${kinds.map(() => '?').join(', ')})
        AND f.status = 'published'
        AND f.deleted_at IS NULL`,
    [tenantId, ...kinds]
  );
}

/**
 * Removing (deleting or deactivating) a screen: the assigned Flows whose steps would then name a
 * screen that does not resolve. A step that names the screen by ID loses it; one that names it by
 * key keeps the system screen only for the built-in keys.
 */
export async function liteIssuesOfScreenRemoval(
  db: DatabaseAdapter,
  tenantId: string,
  screen: { id: string; screen_key: string }
): Promise<LiteModeIssue[]> {
  const issues: LiteModeIssue[] = [];
  for (const flow of await assignedFlows(db, tenantId)) {
    for (const step of readSteps(flow.runtime_snapshot_json) ?? []) {
      const ref = (step as { config?: { screen_ref?: unknown } } | null)?.config?.screen_ref;
      if (typeof ref !== 'string') continue;
      const name = ref.trim();
      // `basic_profile` always resolves: to the tenant's screen for the step, else a system one.
      if (name === 'basic_profile') continue;
      if (
        name === screen.id ||
        (name === screen.screen_key && !DEFAULT_RUNTIME_SCREEN_KEYS.has(name))
      ) {
        issues.push({ code: 'flow_screen_missing', subject: flow.flow_id, detail: name });
      }
    }
  }
  return issues;
}

async function flowIssues(db: DatabaseAdapter, tenantId: string): Promise<LiteModeIssue[]> {
  const issues: LiteModeIssue[] = [];
  for (const row of await assignedFlows(db, tenantId)) {
    issues.push(
      ...(await liteIssuesOfFlowRuntime(db, tenantId, row.flow_id, row.runtime_snapshot_json))
    );
  }
  return issues;
}

/** The account page screens a `login-ui` settings document publishes, judged for the lite UI. */
export function liteAccountPageIssuesFromLoginUISettings(
  settings: Record<string, unknown> | null
): LiteModeIssue[] {
  const page = publishedAccountPageFromSettings(settings);
  if (!page.screens) return [];
  const enabledKeys = new Set(
    page.definition.screens.filter((item) => item.enabled).map((item) => item.screen_key)
  );
  return page.screens
    .filter((screen) => enabledKeys.has(screen.screen_key))
    .flatMap((screen) => liteAccountScreenIssues(screen.screen_key, screen.fields ?? []));
}

async function accountPageIssues(env: Env, tenantId: string): Promise<LiteModeIssue[]> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`);
  const settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  const selfServiceRaw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:self-service`);
  const selfService = selfServiceRaw ? (JSON.parse(selfServiceRaw) as Record<string, unknown>) : {};
  return [
    ...liteAccountPageIssuesFromLoginUISettings(settings),
    ...liteAccountPagePathIssues(selfService),
  ];
}

/**
 * The lite UI serves the account page at `/account` only (lib/lite/routing.ts): a path of the
 * tenant's own (`self-service.account_page_path`) would stay on the SPA, which lite mode does not
 * serve.
 */
export function liteAccountPagePathIssues(selfService: Record<string, unknown>): LiteModeIssue[] {
  // Compared as stored (the Router matches the stored text): ` /account` is another path. None set
  // is the default, `/account`.
  const path = selfService['self-service.account_page_path'];
  return path === undefined || path === null || path === '/account'
    ? []
    : [{ code: 'account_page_path_custom' }];
}

async function clientIssues(db: DatabaseAdapter, tenantId: string): Promise<LiteModeIssue[]> {
  const rows = await db.query<{ client_id: string }>(
    `SELECT client_id FROM oauth_clients
      WHERE tenant_id = ? AND login_ui_url IS NOT NULL AND TRIM(login_ui_url) <> ''
      ORDER BY client_id LIMIT ${MAX_LISTED_CLIENTS}`,
    [tenantId]
  );
  return rows.map((row) => ({ code: 'client_login_ui_url' as const, subject: row.client_id }));
}

async function issuerIssues(env: Env, tenantId: string): Promise<LiteModeIssue[]> {
  const callbackIssuer = buildIssuerUrl(env, tenantId);
  const canonical = await buildCanonicalTenantIssuerUrl(env, tenantId, callbackIssuer, {
    strict: true,
  });
  return new URL(callbackIssuer).origin === new URL(canonical).origin
    ? []
    : [{ code: 'issuer_origin_mismatch' }];
}

/** Everything that stops the tenant from switching to `always` (empty: it can). */
export async function evaluateLiteReadiness(
  c: AnyContext,
  tenantId: string
): Promise<LiteModeIssue[]> {
  const env = c.env as Env;
  const issues: LiteModeIssue[] = [];
  if (!isLoginUILiteSelectable(env as unknown as Record<string, unknown>)) {
    issues.push({ code: 'not_released' });
  }
  if (!getLitePolicyStore(env, tenantId)) issues.push({ code: 'policy_store_unavailable' });

  const db = createAuthContextFromHono(c as Context<{ Bindings: Env }>, tenantId).coreAdapter;
  const methods = await resolveLiteMethodState(env, tenantId);
  const parts = await Promise.all([
    liteScreenIssuesForTenant(db, tenantId, methods.enabled),
    flowIssues(db, tenantId),
    accountPageIssues(env, tenantId),
    clientIssues(db, tenantId),
    issuerIssues(env, tenantId),
  ]);
  return normalizeLiteModeIssues([...issues, ...methods.issues, ...parts.flat()]);
}
