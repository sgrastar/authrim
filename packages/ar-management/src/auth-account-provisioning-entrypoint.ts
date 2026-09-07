import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  anonymousDeviceLookupSubject,
  directoryIdentityLookupSubject,
  createLogger,
  ensureDatabaseAdapter,
  isCanonicalAccountIdForUser,
  isValidPersistedUserId,
  passkeyCredentialLookupSubject,
  resolveAccountDataContext,
  resolveAuthCorePersistenceAdapterFromEnv,
  type AuthAccountProvisioningInput,
  type AuthAnonymousDeviceProvisioningInput,
  type AuthExternalIdpIdentityProvisioningInput,
  type AuthAnonymousDeviceRouteRemovalInput,
  type AuthAnonymousDeviceRouteRemovalResult,
  type AuthAccountProvisioningResult,
  type AuthAccountProvisioningStatusInput,
  type AuthAccountProvisioningStatusResult,
  type AuthPasskeyRoutePublicationInput,
  type AuthPasskeyRoutePublicationResult,
  type AuthDirectoryRoutePublicationInput,
  type AuthDirectoryRoutePublicationResult,
  type ExternalIdpRoutePublicationInput,
  type ExternalIdpRoutePublicationResult,
  type ExternalIdpRouteRemovalInput,
  type ExternalIdpRouteRemovalResult,
  type ExternalIdpRouteRemovalStatusInput,
  type ExternalIdpPiiSourceShard,
  type ExternalIdpPiiSourceShardListInput,
  type Env,
} from '@authrim/ar-lib-core';
import {
  AccountCreationOperationRepository,
  hashAccountCreationRequest,
} from './account-creation-operation';
import { writeCanonicalAccountAuthoritative } from './account-authoritative-write';
import { executeDurableInitialAccountDirectoryWrite } from './account-directory-producer';
import type { AccountDirectoryRpcProps } from './account-directory-entrypoint';
import {
  publishAccountExternalSubjectAddition,
  publishAccountExternalSubjectRemoval,
} from './account-identifier-addition';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_FIELD = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^auth-account:[a-f0-9]{64}$/u;
const PASSKEY_ROUTE_IDEMPOTENCY_KEY = /^auth-passkey-route:[a-f0-9]{64}$/u;
const DIRECTORY_ROUTE_IDEMPOTENCY_KEY = /^auth-directory-route:[a-f0-9]{64}$/u;
const ANONYMOUS_ROUTE_REMOVAL_IDEMPOTENCY_KEY = /^auth-anonymous-route-remove:[a-f0-9]{64}$/u;
const EXTERNAL_IDP_ROUTE_IDEMPOTENCY_KEY = /^auth-external-idp-route:[a-f0-9]{64}$/u;
const EXTERNAL_IDP_ROUTE_REMOVAL_IDEMPOTENCY_KEY = /^auth-external-idp-route-remove:[a-f0-9]{64}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const FLOWS = new Set([
  'email_code',
  'passkey',
  'totp',
  'directory_password',
  'external_idp',
  'saml',
  'did',
  'test_stub',
  'anonymous',
  'anonymous_upgrade',
]);
const INPUT_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'tenantId',
  'candidateUserId',
  'flow',
  'email',
  'externalSubject',
  'anonymousDevice',
  'externalIdentity',
  'runtimeUser',
]);
const REQUIRED_INPUT_KEYS = [
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'tenantId',
  'candidateUserId',
  'flow',
  'email',
  'runtimeUser',
] as const;

const SAFE_PROVISIONING_DIAGNOSTIC =
  /^(account_[a-z0-9_]+|account_creation_[a-z0-9_]+|auth_[a-z0-9_]+|canonical_[a-z0-9_]+|d1_[a-z0-9_]+|directory_[a-z0-9_]+|external_[a-z0-9_]+|lookup_[a-z0-9_]+|tenant_[a-z0-9_]+)$/u;

function logProvisioningFailure(error: unknown): void {
  const errorCode =
    error instanceof Error && SAFE_PROVISIONING_DIAGNOSTIC.test(error.message)
      ? error.message
      : 'auth_account_provisioning_internal_error';
  createLogger().module('AUTH-ACCOUNT-PROVISIONING').error('Account provisioning failed', {
    errorCode,
  });
}
const ANONYMOUS_DEVICE_KEYS = new Set([
  'id',
  'deviceIdHash',
  'installationIdHash',
  'fingerprintHash',
  'platform',
  'stability',
  'expiresInDays',
]);
const EXTERNAL_IDENTITY_KEYS = new Set([
  'id',
  'providerId',
  'providerUserId',
  'providerEmail',
  'emailVerified',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'tokenExpiresAt',
  'rawClaimsJson',
  'profileDataEncrypted',
]);
const RUNTIME_USER_KEYS = new Set([
  'active',
  'emailVerified',
  'phoneNumberVerified',
  'userType',
  'displayName',
  'locale',
  'zoneinfo',
  'sourceRef',
  'externalId',
  'passwordHash',
  'piiFields',
  'sensitiveValues',
  'inlineProfileFields',
  'addressJson',
  'customAttributesJson',
]);
const STATUS_INPUT_KEYS = new Set(['schemaVersion', 'tenantId', 'operationId', 'flow']);
const PASSKEY_ROUTE_INPUT_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'tenantId',
  'accountId',
  'userId',
  'passkeyId',
  'credentialId',
  'rpId',
]);
const DIRECTORY_ROUTE_INPUT_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'tenantId',
  'accountId',
  'userId',
  'connectorId',
  'directorySubject',
]);
const ANONYMOUS_ROUTE_REMOVAL_INPUT_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'tenantId',
  'accountId',
  'userId',
  'deviceId',
  'deviceIdHash',
]);
const EXTERNAL_IDP_ROUTE_INPUT_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'tenantId',
  'accountId',
  'userId',
  'linkedIdentityId',
  'providerId',
  'providerUserId',
]);
const EXTERNAL_IDP_ROUTE_REMOVAL_STATUS_KEYS = new Set([
  'schemaVersion',
  'tenantId',
  'accountId',
  'userId',
  'operationId',
]);
const EXTERNAL_IDP_PII_SOURCE_LIST_KEYS = new Set(['schemaVersion', 'afterShardId', 'limit']);
const SENSITIVE_FIELDS = new Set([
  'email',
  'phone_number',
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'address_formatted',
  'address_street_address',
  'address_locality',
  'address_region',
  'address_postal_code',
  'address_country',
  'address_json',
  'custom_attributes_json',
]);

export interface AuthAccountProvisioningRpcProps {
  caller: 'ar-auth';
  environmentId: string;
  audience: 'authrim-auth-account-provisioning-v1';
}

