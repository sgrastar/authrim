import type { PIIStatus } from '../db/adapter';
import {
  ADDRESS_CLAIMS,
  EMAIL_CLAIMS,
  PHONE_CLAIMS,
  PROFILE_CLAIMS,
  type ClaimsTarget,
  type ParsedClaimsRequest,
} from '../utils/oidc-claims';

export const PII_STATUS_VALUES = ['none', 'pending', 'active', 'failed', 'deleted'] as const;

export const PII_REPAIRABLE_STATUSES = ['pending', 'failed'] as const;

const PII_SCOPE_NAMES = new Set(['profile', 'email', 'phone', 'address']);
const NON_PII_STANDARD_CLAIMS = new Set(['sub', 'auth_time', 'acr', 'amr', 'updated_at']);
const STANDARD_PII_CLAIMS = new Set<string>([
  ...PROFILE_CLAIMS.filter((claim) => claim !== 'updated_at'),
  ...EMAIL_CLAIMS.filter((claim) => claim !== 'email_verified'),
  ...PHONE_CLAIMS.filter((claim) => claim !== 'phone_number_verified'),
  ...ADDRESS_CLAIMS,
]);
const PREDEFINED_PII_TRANSFORMED_CLAIMS = new Set([
  '::age_over_13',
  '::age_over_18',
  '::age_over_20',
  '::email_domain',
  '::phone_country_code',
  '::address_country',
]);

export interface PIIStatusBehavior {
  status: PIIStatus;
  loginAllowed: boolean;
  nonPIITokenAllowed: boolean;
  piiReleaseAllowed: boolean;
  retryAllowed: boolean;
  terminal: boolean;
  reason: string;
}

export interface OIDCPIIRequirement {
  requiresPII: boolean;
  reasons: string[];
}

export type PIIStatusAccessResult =
  | { ok: true }
  | {
      ok: false;
      error: 'temporarily_unavailable' | 'invalid_grant' | 'invalid_token';
      error_description: string;
    };

const PII_STATUS_BEHAVIOR: Record<PIIStatus, PIIStatusBehavior> = {
  none: {
    status: 'none',
    loginAllowed: true,
    nonPIITokenAllowed: true,
    piiReleaseAllowed: false,
    retryAllowed: false,
    terminal: false,
    reason: 'No PII record is expected for this subject.',
  },
  pending: {
    status: 'pending',
    loginAllowed: true,
    nonPIITokenAllowed: true,
    piiReleaseAllowed: false,
    retryAllowed: true,
    terminal: false,
    reason: 'Core user exists but the PII write has not completed.',
  },
  active: {
    status: 'active',
    loginAllowed: true,
    nonPIITokenAllowed: true,
    piiReleaseAllowed: true,
    retryAllowed: false,
    terminal: false,
    reason: 'Core and PII records are consistent.',
  },
  failed: {
    status: 'failed',
    loginAllowed: true,
    nonPIITokenAllowed: true,
    piiReleaseAllowed: false,
    retryAllowed: true,
    terminal: false,
    reason: 'The PII write failed and must be repaired before PII claims are released.',
  },
  deleted: {
    status: 'deleted',
    loginAllowed: false,
    nonPIITokenAllowed: false,
    piiReleaseAllowed: false,
    retryAllowed: false,
    terminal: true,
    reason: 'The subject has completed deletion.',
  },
};

export function getPIIStatusBehavior(status: PIIStatus): PIIStatusBehavior {
  return PII_STATUS_BEHAVIOR[status];
}

export function canAuthenticateWithPIIStatus(status: PIIStatus): boolean {
  return getPIIStatusBehavior(status).loginAllowed;
}

export function canIssueTokenWithPIIStatus(
  status: PIIStatus,
  options: { requiresPII: boolean }
): PIIStatusAccessResult {
  const behavior = getPIIStatusBehavior(status);

  if (!behavior.nonPIITokenAllowed) {
    return {
      ok: false,
      error: 'invalid_grant',
      error_description: 'The subject is not eligible for token issuance.',
    };
  }

  if (options.requiresPII && !behavior.piiReleaseAllowed) {
    return {
      ok: false,
      error: 'temporarily_unavailable',
      error_description: 'Requested claims require PII that is not currently available.',
    };
  }

  return { ok: true };
}

export function canServeUserInfoWithPIIStatus(
  status: PIIStatus,
  options: { requiresPII: boolean }
): PIIStatusAccessResult {
  const behavior = getPIIStatusBehavior(status);

  if (behavior.terminal) {
    return {
      ok: false,
      error: 'invalid_token',
      error_description: 'The access token is invalid.',
    };
  }

  if (options.requiresPII && !behavior.piiReleaseAllowed) {
    return {
      ok: false,
      error: 'temporarily_unavailable',
      error_description: 'Requested claims require PII that is not currently available.',
    };
  }

  return { ok: true };
}

export function shouldRetryPIIWrite(status: PIIStatus): boolean {
  return getPIIStatusBehavior(status).retryAllowed;
}

export function resolveOIDCPIIRequirement(options: {
  scopes?: string[] | string | null;
  claimsRequest?: ParsedClaimsRequest;
  targets?: ClaimsTarget[];
}): OIDCPIIRequirement {
  const reasons = new Set<string>();
  const scopeValues = Array.isArray(options.scopes)
    ? options.scopes
    : (options.scopes ?? '').split(/\s+/).filter(Boolean);

  for (const scope of scopeValues) {
    if (PII_SCOPE_NAMES.has(scope)) {
      reasons.add(`scope:${scope}`);
    }
  }

  for (const target of options.targets ?? ['userinfo', 'id_token']) {
    const requestedClaims = options.claimsRequest?.[target] ?? {};
    for (const claimName of Object.keys(requestedClaims)) {
      if (isPIIClaimName(claimName)) {
        reasons.add(`claims.${target}:${claimName}`);
      }
    }

    const saoRules = options.claimsRequest?._asc?.sao?.[target] ?? [];
    for (const rule of saoRules) {
      if (isPIIJsonPointer(rule.loc)) {
        reasons.add(`claims._asc.sao.${target}:${rule.loc}`);
      }
      for (const pointer of rule.what ?? []) {
        if (isPIIJsonPointer(pointer)) {
          reasons.add(`claims._asc.sao.${target}:${pointer}`);
        }
      }
    }
  }

  return { requiresPII: reasons.size > 0, reasons: [...reasons] };
}

function isPIIClaimName(claimName: string): boolean {
  if (NON_PII_STANDARD_CLAIMS.has(claimName)) return false;
  if (STANDARD_PII_CLAIMS.has(claimName)) return true;
  if (PREDEFINED_PII_TRANSFORMED_CLAIMS.has(claimName)) return true;
  return false;
}

function isPIIJsonPointer(pointer: string): boolean {
  const firstSegment = pointer.split('/').filter(Boolean)[0];
  return firstSegment ? isPIIClaimName(firstSegment) : false;
}
