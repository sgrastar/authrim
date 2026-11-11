/**
 * How a registration Flow signs people up: who may, what happens to an address already
 * registered, how the address is checked, and where the person goes once signed up.
 *
 * It is kept with the Flow, in the config of its registration step (the `registration` node,
 * runtime component `registration_method_selector`) as `registration_policy`, so each sign-up
 * Flow can have its own. A sign-up route reads it from the interaction it is told about; one
 * that names no interaction (an app with its own form) has no policy and keeps the tenant's
 * behaviour as it always was (`LEGACY_REGISTRATION_POLICY`).
 */

/** What a sign-up for an address that already has an account does. */
export type RegistrationDuplicateMode =
  /** Refused: the person is told the address is registered (it reveals that it is). */
  | 'reject'
  /** The person is led to sign in instead (an email code becomes a sign-in code). */
  | 'login'
  /**
   * The same answer as a new address, so nothing tells others whether it is registered; the
   * address's owner is told by email instead, and no account or code comes of it.
   */
  | 'mail';
export const REGISTRATION_DUPLICATE_MODES: readonly RegistrationDuplicateMode[] = [
  'reject',
  'login',
  'mail',
];

/** Who may sign up through the Flow. */
export type RegistrationEligibility =
  | 'open'
  /** Only with an invitation (a valid `invite_token`). */
  | 'invite'
  /** Only with an address in one of `allowed_domains`. */
  | 'domain';
export const REGISTRATION_ELIGIBILITIES: readonly RegistrationEligibility[] = [
  'open',
  'invite',
  'domain',
];

/** What a refused sign-up is told. */
export type RegistrationDeniedResponse =
  /** One reason for every refusal (`signup_not_allowed`): nothing about the address. */
  | 'generic'
  /** The reason (`invitation_required`, `email_domain_not_allowed`, `account_exists`). */
  | 'reason';
export const REGISTRATION_DENIED_RESPONSES: readonly RegistrationDeniedResponse[] = [
  'generic',
  'reason',
];

/** When the address of a sign-up by another method than an email code is checked. */
export type RegistrationEmailCheck =
  /** Before the account is made: a sign-up whose address is not proven is not taken. */
  | 'before'
  /** After: the account is made with the address unverified, to be checked later. */
  | 'later'
  /** Not checked. */
  | 'none';
export const REGISTRATION_EMAIL_CHECKS: readonly RegistrationEmailCheck[] = [
  'before',
  'later',
  'none',
];

/** When a sign-up through an external provider has its address checked by email too. */
export type RegistrationExternalEmailCheck =
  /** The provider gave no address. */
  | 'no_email'
  /** The provider did not say the address is verified. */
  | 'unverified'
  /** The provider is not one whose addresses the tenant trusts (its `trust_email` is off). */
  | 'low_trust';
export const REGISTRATION_EXTERNAL_EMAIL_CHECKS: readonly RegistrationExternalEmailCheck[] = [
  'no_email',
  'unverified',
  'low_trust',
];

/** How long an email code sent for a sign-up can be used, in seconds. */
export const REGISTRATION_CODE_TTL_SECONDS: readonly number[] = [300, 600, 900];

/** Where the person goes once signed up through the Flow (its own, not the tenant's sign-in). */
export type RegistrationCompletionBehavior =
  | 'account'
  | 'home'
  | 'custom_url'
  | 'app_login'
  | 'saml_login'
  | 'service_site';
export const REGISTRATION_COMPLETION_BEHAVIORS: readonly RegistrationCompletionBehavior[] = [
  'account',
  'home',
  'custom_url',
  'app_login',
  'saml_login',
  'service_site',
];

export interface RegistrationCompletion {
  behavior: RegistrationCompletionBehavior;
  /** `custom_url`: a non-reserved relative path or a trusted HTTPS URL. */
  redirect_url?: string;
  /** `app_login`: the OIDC client and how it is started. */
  app_login_client_id?: string;
  app_login_redirect_uri?: string;
  app_login_scope?: string;
  app_login_final_return_to?: string;
  /** `saml_login`: the SAML service provider and an optional RelayState. */
  saml_login_sp_entity_id?: string;
  saml_login_relay_state?: string;
  /** `service_site`: a path on this site served by the attached service Worker. */
  service_site_path?: string;
}

export interface RegistrationPolicy {
  duplicate: RegistrationDuplicateMode;
  eligibility: RegistrationEligibility;
  /** `domain`: the address domains that may sign up (lower case, no `@`). */
  allowed_domains: string[];
  denied_response: RegistrationDeniedResponse;
  email_check: RegistrationEmailCheck;
  external_email_check: RegistrationExternalEmailCheck[];
  /** Null: the tenant's own email code lifetime (`credentials.email_code_ttl`). */
  code_ttl_seconds: number | null;
  /** Null: the tenant's post-sign-in destination (`login-entry.post_login_*`). */
  completion: RegistrationCompletion | null;
}