export interface ExternalIdpAccountProvisioningRpcProps {
  caller: 'ar-bridge';
  environmentId: string;
  audience: 'authrim-external-idp-account-provisioning-v1';
}

export interface SamlAccountProvisioningRpcProps {
  caller: 'ar-saml';
  environmentId: string;
  audience: 'authrim-saml-account-provisioning-v1';
}

interface ManagementInternalExports {
  AccountDirectoryEntrypoint(options: {
    props: AccountDirectoryRpcProps;
  }): NonNullable<Env['ACCOUNT_DIRECTORY']>;
}

function authorized(
  props:
    | AuthAccountProvisioningRpcProps
    | ExternalIdpAccountProvisioningRpcProps
    | SamlAccountProvisioningRpcProps,
  env: Env
): string {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !(
      (props?.caller === 'ar-auth' && props.audience === 'authrim-auth-account-provisioning-v1') ||
      (props?.caller === 'ar-saml' && props.audience === 'authrim-saml-account-provisioning-v1')
    ) ||
    typeof environmentId !== 'string' ||
    !SAFE_ID.test(environmentId) ||
    props.environmentId !== environmentId
  ) {
    throw new Error('auth_account_provisioning_rpc_caller_unauthorized');
  }
  return environmentId;
}

function authorizedExternalIdp(
  props:
    | AuthAccountProvisioningRpcProps
    | ExternalIdpAccountProvisioningRpcProps
    | SamlAccountProvisioningRpcProps,
  env: Env
): string {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !(
      (props?.caller === 'ar-bridge' &&
        props.audience === 'authrim-external-idp-account-provisioning-v1') ||
      (props?.caller === 'ar-saml' && props.audience === 'authrim-saml-account-provisioning-v1')
    ) ||
    typeof environmentId !== 'string' ||
    !SAFE_ID.test(environmentId) ||
    props.environmentId !== environmentId
  ) {
    throw new Error('external_idp_account_provisioning_rpc_caller_unauthorized');
  }
  return environmentId;
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedJson(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('auth_account_provisioning_input_invalid');
  }
  if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
    throw new Error('auth_account_provisioning_input_too_large');
  }
}

function validateExternalIdpPiiSourceShardListInput(
  value: unknown
): ExternalIdpPiiSourceShardListInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== EXTERNAL_IDP_PII_SOURCE_LIST_KEYS.size ||
    Object.keys(value).some((key) => !EXTERNAL_IDP_PII_SOURCE_LIST_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    (value.afterShardId !== null &&
      (typeof value.afterShardId !== 'string' || !SAFE_FIELD.test(value.afterShardId))) ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  ) {
    throw new Error('external_idp_pii_source_list_input_invalid');
  }
  return value as unknown as ExternalIdpPiiSourceShardListInput;
}

function validateExternalIdpPiiSourceShards(value: unknown): ExternalIdpPiiSourceShard[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('external_idp_pii_source_list_response_invalid');
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (
      !jsonObject(candidate) ||
      Object.keys(candidate).length !== 5 ||
      candidate.dataRole !== 'tenant_pii' ||
      typeof candidate.shardId !== 'string' ||
      !SAFE_FIELD.test(candidate.shardId) ||
      seen.has(candidate.shardId) ||
      typeof candidate.bindingRef !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(candidate.bindingRef) ||
      typeof candidate.residencyPartition !== 'string' ||
      !SAFE_FIELD.test(candidate.residencyPartition) ||
      !Number.isSafeInteger(candidate.routeGeneration) ||
      (candidate.routeGeneration as number) < 1
    ) {
      throw new Error('external_idp_pii_source_list_response_invalid');
    }
    seen.add(candidate.shardId);
    return {
      shardId: candidate.shardId,
      bindingRef: candidate.bindingRef,
      residencyPartition: candidate.residencyPartition,
      routeGeneration: candidate.routeGeneration as number,
    };
  });
}

function encodedJsonObject(value: unknown, maximumLength: number): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || value.length > maximumLength) return false;
  try {
    return jsonObject(JSON.parse(value));
  } catch {
    return false;
  }
}

function optionalString(value: unknown, maximumLength: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= maximumLength)
  );
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((item) => jsonValue(item, depth + 1));
  }
  if (!jsonObject(value) || Object.keys(value).length > 256) return false;
  return Object.values(value).every((item) => jsonValue(item, depth + 1));
}

