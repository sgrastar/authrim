/**
 * Human verification for a tenant in lite mode: the lite Login UI's proof of work.
 *
 * While the tenant's policy store says `always`, the policy store alone decides which actions
 * require a proof (`humanVerificationRequired`), and the proof must be bound to the tenant, the
 * screen's action and the current `policyRevision`. A verified proof is claimed in the
 * ChallengeStore until it expires and never consumed (a consumed record could be claimed again),
 * so each proof is spent once, whatever happens to the request after.
 *
 * Settings (`authentication-methods.human_verification.pow_*`) read KV, then the environment, then
 * the code default, each kept within its bounds.
 */
import type { Env } from '../types/env';
import { AUTHENTICATION_METHODS_SETTINGS_META } from '../types/settings/authentication-methods';
import type { SettingMeta } from '../utils/settings-manager';
import { getChallengeStoreForLease } from '../utils/challenge-sharding';
import type { LitePolicySnapshot } from '../types/login-ui-lite';
import type { HumanVerificationFlow } from './human-verification-policy';
import { humanVerificationSettingsKey } from './human-verification-policy';
import { loadPowKeyringFromEnv, verifyPowSolution } from './human-verification-pow';

export interface LitePowSettings {
  maxNumber: number;
  ttlSeconds: number;
  issuePerIpPerMinute: number;
  issuePerTenantPerMinute: number;
}

const PREFIX = 'authentication-methods.human_verification.';

function boundedNumber(meta: SettingMeta, ...candidates: unknown[]): number {
  for (const candidate of candidates) {
    const value =
      typeof candidate === 'string' && candidate.trim() !== '' ? Number(candidate) : candidate;
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      (meta.min === undefined || value >= meta.min) &&
      (meta.max === undefined || value <= meta.max)
    ) {
      return value;
    }
  }
  return meta.default as number;
}

/** The proof-of-work settings of a tenant, from its authentication-methods document. */
export function litePowSettingsFrom(
  document: Readonly<Record<string, unknown>> | null,
  env: Readonly<Record<string, unknown>>
): LitePowSettings {
  const read = (name: string) => {
    const meta: SettingMeta =
      AUTHENTICATION_METHODS_SETTINGS_META[
        `${PREFIX}${name}` as keyof typeof AUTHENTICATION_METHODS_SETTINGS_META
      ];
    return boundedNumber(meta, document?.[meta.key], meta.envKey ? env[meta.envKey] : undefined);
  };
  return {
    maxNumber: read('pow_max_number'),
    ttlSeconds: read('pow_challenge_ttl'),
    issuePerIpPerMinute: read('pow_issue_per_ip_per_minute'),
    issuePerTenantPerMinute: read('pow_issue_per_tenant_per_minute'),
  };
}

/** The lite transaction budgets of a tenant (`human_verification.lite_txn_*`), bounded. */
export interface LiteTxnLimits {
  perIpPerMinute: number;
  perTenantPerMinute: number;
  perBrowser: number;
}

export function liteTxnLimitsFrom(
  document: Readonly<Record<string, unknown>> | null,
  env: Readonly<Record<string, unknown>>
): LiteTxnLimits {
  const read = (name: string) => {
    const meta: SettingMeta =
      AUTHENTICATION_METHODS_SETTINGS_META[
        `${PREFIX}${name}` as keyof typeof AUTHENTICATION_METHODS_SETTINGS_META
      ];
    return boundedNumber(meta, document?.[meta.key], meta.envKey ? env[meta.envKey] : undefined);
  };
  return {
    perIpPerMinute: read('lite_txn_per_ip_per_minute'),
    perTenantPerMinute: read('lite_txn_per_tenant_per_minute'),
    perBrowser: read('lite_txn_per_browser'),
  };
}

async function readAuthenticationMethodsDocument(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await env.SETTINGS?.get(humanVerificationSettingsKey(tenantId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function readLiteTxnLimits(env: Env, tenantId: string): Promise<LiteTxnLimits> {
  return liteTxnLimitsFrom(
    await readAuthenticationMethodsDocument(env, tenantId),
    env as unknown as Record<string, unknown>
  );
}

export async function readLitePowSettings(env: Env, tenantId: string): Promise<LitePowSettings> {
  let document: Record<string, unknown> | null = null;
  try {
    const raw = await env.SETTINGS?.get(humanVerificationSettingsKey(tenantId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    document =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    document = null;
  }
  return litePowSettingsFrom(document, env as unknown as Record<string, unknown>);
}

/** The ChallengeStore call that records a spent proof (claimed only once while it lasts). */
interface UsedProofStore {
  claimChallengeRpc(request: {
    id: string;
    tenantId: string;
    type: 'lite_pow_used';
    userId: string;
    challenge: string;
    ttl: number;
  }): Promise<{ claimed: boolean }>;
}

interface LiteVerificationInput {
  tenantId: string;
  action: HumanVerificationFlow;
  alsoRequiredFor?: readonly HumanVerificationFlow[];
  responseToken: unknown;
  snapshot: LitePolicySnapshot;
}

/** Verifies (and spends) the proof of work of a request to a tenant in lite mode. */
export async function verifyLiteHumanVerification(
  env: Env,
  input: LiteVerificationInput
): Promise<{ required: boolean; verified: boolean }> {
  const flows = [input.action, ...(input.alsoRequiredFor ?? [])];
  const required = flows.some((flow) => input.snapshot.humanVerificationRequired[flow]);
  if (!required) return { required: false, verified: true };

  let keyring;
  try {
    keyring = loadPowKeyringFromEnv(env);
  } catch {
    keyring = null;
  }
  if (!keyring) return { required: true, verified: false };
  const settings = await readLitePowSettings(env, input.tenantId);
  const result = await verifyPowSolution(keyring, input.responseToken, {
    tenantId: input.tenantId,
    action: input.action,
    policyRevision: input.snapshot.policyRevision,
    maxNumber: settings.maxNumber,
  });
  if (!result.ok) return { required: true, verified: false };

  const ttl = Math.max(1, result.expiresAt - Math.floor(Date.now() / 1000));
  try {
    const store = getChallengeStoreForLease(env, result.usedId, input.tenantId) as UsedProofStore;
    const { claimed } = await store.claimChallengeRpc({
      id: result.usedId,
      tenantId: input.tenantId,
      type: 'lite_pow_used',
      userId: 'lite-pow',
      challenge: 'spent',
      ttl,
    });
    return { required: true, verified: claimed };
  } catch {
    // A proof whose use cannot be recorded could be spent twice: refuse it.
    return { required: true, verified: false };
  }
}