/** A new sign-up Flow's policy: the safer choice of each. */
export const DEFAULT_REGISTRATION_POLICY: RegistrationPolicy = {
  duplicate: 'mail',
  eligibility: 'open',
  allowed_domains: [],
  denied_response: 'generic',
  email_check: 'before',
  external_email_check: ['no_email', 'unverified'],
  code_ttl_seconds: 300,
  completion: { behavior: 'account' },
};

/**
 * What a sign-up with no Flow policy does: the tenant's behaviour before there were policies (an
 * email code to a registered address signs in, a passkey for one is refused; the address is not
 * checked before the account is made; the tenant's code lifetime and post-sign-in destination).
 */
export const LEGACY_REGISTRATION_POLICY: RegistrationPolicy = {
  duplicate: 'login',
  eligibility: 'open',
  allowed_domains: [],
  denied_response: 'reason',
  email_check: 'later',
  external_email_check: [],
  code_ttl_seconds: null,
  completion: null,
};

/** The most domains a policy may list. */
export const MAX_REGISTRATION_ALLOWED_DOMAINS = 100;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** An address domain as a policy lists it: lower case, no `@`, a host name with a dot. */
export function normalizeRegistrationDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase().replace(/^@/u, '');
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

/** Whether an address's domain is one of those listed (exactly, not a sub-domain). */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return allowedDomains.includes(domain);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

export type RegistrationPolicyRead =
  | { ok: true; policy: RegistrationPolicy }
  | { ok: false; field: string; reason: string };

/** A stored completion, or why it is not one. */
function readCompletion(
  value: unknown
): { ok: true; completion: RegistrationCompletion | null } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: true, completion: null };
  if (!isRecord(value)) return { ok: false, reason: 'must be an object' };
  const behavior = oneOf(value.behavior, REGISTRATION_COMPLETION_BEHAVIORS);
  if (!behavior) {
    return {
      ok: false,
      reason: `behavior must be one of ${REGISTRATION_COMPLETION_BEHAVIORS.join(', ')}`,
    };
  }
  const completion: RegistrationCompletion = { behavior };
  const take = (key: keyof RegistrationCompletion, max: number) => {
    const read = text(value[key], max);
    if (read !== undefined) (completion as unknown as Record<string, string>)[key] = read;
  };
  switch (behavior) {
    case 'custom_url':
      take('redirect_url', 2048);
      if (!completion.redirect_url) return { ok: false, reason: 'redirect_url is required' };
      break;
    case 'app_login':
      take('app_login_client_id', 256);
      take('app_login_redirect_uri', 2048);
      take('app_login_scope', 512);
      take('app_login_final_return_to', 2048);
      if (!completion.app_login_client_id || !completion.app_login_redirect_uri) {
        return { ok: false, reason: 'app_login_client_id and app_login_redirect_uri are required' };
      }
      break;
    case 'saml_login':
      take('saml_login_sp_entity_id', 1024);
      if (typeof value.saml_login_relay_state === 'string' && value.saml_login_relay_state) {
        completion.saml_login_relay_state = value.saml_login_relay_state;
      }
      if (!completion.saml_login_sp_entity_id) {
        return { ok: false, reason: 'saml_login_sp_entity_id is required' };
      }
      break;
    case 'service_site':
      take('service_site_path', 512);
      if (!completion.service_site_path) {
        return { ok: false, reason: 'service_site_path is required' };
      }
      break;
    default:
      break;
  }
  return { ok: true, completion };
}

/**
 * A stored policy, every field checked. `strict` (saving, publishing): a value that is not one
 * of its own is refused; otherwise (reading a published Flow) it falls back to the default of
 * that field, so a sign-up never runs on half a policy.
 */