function validateInput(value: unknown): AuthAccountProvisioningInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).some((key) => !INPUT_KEYS.has(key)) ||
    REQUIRED_INPUT_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isValidPersistedUserId(value.candidateUserId) ||
    typeof value.flow !== 'string' ||
    !FLOWS.has(value.flow) ||
    (value.email !== null && typeof value.email !== 'string') ||
    !jsonObject(value.runtimeUser) ||
    Object.keys(value.runtimeUser).some((key) => !RUNTIME_USER_KEYS.has(key))
  ) {
    throw new Error('auth_account_provisioning_input_invalid');
  }

  const runtimeUser = value.runtimeUser;
  const piiFields = runtimeUser.piiFields;
  const sensitiveValues = runtimeUser.sensitiveValues;
  const piiEntries = jsonObject(piiFields) ? Object.entries(piiFields) : [];
  const sensitiveEntries = jsonObject(sensitiveValues) ? Object.entries(sensitiveValues) : [];
  const inlineProfileFields = runtimeUser.inlineProfileFields;
  const inlineEntries = jsonObject(inlineProfileFields) ? Object.entries(inlineProfileFields) : [];
  const externalSubject = value.externalSubject;
  const externalSubjectValid =
    externalSubject === undefined ||
    externalSubject === null ||
    (jsonObject(externalSubject) &&
      Object.keys(externalSubject).length === 2 &&
      typeof externalSubject.issuer === 'string' &&
      externalSubject.issuer.length >= 1 &&
      externalSubject.issuer.length <= 2048 &&
      typeof externalSubject.subject === 'string' &&
      externalSubject.subject.length >= 1 &&
      externalSubject.subject.length <= 2048);
  const anonymousDevice = value.anonymousDevice;
  const anonymousDeviceValid = validateAnonymousDevice(anonymousDevice);
  const externalIdentity = value.externalIdentity;
  const externalIdentityValid = validateExternalIdentity(externalIdentity);
  const anonymousFlowValid =
    value.flow === 'anonymous'
      ? value.email === null &&
        jsonObject(externalSubject) &&
        anonymousDeviceValid &&
        externalSubject.issuer ===
          anonymousDeviceLookupSubject(anonymousDevice.deviceIdHash).issuer &&
        externalSubject.subject === anonymousDevice.deviceIdHash &&
        runtimeUser.sourceRef === 'auth:anonymous' &&
        runtimeUser.userType === 'anonymous' &&
        jsonObject(piiFields) &&
        piiEntries.length === 0 &&
        jsonObject(sensitiveValues) &&
        sensitiveEntries.length === 0
      : true;
  const emailAccountFlowValid =
    value.flow !== 'passkey' || value.email !== null
      ? typeof value.email === 'string' &&
        value.email.length <= 320 &&
        value.email === value.email.trim().toLowerCase() &&
        EMAIL.test(value.email) &&
        runtimeUser.sourceRef === `auth:${value.flow}` &&
        jsonObject(piiFields) &&
        piiFields.email === true &&
        jsonObject(sensitiveValues) &&
        sensitiveValues.email === value.email &&
        (anonymousDevice === undefined || anonymousDevice === null)
      : false;
  const emailLessPasskeyFlowValid =
    value.flow === 'passkey' &&
    value.email === null &&
    runtimeUser.sourceRef === 'auth:passkey' &&
    jsonObject(piiFields) &&
    piiFields.email !== true &&
    jsonObject(sensitiveValues) &&
    !Object.hasOwn(sensitiveValues, 'email') &&
    (anonymousDevice === undefined || anonymousDevice === null);
  const externalIdpFlowValid =
    value.flow === 'external_idp'
      ? jsonObject(externalSubject) &&
        externalIdentityValid &&
        externalSubject.issuer === externalIdentity.providerId &&
        externalSubject.subject === externalIdentity.providerUserId
      : externalIdentity === undefined || externalIdentity === null;
  if (
    runtimeUser.active !== true ||
    !externalSubjectValid ||
    !anonymousFlowValid ||
    !(value.flow === 'anonymous' || emailAccountFlowValid || emailLessPasskeyFlowValid) ||
    !externalIdpFlowValid ||
    piiEntries.length > 32 ||
    piiEntries.some(
      ([key, enabled]) => !SENSITIVE_FIELDS.has(key) || typeof enabled !== 'boolean'
    ) ||
    sensitiveEntries.length > 32 ||
    sensitiveEntries.some(
      ([key, fieldValue]) => !SENSITIVE_FIELDS.has(key) || !jsonValue(fieldValue)
    ) ||
    (inlineProfileFields !== undefined && !jsonObject(inlineProfileFields)) ||
    inlineEntries.length > 64 ||
    inlineEntries.some(
      ([key, fieldValue]) =>
        !SAFE_FIELD.test(key) ||
        (fieldValue !== null &&
          typeof fieldValue !== 'string' &&
          typeof fieldValue !== 'number' &&
          typeof fieldValue !== 'boolean') ||
        (typeof fieldValue === 'number' && !Number.isFinite(fieldValue))
    ) ||
    (runtimeUser.emailVerified !== undefined && typeof runtimeUser.emailVerified !== 'boolean') ||
    (runtimeUser.phoneNumberVerified !== undefined &&
      typeof runtimeUser.phoneNumberVerified !== 'boolean') ||
    !optionalString(runtimeUser.userType, 64) ||
    !optionalString(runtimeUser.displayName, 512) ||
    !optionalString(runtimeUser.locale, 64) ||
    !optionalString(runtimeUser.zoneinfo, 128) ||
    !optionalString(runtimeUser.externalId, 1024) ||
    (runtimeUser.passwordHash !== undefined &&
      (typeof runtimeUser.passwordHash !== 'string' || runtimeUser.passwordHash.length > 4096)) ||
    !encodedJsonObject(runtimeUser.customAttributesJson, 16 * 1024) ||
    !encodedJsonObject(runtimeUser.addressJson, 16 * 1024)
  ) {
    throw new Error('auth_account_provisioning_runtime_user_invalid');
  }
  return value as unknown as AuthAccountProvisioningInput;
}

function validateExternalIdentity(
  value: unknown
): value is AuthExternalIdpIdentityProvisioningInput {
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== EXTERNAL_IDENTITY_KEYS.size ||
    Object.keys(value).some((key) => !EXTERNAL_IDENTITY_KEYS.has(key)) ||
    typeof value.id !== 'string' ||
    !SAFE_ID.test(value.id) ||
    typeof value.providerId !== 'string' ||
    !SAFE_ID.test(value.providerId) ||
    typeof value.providerUserId !== 'string' ||
    value.providerUserId.length < 1 ||
    value.providerUserId.length > 2048 ||
    (value.providerEmail !== null &&
      (typeof value.providerEmail !== 'string' ||
        value.providerEmail.length > 320 ||
        value.providerEmail !== value.providerEmail.trim().toLowerCase() ||
        !EMAIL.test(value.providerEmail))) ||
    typeof value.emailVerified !== 'boolean' ||
    typeof value.accessTokenEncrypted !== 'string' ||
    value.accessTokenEncrypted.length < 1 ||
    value.accessTokenEncrypted.length > 32 * 1024 ||
    (value.refreshTokenEncrypted !== null &&
      (typeof value.refreshTokenEncrypted !== 'string' ||
        value.refreshTokenEncrypted.length < 1 ||
        value.refreshTokenEncrypted.length > 32 * 1024)) ||
    (value.tokenExpiresAt !== null &&
      (!Number.isSafeInteger(value.tokenExpiresAt) || Number(value.tokenExpiresAt) < 0)) ||
    typeof value.rawClaimsJson !== 'string' ||
    !encodedJsonObject(value.rawClaimsJson, 32 * 1024) ||
    typeof value.profileDataEncrypted !== 'string' ||
    value.profileDataEncrypted.length < 1 ||
    value.profileDataEncrypted.length > 32 * 1024
  ) {
    return false;
  }
  return true;
}

function validateAnonymousDevice(value: unknown): value is AuthAnonymousDeviceProvisioningInput {
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== ANONYMOUS_DEVICE_KEYS.size ||
    Object.keys(value).some((key) => !ANONYMOUS_DEVICE_KEYS.has(key)) ||
    typeof value.id !== 'string' ||
    !SAFE_ID.test(value.id) ||
    typeof value.deviceIdHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.deviceIdHash) ||
    (value.installationIdHash !== null &&
      (typeof value.installationIdHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.installationIdHash))) ||
    (value.fingerprintHash !== null &&
      (typeof value.fingerprintHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.fingerprintHash))) ||
    (value.platform !== null &&
      !['ios', 'android', 'web', 'other'].includes(String(value.platform))) ||
    !['session', 'installation', 'device'].includes(String(value.stability)) ||
    (value.expiresInDays !== null &&
      (!Number.isSafeInteger(value.expiresInDays) ||
        Number(value.expiresInDays) < 1 ||
        Number(value.expiresInDays) > 3650))
  ) {
    return false;
  }
  return true;
}

