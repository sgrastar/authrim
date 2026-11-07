/**
 * The lite Login UI: a server-rendered Login UI for very poor networks, switched on per tenant.
 *
 * This file is the shared contract between the admin guard (ar-management), the runtimes that
 * refuse what the lite UI cannot do (ar-auth, ar-bridge, ar-saml) and the Login UI itself:
 * the modes, the policy snapshot, and what the lite UI can render.
 */

/** `off`: the normal Login UI. `always`: every in-scope page of the tenant is the lite UI. */
export const LITE_MODES = ['off', 'always'] as const;
export type LiteMode = (typeof LITE_MODES)[number];

export function isLiteMode(value: unknown): value is LiteMode {
  return value === 'off' || value === 'always';
}

/**
 * Until the lite UI is complete, no tenant can switch it on. A staging environment may set
 * `LOGIN_UI_LITE_PRERELEASE=allow` to try it; nothing else lifts the lock.
 */
export const LOGIN_UI_LITE_RELEASED = false;

export const LOGIN_UI_LITE_PRERELEASE_ENV = 'LOGIN_UI_LITE_PRERELEASE';

/** Whether this environment may switch a tenant's lite UI on. */
export function isLoginUILiteSelectable(
  env: Readonly<Record<string, unknown>> | null | undefined,
  released: boolean = LOGIN_UI_LITE_RELEASED
): boolean {
  return released || env?.[LOGIN_UI_LITE_PRERELEASE_ENV] === 'allow';
}

/** Per action: whether a person must pass human verification (the lite UI's proof of work). */
export interface LiteHumanVerificationRequired {
  login: boolean;
  signup: boolean;
  reauth: boolean;
}

/** The revision of a tenant that never changed its lite policy. */
export const LITE_POLICY_INITIAL_REVISION = 'initial';

/**
 * A tenant's lite policy as the policy store holds it. `policyRevision` names the combination of
 * `liteMode` and the required actions: a lite transaction records it, and a side effect is
 * refused when it no longer matches.
 */
export interface LitePolicySnapshot {
  tenantId: string;
  liteMode: LiteMode;
  humanVerificationRequired: LiteHumanVerificationRequired;
  policyRevision: string;
  generation: number;
  /** When the policy was last committed (epoch ms); 0 when it never was. */
  updatedAt: number;
}