export function readRegistrationPolicy(value: unknown, strict = false): RegistrationPolicyRead {
  const raw = isRecord(value) ? value : {};
  if (strict && value !== undefined && value !== null && !isRecord(value)) {
    return { ok: false, field: 'registration_policy', reason: 'must be an object' };
  }
  const fallback = DEFAULT_REGISTRATION_POLICY;
  const pick = <T extends string>(
    key: string,
    allowed: readonly T[],
    otherwise: T
  ): { value: T; error?: undefined } | { error: string } => {
    const read = oneOf(raw[key], allowed);
    if (read === undefined && strict && raw[key] !== undefined) {
      return { error: `${key} must be one of ${allowed.join(', ')}` };
    }
    return { value: read ?? otherwise };
  };

  const duplicate = pick('duplicate', REGISTRATION_DUPLICATE_MODES, fallback.duplicate);
  if (duplicate.error !== undefined)
    return { ok: false, field: 'duplicate', reason: duplicate.error };
  const eligibility = pick('eligibility', REGISTRATION_ELIGIBILITIES, fallback.eligibility);
  if (eligibility.error !== undefined)
    return { ok: false, field: 'eligibility', reason: eligibility.error };
  const denied = pick('denied_response', REGISTRATION_DENIED_RESPONSES, fallback.denied_response);
  if (denied.error !== undefined)
    return { ok: false, field: 'denied_response', reason: denied.error };
  const emailCheck = pick('email_check', REGISTRATION_EMAIL_CHECKS, fallback.email_check);
  if (emailCheck.error !== undefined)
    return { ok: false, field: 'email_check', reason: emailCheck.error };

  const rawDomains = raw.allowed_domains;
  const domains: string[] = [];
  if (rawDomains !== undefined) {
    if (!Array.isArray(rawDomains) || rawDomains.length > MAX_REGISTRATION_ALLOWED_DOMAINS) {
      if (strict) {
        return {
          ok: false,
          field: 'allowed_domains',
          reason: `must be a list of at most ${MAX_REGISTRATION_ALLOWED_DOMAINS} domains`,
        };
      }
    } else {
      for (const entry of rawDomains) {
        const domain = normalizeRegistrationDomain(entry);
        if (!domain) {
          if (strict) {
            return { ok: false, field: 'allowed_domains', reason: 'each must be a domain name' };
          }
          continue;
        }
        if (!domains.includes(domain)) domains.push(domain);
      }
    }
  }
  if (eligibility.value === 'domain' && domains.length === 0 && strict) {
    return { ok: false, field: 'allowed_domains', reason: 'list at least one domain' };
  }

  const rawExternal = raw.external_email_check;
  let external = [...fallback.external_email_check];
  if (rawExternal !== undefined) {
    if (!Array.isArray(rawExternal)) {
      if (strict) return { ok: false, field: 'external_email_check', reason: 'must be a list' };
    } else {
      const read = rawExternal.flatMap((entry) => {
        const check = oneOf(entry, REGISTRATION_EXTERNAL_EMAIL_CHECKS);
        return check ? [check] : [];
      });
      if (strict && read.length !== rawExternal.length) {
        return {
          ok: false,
          field: 'external_email_check',
          reason: `each must be one of ${REGISTRATION_EXTERNAL_EMAIL_CHECKS.join(', ')}`,
        };
      }
      external = [...new Set(read)];
    }
  }

  let ttl: number | null = fallback.code_ttl_seconds;
  if (raw.code_ttl_seconds === null) ttl = null;
  else if (raw.code_ttl_seconds !== undefined) {
    if (REGISTRATION_CODE_TTL_SECONDS.includes(raw.code_ttl_seconds as number)) {
      ttl = raw.code_ttl_seconds as number;
    } else if (strict) {
      return {
        ok: false,
        field: 'code_ttl_seconds',
        reason: `must be one of ${REGISTRATION_CODE_TTL_SECONDS.join(', ')}`,
      };
    }
  }

  let completion: RegistrationCompletion | null = fallback.completion;
  if (raw.completion !== undefined) {
    const read = readCompletion(raw.completion);
    if (!read.ok) {
      if (strict) return { ok: false, field: 'completion', reason: read.reason };
    } else {
      completion = read.completion;
    }
  }

  return {
    ok: true,
    policy: {
      duplicate: duplicate.value,
      eligibility: eligibility.value,
      allowed_domains: eligibility.value === 'domain' ? domains : [],
      denied_response: denied.value,
      email_check: emailCheck.value,
      external_email_check: external,
      code_ttl_seconds: ttl,
      completion,
    },
  };
}

/** The runtime component of the step that holds a registration Flow's policy. */
export const REGISTRATION_POLICY_COMPONENT = 'registration_method_selector';

/**
 * The policy of a published registration Flow (its runtime contract): the config of its first
 * registration step. A Flow whose step has none (published before there were policies) keeps
 * the tenant's behaviour as it was.
 */
export function registrationPolicyOfRuntime(runtime: unknown): RegistrationPolicy {
  const steps = isRecord(runtime) && isRecord(runtime.ui) ? runtime.ui.steps : undefined;
  if (!Array.isArray(steps)) return LEGACY_REGISTRATION_POLICY;
  const step = steps.find(
    (candidate) => isRecord(candidate) && candidate.component === REGISTRATION_POLICY_COMPONENT
  ) as Record<string, unknown> | undefined;
  const config = step && isRecord(step.config) ? step.config : null;
  if (!config || config.registration_policy === undefined) return LEGACY_REGISTRATION_POLICY;
  const read = readRegistrationPolicy(config.registration_policy);
  return read.ok ? read.policy : LEGACY_REGISTRATION_POLICY;
}

/**
 * The authentication method profile a published registration Flow signs people up with (its
 * registration step's `authentication_profile_ref`): `default` when it names none, the tenant's
 * own methods then.
 */
export function registrationProfileRefOfRuntime(runtime: unknown): string {
  const steps = isRecord(runtime) && isRecord(runtime.ui) ? runtime.ui.steps : undefined;
  if (!Array.isArray(steps)) return 'default';
  const step = steps.find(
    (candidate) => isRecord(candidate) && candidate.component === REGISTRATION_POLICY_COMPONENT
  ) as Record<string, unknown> | undefined;
  const ref = step && isRecord(step.config) ? step.config.authentication_profile_ref : undefined;
  return typeof ref === 'string' && ref.trim() && ref.length <= 200 ? ref.trim() : 'default';
}