function validateStatusInput(value: unknown): AuthAccountProvisioningStatusInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== STATUS_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !STATUS_INPUT_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.flow !== 'string' ||
    !FLOWS.has(value.flow)
  ) {
    throw new Error('auth_account_provisioning_status_input_invalid');
  }
  return value as unknown as AuthAccountProvisioningStatusInput;
}

function validatePasskeyRouteInput(value: unknown): AuthPasskeyRoutePublicationInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== PASSKEY_ROUTE_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !PASSKEY_ROUTE_INPUT_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== 'string' ||
    !PASSKEY_ROUTE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    typeof value.passkeyId !== 'string' ||
    !SAFE_ID.test(value.passkeyId) ||
    typeof value.credentialId !== 'string' ||
    typeof value.rpId !== 'string'
  ) {
    throw new Error('auth_passkey_route_input_invalid');
  }
  passkeyCredentialLookupSubject({ rpId: value.rpId, credentialId: value.credentialId });
  return value as unknown as AuthPasskeyRoutePublicationInput;
}

function validateDirectoryRouteInput(value: unknown): AuthDirectoryRoutePublicationInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== DIRECTORY_ROUTE_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !DIRECTORY_ROUTE_INPUT_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== 'string' ||
    !DIRECTORY_ROUTE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    typeof value.connectorId !== 'string' ||
    typeof value.directorySubject !== 'string'
  ) {
    throw new Error('auth_directory_route_input_invalid');
  }
  directoryIdentityLookupSubject({
    connectorId: value.connectorId,
    directorySubject: value.directorySubject,
  });
  return value as unknown as AuthDirectoryRoutePublicationInput;
}

function validateAnonymousRouteRemovalInput(value: unknown): AuthAnonymousDeviceRouteRemovalInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== ANONYMOUS_ROUTE_REMOVAL_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !ANONYMOUS_ROUTE_REMOVAL_INPUT_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== 'string' ||
    !ANONYMOUS_ROUTE_REMOVAL_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    typeof value.deviceId !== 'string' ||
    !SAFE_ID.test(value.deviceId) ||
    typeof value.deviceIdHash !== 'string'
  ) {
    throw new Error('auth_anonymous_route_removal_input_invalid');
  }
  anonymousDeviceLookupSubject(value.deviceIdHash);
  return value as unknown as AuthAnonymousDeviceRouteRemovalInput;
}

function validateExternalIdpRouteInput(value: unknown): ExternalIdpRoutePublicationInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== EXTERNAL_IDP_ROUTE_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !EXTERNAL_IDP_ROUTE_INPUT_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== 'string' ||
    !EXTERNAL_IDP_ROUTE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    typeof value.linkedIdentityId !== 'string' ||
    !SAFE_ID.test(value.linkedIdentityId) ||
    typeof value.providerId !== 'string' ||
    !SAFE_ID.test(value.providerId) ||
    typeof value.providerUserId !== 'string' ||
    value.providerUserId.length < 1 ||
    value.providerUserId.length > 2048
  ) {
    throw new Error('external_idp_route_input_invalid');
  }
  return value as unknown as ExternalIdpRoutePublicationInput;
}

function validateExternalIdpRouteRemovalInput(value: unknown): ExternalIdpRouteRemovalInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== EXTERNAL_IDP_ROUTE_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !EXTERNAL_IDP_ROUTE_INPUT_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== 'string' ||
    !EXTERNAL_IDP_ROUTE_REMOVAL_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    typeof value.linkedIdentityId !== 'string' ||
    !SAFE_ID.test(value.linkedIdentityId) ||
    typeof value.providerId !== 'string' ||
    !SAFE_ID.test(value.providerId) ||
    typeof value.providerUserId !== 'string' ||
    value.providerUserId.length < 1 ||
    value.providerUserId.length > 2048
  ) {
    throw new Error('external_idp_route_removal_input_invalid');
  }
  return value as unknown as ExternalIdpRouteRemovalInput;
}

