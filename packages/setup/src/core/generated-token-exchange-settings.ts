import {
  addFail,
  addPass,
  addWarn,
  fetchJsonWithTimeout,
  finalizeCheck,
  isRecord,
  makeSmokeCheck,
  withTenantHeader,
  type SmokeCheck,
} from './generated-smoke-common.js';

const TOKEN_EXCHANGE_SETTINGS_PATH = '/api/admin/settings/token-exchange';
const SETTINGS_PROPAGATION_DELAY_MS = 3_000;
const SETTINGS_REQUEST_MAX_ATTEMPTS = 4;

interface TokenExchangeSettingsSnapshot {
  enabled: boolean;
  allowedSubjectTokenTypes: string[];
  maxResourceParams: number;
  maxAudienceParams: number;
  idJag?: {
    enabled: boolean;
    allowedIssuers: string[];
    maxTokenLifetime: number;
    includeTenantClaim: boolean;
    requireConfidentialClient: boolean;
  };
  hasKvOverride: boolean;
}

export interface GeneratedTokenExchangeEnableResult {
  check: SmokeCheck;
  restore: () => Promise<SmokeCheck | null>;
}

function asBooleanSetting(settings: Record<string, unknown>, key: string): boolean | null {
  const item = isRecord(settings[key]) ? settings[key] : null;
  return typeof item?.value === 'boolean' ? item.value : null;
}

function asNumberSetting(settings: Record<string, unknown>, key: string): number | null {
  const item = isRecord(settings[key]) ? settings[key] : null;
  return typeof item?.value === 'number' ? item.value : null;
}

function asStringArraySetting(settings: Record<string, unknown>, key: string): string[] | null {
  const item = isRecord(settings[key]) ? settings[key] : null;
  return Array.isArray(item?.value)
    ? item.value.filter((value): value is string => typeof value === 'string')
    : null;
}

function hasKvSource(settings: Record<string, unknown>): boolean {
  return Object.values(settings).some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    if (item.source === 'kv') {
      return true;
    }
    return isRecord(item.value) && hasKvSource(item.value);
  });
}

function readSnapshot(payload: unknown): TokenExchangeSettingsSnapshot | null {
  if (!isRecord(payload) || !isRecord(payload.settings)) {
    return null;
  }

  const settings = payload.settings;
  const idJag = isRecord(settings.idJag) ? settings.idJag : null;
  const idJagSnapshot = idJag
    ? {
        enabled: asBooleanSetting(idJag, 'enabled') ?? false,
        allowedIssuers: asStringArraySetting(idJag, 'allowedIssuers') ?? [],
        maxTokenLifetime: asNumberSetting(idJag, 'maxTokenLifetime') ?? 3600,
        includeTenantClaim: asBooleanSetting(idJag, 'includeTenantClaim') ?? true,
        requireConfidentialClient: asBooleanSetting(idJag, 'requireConfidentialClient') ?? true,
      }
    : undefined;

  return {
    enabled: asBooleanSetting(settings, 'enabled') ?? false,
    allowedSubjectTokenTypes: asStringArraySetting(settings, 'allowedSubjectTokenTypes') ?? [
      'access_token',
    ],
    maxResourceParams: asNumberSetting(settings, 'maxResourceParams') ?? 10,
    maxAudienceParams: asNumberSetting(settings, 'maxAudienceParams') ?? 10,
    idJag: idJagSnapshot,
    hasKvOverride: hasKvSource(settings),
  };
}