function validateExternalIdpRouteRemovalStatusInput(
  value: unknown
): ExternalIdpRouteRemovalStatusInput {
  boundedJson(value);
  if (
    !jsonObject(value) ||
    Object.keys(value).length !== EXTERNAL_IDP_ROUTE_REMOVAL_STATUS_KEYS.size ||
    Object.keys(value).some((key) => !EXTERNAL_IDP_ROUTE_REMOVAL_STATUS_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId)
  ) {
    throw new Error('external_idp_route_removal_status_input_invalid');
  }
  return value as unknown as ExternalIdpRouteRemovalStatusInput;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function internalDirectoryBinding(
  context: { exports?: Partial<ManagementInternalExports> },
  environmentId: string
): NonNullable<Env['ACCOUNT_DIRECTORY']> {
  const exports = context.exports;
  if (typeof exports?.AccountDirectoryEntrypoint !== 'function') {
    throw new Error('auth_account_provisioning_directory_unavailable');
  }
  return exports.AccountDirectoryEntrypoint({
    props: {
      caller: 'ar-management',
      environmentId,
      audience: 'authrim-account-directory-v1',
    },
  });
}

async function writeAnonymousDeviceAuthority(input: {
  tenantCoreUsers: ReturnType<typeof ensureDatabaseAdapter>;
  tenantId: string;
  userId: string;
  device: AuthAnonymousDeviceProvisioningInput;
}): Promise<void> {
  const now = Date.now();
  const expiresAt =
    input.device.expiresInDays === null
      ? null
      : now + input.device.expiresInDays * 24 * 60 * 60 * 1000;
  await input.tenantCoreUsers.execute(
    `INSERT OR IGNORE INTO anonymous_devices (
       id, tenant_id, user_id, device_id_hash, installation_id_hash,
       fingerprint_hash, device_platform, device_stability,
       expires_at, created_at, last_used_at, is_active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [
      input.device.id,
      input.tenantId,
      input.userId,
      input.device.deviceIdHash,
      input.device.installationIdHash,
      input.device.fingerprintHash,
      input.device.platform,
      input.device.stability,
      expiresAt,
      now,
      now,
    ]
  );
  const reflected = await input.tenantCoreUsers.queryOne<{
    id: string;
    user_id: string;
    installation_id_hash: string | null;
    fingerprint_hash: string | null;
    device_platform: string | null;
    device_stability: string;
  }>(
    `SELECT id, user_id, installation_id_hash, fingerprint_hash,
            device_platform, device_stability
       FROM anonymous_devices
      WHERE tenant_id = ? AND device_id_hash = ? AND is_active = TRUE`,
    [input.tenantId, input.device.deviceIdHash],
    { consistencyClass: 'primary_required' }
  );
  if (
    !reflected ||
    reflected.id !== input.device.id ||
    reflected.user_id !== input.userId ||
    reflected.installation_id_hash !== input.device.installationIdHash ||
    reflected.fingerprint_hash !== input.device.fingerprintHash ||
    reflected.device_platform !== input.device.platform ||
    reflected.device_stability !== input.device.stability
  ) {
    throw new Error('auth_anonymous_device_authority_conflict');
  }
}

async function writeExternalIdentityAuthority(input: {
  tenantPii: ReturnType<typeof ensureDatabaseAdapter>;
  tenantId: string;
  userId: string;
  identity: AuthExternalIdpIdentityProvisioningInput;
}): Promise<void> {
  const now = Date.now();
  await input.tenantPii.execute(
    `INSERT OR IGNORE INTO linked_identities (
       id, tenant_id, user_id, provider_id, provider_user_id,
       provider_email, email_verified, access_token_encrypted,
       refresh_token_encrypted, token_expires_at, raw_claims,
       profile_data, linked_at, last_login_at, updated_at, provisioning_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      input.identity.id,
      input.tenantId,
      input.userId,
      input.identity.providerId,
      input.identity.providerUserId,
      input.identity.providerEmail,
      input.identity.emailVerified ? 1 : 0,
      input.identity.accessTokenEncrypted,
      input.identity.refreshTokenEncrypted,
      input.identity.tokenExpiresAt,
      input.identity.rawClaimsJson,
      input.identity.profileDataEncrypted,
      now,
      now,
      now,
    ]
  );
  const reflected = await input.tenantPii.queryOne<{
    id: string;
    user_id: string;
    provider_id: string;
    provider_user_id: string;
    provisioning_state: string;
  }>(
    `SELECT id, user_id, provider_id, provider_user_id, provisioning_state
       FROM linked_identities
      WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?`,
    [input.tenantId, input.identity.providerId, input.identity.providerUserId],
    { consistencyClass: 'primary_required' }
  );
  if (
    !reflected ||
    reflected.id !== input.identity.id ||
    reflected.user_id !== input.userId ||
    reflected.provider_id !== input.identity.providerId ||
    reflected.provider_user_id !== input.identity.providerUserId ||
    !['pending', 'active'].includes(reflected.provisioning_state)
  ) {
    throw new Error('external_idp_identity_authority_conflict');
  }
}

async function provisionValidatedAccount(
  env: Env,
  context: { exports?: Partial<ManagementInternalExports> },
  environmentId: string,
  validated: AuthAccountProvisioningInput
): Promise<AuthAccountProvisioningResult> {
  const operationAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'auth-account-provisioning-operation',
    { tenantId: validated.tenantId }
  );
  const result = await executeDurableInitialAccountDirectoryWrite(
    {
      ...env,
      ACCOUNT_DIRECTORY: internalDirectoryBinding(context, environmentId),
    },
    {
      tenantId: validated.tenantId,
      actorId: `auth:${validated.flow}`,
      idempotencyKey: validated.idempotencyKey,
      requestHash: await hashAccountCreationRequest({
        schemaVersion: validated.schemaVersion,
        tenantId: validated.tenantId,
        flow: validated.flow,
        email: validated.email,
        ...(validated.externalSubject !== undefined
          ? { externalSubject: validated.externalSubject }
          : {}),
        ...(validated.anonymousDevice !== undefined
          ? { anonymousDevice: validated.anonymousDevice }
          : {}),
        runtimeUser: validated.runtimeUser,
      }),
      candidateOperationId: validated.operationId,
      candidateUserId: validated.candidateUserId,
      email: validated.email,
      externalSubject: validated.externalSubject,
      residencyPolicyId: env.DEFAULT_RESIDENCY_PROFILE_ID ?? 'builtin:residency:default',
      residencyPartition: 'default',
    },
    {
      operationRepository: new AccountCreationOperationRepository(operationAdapter),
      writeAuthoritative: async (writeContext) => {
        await writeCanonicalAccountAuthoritative({
          publication: writeContext.publication,
          tenantCoreUsers: writeContext.tenantCoreUsers,
          tenantPii: writeContext.tenantPii,
          runtimeUser: validated.runtimeUser,
        });
        const userId = writeContext.publication.accountId.slice('account:'.length);
        if (validated.flow === 'anonymous' && validated.anonymousDevice) {
          await writeAnonymousDeviceAuthority({
            tenantCoreUsers: writeContext.tenantCoreUsers,
            tenantId: validated.tenantId,
            userId,
            device: validated.anonymousDevice,
          });
        }
        if (validated.flow === 'external_idp' && validated.externalIdentity) {
          await writeExternalIdentityAuthority({
            tenantPii: writeContext.tenantPii,
            tenantId: validated.tenantId,
            userId,
            identity: validated.externalIdentity,
          });
        }
      },
    }
  );
  return {
    status: result.delivery.status,
    operationId: result.operation.operationId,
    accountId: result.publication.accountId,
    userId: result.operation.userId,
  };
}

export class AuthAccountProvisioningEntrypoint extends WorkerEntrypoint<
  Env,
  | AuthAccountProvisioningRpcProps
  | ExternalIdpAccountProvisioningRpcProps
  | SamlAccountProvisioningRpcProps
> {
  async listExternalIdpPiiSourceShards(input: unknown): Promise<ExternalIdpPiiSourceShard[]> {
    try {
      authorizedExternalIdp(this.ctx.props, this.env);
      const validated = validateExternalIdpPiiSourceShardListInput(input);
      if (!this.env.CONTROL) throw new Error('external_idp_pii_source_list_control_unavailable');
      return validateExternalIdpPiiSourceShards(
        await this.env.CONTROL.listAccountRouteSourceShards({
          dataRole: 'tenant_pii',
          afterShardId: validated.afterShardId,
          limit: validated.limit,
        })
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /^(external_idp_(account_provisioning_rpc_caller_unauthorized|pii_source_list_(input_invalid|response_invalid|control_unavailable)))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('external_idp_pii_source_list_internal_error');
    }
  }

  async getExternalIdpRouteRemovalStatus(input: unknown): Promise<ExternalIdpRouteRemovalResult> {
    try {
      authorizedExternalIdp(this.ctx.props, this.env);
      const validated = validateExternalIdpRouteRemovalStatusInput(input);
      const context = await resolveAccountDataContext(this.env, {
        tenantId: validated.tenantId,
        accountId: validated.accountId,
      });
      if (context.accountId !== validated.accountId || context.legacyUserId !== validated.userId) {
        throw new Error('external_idp_route_removal_status_account_mismatch');
      }
      const tenantPii = ensureDatabaseAdapter(
        context.piiDb,
        'external-idp-route-removal-status-pii'
      );
      const operation = await tenantPii.queryOne<{
        account_id: string;
        user_id: string;
        state: string;
      }>(
        `SELECT account_id, user_id, state FROM external_identifier_unlink_operations
          WHERE operation_id = ?`,
        [validated.operationId],
        { consistencyClass: 'primary_required' }
      );
      if (!operation) throw new Error('external_idp_route_removal_status_not_found');
      if (
        operation.account_id !== validated.accountId ||
        operation.user_id !== validated.userId ||
        !['pending', 'directory_pending', 'completed', 'blocked'].includes(operation.state)
      ) {
        throw new Error('external_idp_route_removal_status_conflict');
      }
      if (operation.state === 'blocked') {
        throw new Error('external_idp_route_removal_status_blocked');
      }
      return {
        status: operation.state === 'completed' ? 201 : 202,
        operationId: validated.operationId,
        accountId: validated.accountId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(external_idp_(account_provisioning_rpc_caller_unauthorized|route_removal_status_(input_invalid|account_mismatch|not_found|conflict|blocked)))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('external_idp_route_removal_status_internal_error');
    }
  }

  async removeExternalIdpRoute(input: unknown): Promise<ExternalIdpRouteRemovalResult> {
    try {
      authorizedExternalIdp(this.ctx.props, this.env);
      const validated = validateExternalIdpRouteRemovalInput(input);
      const context = await resolveAccountDataContext(this.env, {
        tenantId: validated.tenantId,
        accountId: validated.accountId,
      });
      if (context.accountId !== validated.accountId || context.legacyUserId !== validated.userId) {
        throw new Error('external_idp_route_removal_account_mismatch');
      }
      const tenantPii = ensureDatabaseAdapter(context.piiDb, 'external-idp-route-removal-pii');
      const [issuerDigest, subjectDigest] = await Promise.all([
        sha256Hex(validated.providerId),
        sha256Hex(validated.providerUserId),
      ]);
      const routeProjectionJson = JSON.stringify(context.membership.routeProjection);
      const existing = await tenantPii.queryOne<{
        operation_id: string;
        account_id: string;
        user_id: string;
        issuer_sha256: string;
        subject_sha256: string;
        route_projection_json: string;
        state: string;
      }>(
        `SELECT operation_id, account_id, user_id, issuer_sha256, subject_sha256,
                route_projection_json, state
           FROM external_identifier_unlink_operations WHERE operation_id = ?`,
        [validated.operationId],
        { consistencyClass: 'primary_required' }
      );
      if (
        existing &&
        (existing.account_id !== validated.accountId ||
          existing.user_id !== validated.userId ||
          existing.issuer_sha256 !== issuerDigest ||
          existing.subject_sha256 !== subjectDigest ||
          existing.route_projection_json !== routeProjectionJson ||
          !['pending', 'directory_pending', 'completed'].includes(existing.state))
      ) {
        throw new Error('external_idp_route_removal_operation_conflict');
      }
      if (!existing) {
        const authority = await tenantPii.queryOne<{
          id: string;
          user_id: string;
          provider_id: string;
          provider_user_id: string;
          provisioning_state: string;
        }>(
          `SELECT id, user_id, provider_id, provider_user_id, provisioning_state
             FROM linked_identities
            WHERE id = ? AND tenant_id = ? AND user_id = ?`,
          [validated.linkedIdentityId, validated.tenantId, validated.userId],
          { consistencyClass: 'primary_required' }
        );
        if (
          !authority ||
          authority.id !== validated.linkedIdentityId ||
          authority.user_id !== validated.userId ||
          authority.provider_id !== validated.providerId ||
          authority.provider_user_id !== validated.providerUserId ||
          authority.provisioning_state !== 'active'
        ) {
          throw new Error('external_idp_route_removal_authority_not_found');
        }
        const now = Math.floor(Date.now() / 1000);
        const results = await tenantPii.batch([
          {
            sql: `INSERT INTO external_identifier_unlink_operations (
               operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
               issuer_sha256, subject_sha256, route_projection_json, state,
               attempt_count, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
            params: [
              validated.operationId,
              validated.tenantId,
              validated.accountId,
              validated.userId,
              JSON.stringify(validated.providerId),
              JSON.stringify(validated.providerUserId),
              issuerDigest,
              subjectDigest,
              routeProjectionJson,
              now,
              now,
            ],
          },
          {
            sql: `DELETE FROM linked_identities
                   WHERE id = ? AND tenant_id = ? AND user_id = ?
                     AND provider_id = ? AND provider_user_id = ?
                     AND provisioning_state = 'active'`,
            params: [
              validated.linkedIdentityId,
              validated.tenantId,
              validated.userId,
              validated.providerId,
              validated.providerUserId,
            ],
          },
        ]);
        if (results[0]?.rowsAffected !== 1 || results[1]?.rowsAffected !== 1) {
          throw new Error('external_idp_route_removal_write_conflict');
        }
      }
      const reflected = await tenantPii.queryOne<{
        state: string;
        account_id: string;
        user_id: string;
      }>(
        `SELECT state, account_id, user_id FROM external_identifier_unlink_operations
          WHERE operation_id = ?`,
        [validated.operationId],
        { consistencyClass: 'primary_required' }
      );
      const remaining = await tenantPii.queryOne<{ id: string }>(
        'SELECT id FROM linked_identities WHERE id = ? AND tenant_id = ? AND user_id = ?',
        [validated.linkedIdentityId, validated.tenantId, validated.userId],
        { consistencyClass: 'primary_required' }
      );
      if (
        !reflected ||
        reflected.account_id !== validated.accountId ||
        reflected.user_id !== validated.userId ||
        !['pending', 'directory_pending', 'completed'].includes(reflected.state) ||
        remaining
      ) {
        throw new Error('external_idp_route_removal_reflection_conflict');
      }
      return {
        status: reflected.state === 'completed' ? 201 : 202,
        operationId: validated.operationId,
        accountId: validated.accountId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(external_idp_(account_provisioning_rpc_caller_unauthorized|route_removal_(input_invalid|account_mismatch|operation_conflict|authority_not_found|write_conflict|reflection_conflict)))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('external_idp_route_removal_internal_error');
    }
  }

  async publishExternalIdpRoute(input: unknown): Promise<ExternalIdpRoutePublicationResult> {
    try {
      const environmentId = authorizedExternalIdp(this.ctx.props, this.env);
      const validated = validateExternalIdpRouteInput(input);
      const context = await resolveAccountDataContext(this.env, {
        tenantId: validated.tenantId,
        accountId: validated.accountId,
      });
      if (context.accountId !== validated.accountId || context.legacyUserId !== validated.userId) {
        throw new Error('external_idp_route_account_mismatch');
      }
      const tenantCoreUsers = ensureDatabaseAdapter(
        context.coreDb,
        'external-idp-route-tenant-core-users'
      );
      const tenantPii = ensureDatabaseAdapter(context.piiDb, 'external-idp-route-tenant-pii');
      const identity = await tenantPii.queryOne<{
        id: string;
        user_id: string;
        provider_id: string;
        provider_user_id: string;
        provisioning_state: string;
      }>(
        `SELECT id, user_id, provider_id, provider_user_id, provisioning_state
           FROM linked_identities
          WHERE id = ? AND tenant_id = ? AND user_id = ?`,
        [validated.linkedIdentityId, validated.tenantId, validated.userId],
        { consistencyClass: 'primary_required' }
      );
      if (
        !identity ||
        identity.id !== validated.linkedIdentityId ||
        identity.user_id !== validated.userId ||
        identity.provider_id !== validated.providerId ||
        identity.provider_user_id !== validated.providerUserId ||
        identity.provisioning_state !== 'active'
      ) {
        throw new Error('external_idp_route_authority_not_found');
      }
      const result = await publishAccountExternalSubjectAddition(
        this.env,
        {
          operationId: validated.operationId,
          idempotencyKey: validated.idempotencyKey,
          tenantId: validated.tenantId,
          accountId: validated.accountId,
          externalSubject: {
            issuer: validated.providerId,
            subject: validated.providerUserId,
          },
          routeProjection: context.membership.routeProjection,
        },
        {
          tenantCoreUsers,
          directory: internalDirectoryBinding(
            this.ctx as unknown as { exports?: Partial<ManagementInternalExports> },
            environmentId
          ),
        }
      );
      return {
        status: result.status,
        operationId: result.operationId,
        accountId: result.accountId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(external_idp_(account_provisioning_rpc_caller_unauthorized|route_(input_invalid|account_mismatch|authority_not_found))|account_identifier_addition_[a-z0-9_]+|directory_[a-z0-9_]+)$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('external_idp_route_internal_error');
    }
  }

  async removeAuthAnonymousDeviceRoute(
    input: unknown
  ): Promise<AuthAnonymousDeviceRouteRemovalResult> {
    try {
      const environmentId = authorized(this.ctx.props, this.env);
      const validated = validateAnonymousRouteRemovalInput(input);
      const context = await resolveAccountDataContext(this.env, {
        tenantId: validated.tenantId,
        accountId: validated.accountId,
      });
      if (context.accountId !== validated.accountId || context.legacyUserId !== validated.userId) {
        throw new Error('auth_anonymous_route_removal_account_mismatch');
      }
      const tenantCoreUsers = ensureDatabaseAdapter(
        context.coreDb,
        'auth-anonymous-route-removal-tenant-core-users'
      );
      const device = await tenantCoreUsers.queryOne<{
        id: string;
        user_id: string;
        device_id_hash: string;
        is_active: number | boolean;
      }>(
        `SELECT id, user_id, device_id_hash, is_active FROM anonymous_devices
          WHERE id = ? AND tenant_id = ? AND user_id = ?`,
        [validated.deviceId, validated.tenantId, validated.userId],
        { consistencyClass: 'primary_required' }
      );
      if (
        !device ||
        device.id !== validated.deviceId ||
        device.user_id !== validated.userId ||
        device.device_id_hash !== validated.deviceIdHash ||
        device.is_active === true ||
        device.is_active === 1
      ) {
        throw new Error('auth_anonymous_route_removal_authority_active');
      }
      const result = await publishAccountExternalSubjectRemoval(
        this.env,
        {
          operationId: validated.operationId,
          idempotencyKey: validated.idempotencyKey,
          tenantId: validated.tenantId,
          accountId: validated.accountId,
          externalSubject: anonymousDeviceLookupSubject(validated.deviceIdHash),
          routeProjection: context.membership.routeProjection,
        },
        {
          tenantCoreUsers,
          directory: internalDirectoryBinding(
            this.ctx as unknown as { exports?: Partial<ManagementInternalExports> },
            environmentId
          ),
        }
      );
      return {
        status: result.status,
        operationId: result.operationId,
        accountId: result.accountId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(auth_account_provisioning_rpc_caller_unauthorized|auth_anonymous_route_removal_(input_invalid|account_mismatch|authority_active)|anonymous_device_route_digest_invalid|account_identifier_removal_[a-z0-9_]+|directory_[a-z0-9_]+)$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('auth_anonymous_route_removal_internal_error');
    }
  }

  async publishAuthPasskeyRoute(input: unknown): Promise<AuthPasskeyRoutePublicationResult> {
    try {
      const environmentId = authorized(this.ctx.props, this.env);
      const validated = validatePasskeyRouteInput(input);
      const context = await resolveAccountDataContext(this.env, {
        tenantId: validated.tenantId,
        accountId: validated.accountId,
      });
      if (context.accountId !== validated.accountId || context.legacyUserId !== validated.userId) {
        throw new Error('auth_passkey_route_account_mismatch');
      }
      const tenantCoreUsers = ensureDatabaseAdapter(
        context.coreDb,
        'auth-passkey-route-tenant-core-users'
      );
      const passkey = await tenantCoreUsers.queryOne<{
        id: string;
        user_id: string;
        credential_id: string;
        rp_id: string | null;
      }>(
        `SELECT id, user_id, credential_id, rp_id FROM passkeys
          WHERE id = ? AND tenant_id = ? AND user_id = ?`,
        [validated.passkeyId, validated.tenantId, validated.userId]
      );
      if (
        !passkey ||
        passkey.id !== validated.passkeyId ||
        passkey.user_id !== validated.userId ||
        passkey.credential_id !== validated.credentialId ||
        !passkey.rp_id ||
        passkeyCredentialLookupSubject({
          rpId: passkey.rp_id,
          credentialId: passkey.credential_id,
        }).issuer !==
          passkeyCredentialLookupSubject({
            rpId: validated.rpId,
            credentialId: validated.credentialId,
          }).issuer
      ) {
        throw new Error('auth_passkey_route_authority_not_found');
      }
      const result = await publishAccountExternalSubjectAddition(
        this.env,
        {
          operationId: validated.operationId,
          idempotencyKey: validated.idempotencyKey,
          tenantId: validated.tenantId,
          accountId: validated.accountId,
          externalSubject: passkeyCredentialLookupSubject({
            rpId: validated.rpId,
            credentialId: validated.credentialId,
          }),
          routeProjection: context.membership.routeProjection,
        },
        {
          tenantCoreUsers,
          directory: internalDirectoryBinding(
            this.ctx as unknown as { exports?: Partial<ManagementInternalExports> },
            environmentId
          ),
        }
      );
      return {
        status: result.status,
        operationId: result.operationId,
        accountId: result.accountId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(auth_account_provisioning_rpc_caller_unauthorized|auth_passkey_route_(input_invalid|account_mismatch|authority_not_found)|passkey_route_[a-z0-9_]+|account_identifier_addition_[a-z0-9_]+|directory_[a-z0-9_]+)$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('auth_passkey_route_internal_error');
    }
  }

  async publishAuthDirectoryRoute(input: unknown): Promise<AuthDirectoryRoutePublicationResult> {
    try {
      const environmentId = authorized(this.ctx.props, this.env);
      const validated = validateDirectoryRouteInput(input);
      const context = await resolveAccountDataContext(this.env, {
        tenantId: validated.tenantId,
        accountId: validated.accountId,
      });
      if (context.accountId !== validated.accountId || context.legacyUserId !== validated.userId) {
        throw new Error('auth_directory_route_account_mismatch');
      }
      const tenantCoreUsers = ensureDatabaseAdapter(
        context.coreDb,
        'auth-directory-route-tenant-core-users'
      );
      const authority = await tenantCoreUsers.queryOne<{ user_id: string }>(
        `SELECT user_id FROM directory_identity_links
          WHERE tenant_id = ? AND connector_id = ? AND directory_subject = ?`,
        [validated.tenantId, validated.connectorId, validated.directorySubject],
        { consistencyClass: 'primary_required' }
      );
      if (authority?.user_id !== validated.userId) {
        throw new Error('auth_directory_route_authority_not_found');
      }
      const result = await publishAccountExternalSubjectAddition(
        this.env,
        {
          operationId: validated.operationId,
          idempotencyKey: validated.idempotencyKey,
          tenantId: validated.tenantId,
          accountId: validated.accountId,
          externalSubject: directoryIdentityLookupSubject({
            connectorId: validated.connectorId,
            directorySubject: validated.directorySubject,
          }),
          routeProjection: context.membership.routeProjection,
        },
        {
          tenantCoreUsers,
          directory: internalDirectoryBinding(
            this.ctx as unknown as { exports?: Partial<ManagementInternalExports> },
            environmentId
          ),
        }
      );
      return {
        status: result.status,
        operationId: result.operationId,
        accountId: result.accountId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(auth_account_provisioning_rpc_caller_unauthorized|auth_directory_route_(input_invalid|account_mismatch|authority_not_found)|directory_route_[a-z0-9_]+|account_identifier_addition_[a-z0-9_]+|directory_[a-z0-9_]+)$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('auth_directory_route_internal_error');
    }
  }

  async getAuthAccountProvisioningStatus(
    input: unknown
  ): Promise<AuthAccountProvisioningStatusResult> {
    try {
      authorized(this.ctx.props, this.env);
      const validated = validateStatusInput(input);
      const operationAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
        this.env,
        'auth-account-provisioning-status',
        { tenantId: validated.tenantId }
      );
      const operation = await new AccountCreationOperationRepository(operationAdapter).findForActor(
        {
          tenantId: validated.tenantId,
          actorId: `auth:${validated.flow}`,
          operationId: validated.operationId,
        }
      );
      if (!operation) throw new Error('auth_account_provisioning_status_not_found');
      return {
        status:
          operation.status === 'succeeded'
            ? 'ready'
            : operation.status === 'blocked' || operation.status === 'canceled'
              ? 'failed'
              : 'pending',
        operationId: operation.operationId,
        accountId: operation.accountId,
        userId: operation.userId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(auth_account_provisioning_(rpc_caller_unauthorized|status_input_invalid|status_not_found))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('auth_account_provisioning_internal_error');
    }
  }

  async provisionAuthAccount(input: unknown): Promise<AuthAccountProvisioningResult> {
    try {
      const environmentId = authorized(this.ctx.props, this.env);
      const validated = validateInput(input);
      if (validated.externalIdentity !== undefined && validated.externalIdentity !== null) {
        throw new Error('auth_account_provisioning_input_invalid');
      }
      return await provisionValidatedAccount(
        this.env,
        this.ctx as unknown as { exports?: Partial<ManagementInternalExports> },
        environmentId,
        validated
      );
    } catch (error) {
      logProvisioningFailure(error);
      if (
        error instanceof Error &&
        /^(auth_account_provisioning_(rpc_caller_unauthorized|input_invalid|input_too_large|runtime_user_invalid|directory_unavailable)|account_creation_operation_(blocked|canceled))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('auth_account_provisioning_internal_error');
    }
  }

  async provisionExternalIdpAccount(input: unknown): Promise<AuthAccountProvisioningResult> {
    try {
      const environmentId = authorizedExternalIdp(this.ctx.props, this.env);
      const validated = validateInput(input);
      if (validated.flow !== 'external_idp' || !validated.externalIdentity) {
        throw new Error('external_idp_account_provisioning_input_invalid');
      }
      return await provisionValidatedAccount(
        this.env,
        this.ctx as unknown as { exports?: Partial<ManagementInternalExports> },
        environmentId,
        validated
      );
    } catch (error) {
      // Keep external-IdP JIT failures diagnosable without exposing request payloads or secrets.
      // The public RPC error remains intentionally generic below.
      logProvisioningFailure(error);
      if (
        error instanceof Error &&
        /^(external_idp_account_provisioning_(rpc_caller_unauthorized|input_invalid)|auth_account_provisioning_(input_invalid|input_too_large|runtime_user_invalid|directory_unavailable)|account_creation_operation_(blocked|canceled)|external_idp_identity_authority_conflict)$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('external_idp_account_provisioning_internal_error');
    }
  }

  async getExternalIdpAccountProvisioningStatus(
    input: unknown
  ): Promise<AuthAccountProvisioningStatusResult> {
    try {
      authorizedExternalIdp(this.ctx.props, this.env);
      const validated = validateStatusInput(input);
      if (validated.flow !== 'external_idp') {
        throw new Error('external_idp_account_provisioning_status_input_invalid');
      }
      const operationAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
        this.env,
        'external-idp-account-provisioning-status',
        { tenantId: validated.tenantId }
      );
      const operation = await new AccountCreationOperationRepository(operationAdapter).findForActor(
        {
          tenantId: validated.tenantId,
          actorId: 'auth:external_idp',
          operationId: validated.operationId,
        }
      );
      if (!operation) throw new Error('external_idp_account_provisioning_status_not_found');
      return {
        status:
          operation.status === 'succeeded'
            ? 'ready'
            : operation.status === 'blocked' || operation.status === 'canceled'
              ? 'failed'
              : 'pending',
        operationId: operation.operationId,
        accountId: operation.accountId,
        userId: operation.userId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(external_idp_account_provisioning_(rpc_caller_unauthorized|status_input_invalid|status_not_found))$/u.test(
          error.message
        )
      ) {
        throw new Error(error.message);
      }
      throw new Error('external_idp_account_provisioning_internal_error');
    }
  }
}