function buildAdminHeaders(adminSecret: string, tenantId: string): Record<string, string> {
  return withTenantHeader(
    {
      authorization: `Bearer ${adminSecret}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    tenantId
  );
}

function buildSnapshotBody(snapshot: TokenExchangeSettingsSnapshot): Record<string, unknown> {
  return {
    enabled: snapshot.enabled,
    allowedSubjectTokenTypes: snapshot.allowedSubjectTokenTypes,
    maxResourceParams: snapshot.maxResourceParams,
    maxAudienceParams: snapshot.maxAudienceParams,
    ...(snapshot.idJag ? { idJag: snapshot.idJag } : {}),
  };
}

function buildEnabledBody(snapshot: TokenExchangeSettingsSnapshot): Record<string, unknown> {
  const allowedSubjectTokenTypes = snapshot.allowedSubjectTokenTypes.includes('access_token')
    ? snapshot.allowedSubjectTokenTypes
    : [...snapshot.allowedSubjectTokenTypes, 'access_token'];
  return {
    ...buildSnapshotBody(snapshot),
    enabled: true,
    allowedSubjectTokenTypes,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryAfterSeconds(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.retry_after === 'number' && payload.retry_after > 0
    ? payload.retry_after
    : null;
}

async function fetchSettingsWithRetryAfter(
  url: string,
  timeoutMs: number,
  init: globalThis.RequestInit
) {
  let response = await fetchJsonWithTimeout(url, timeoutMs, init);
  let attempt = 1;
  while (response.status === 429 && attempt < SETTINGS_REQUEST_MAX_ATTEMPTS) {
    const retryAfterSeconds = extractRetryAfterSeconds(response.payload);
    if (!retryAfterSeconds) {
      break;
    }
    await sleep(retryAfterSeconds * 1000 + 1000);
    response = await fetchJsonWithTimeout(url, timeoutMs, init);
    attempt += 1;
  }
  return response;
}

export async function ensureGeneratedTokenExchangeEnabled(input: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  checkId: string;
  title: string;
}): Promise<GeneratedTokenExchangeEnableResult> {
  const check = makeSmokeCheck(
    input.checkId,
    input.title,
    `${input.baseUrl}${TOKEN_EXCHANGE_SETTINGS_PATH}`
  );
  const headers = buildAdminHeaders(input.adminSecret, input.tenantId);
  const getResponse = await fetchSettingsWithRetryAfter(
    `${input.baseUrl}${TOKEN_EXCHANGE_SETTINGS_PATH}`,
    input.timeoutMs,
    { headers }
  );
  check.httpStatus = getResponse.status;

  if (!getResponse.ok) {
    addFail(
      check,
      `GET ${TOKEN_EXCHANGE_SETTINGS_PATH} failed: ${getResponse.status} ${getResponse.error ?? getResponse.bodyText ?? ''}`
    );
    return {
      check: finalizeCheck(check, 'Token Exchange settings read failed'),
      restore: async () => null,
    };
  }

  const snapshot = readSnapshot(getResponse.payload);
  if (!snapshot) {
    addFail(check, 'Token Exchange settings payload could not be parsed');
    return {
      check: finalizeCheck(check, 'Token Exchange settings payload invalid'),
      restore: async () => null,
    };
  }

  if (snapshot.enabled && snapshot.allowedSubjectTokenTypes.includes('access_token')) {
    addPass(check, 'Token Exchange is already enabled for access_token');
    return {
      check: finalizeCheck(check, 'Token Exchange already enabled'),
      restore: async () => null,
    };
  }

  const putResponse = await fetchSettingsWithRetryAfter(
    `${input.baseUrl}${TOKEN_EXCHANGE_SETTINGS_PATH}`,
    input.timeoutMs,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(buildEnabledBody(snapshot)),
    }
  );
  check.httpStatus = putResponse.status;
  if (!putResponse.ok) {
    addFail(
      check,
      `PUT ${TOKEN_EXCHANGE_SETTINGS_PATH} failed: ${putResponse.status} ${putResponse.error ?? putResponse.bodyText ?? ''}`
    );
    return {
      check: finalizeCheck(check, 'Token Exchange enable failed'),
      restore: async () => null,
    };
  }

  addPass(check, 'Token Exchange enabled for generated approval test');
  addWarn(
    check,
    `waiting ${SETTINGS_PROPAGATION_DELAY_MS}ms for SETTINGS KV propagation before token endpoint use`
  );
  await sleep(SETTINGS_PROPAGATION_DELAY_MS);

  return {
    check: finalizeCheck(check, 'Token Exchange enabled'),
    restore: async () => {
      const restoreCheck = makeSmokeCheck(
        `${input.checkId}-restore`,
        `${input.title} restore`,
        `${input.baseUrl}${TOKEN_EXCHANGE_SETTINGS_PATH}`
      );
      const restoreResponse = await fetchSettingsWithRetryAfter(
        `${input.baseUrl}${TOKEN_EXCHANGE_SETTINGS_PATH}`,
        input.timeoutMs,
        snapshot.hasKvOverride
          ? {
              method: 'PUT',
              headers,
              body: JSON.stringify(buildSnapshotBody(snapshot)),
            }
          : {
              method: 'DELETE',
              headers,
            }
      );
      restoreCheck.httpStatus = restoreResponse.status;
      if (restoreResponse.ok) {
        addPass(restoreCheck, 'Token Exchange settings restored');
      } else {
        addWarn(
          restoreCheck,
          `Token Exchange settings restore failed: ${restoreResponse.status} ${restoreResponse.error ?? restoreResponse.bodyText ?? ''}`
        );
      }
      return finalizeCheck(restoreCheck, 'Token Exchange settings restore completed');
    },
  };
}
